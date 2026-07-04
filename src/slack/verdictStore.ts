/**
 * Where Finn stashes a verdict between posting the card and the human
 * clicking Approve/Reject, so the button handler can recover context.
 *
 * Two implementations, same interface:
 *   - InMemoryVerdictStore — a plain Map. Fine in Socket Mode, where one
 *     long-lived process holds everything in memory.
 *   - DynamoVerdictStore — required once this runs as separate Lambda
 *     invocations (receiver vs worker, or even two different invocations of
 *     the same function): there is no shared memory between them, so the
 *     verdict has to live somewhere durable both can reach.
 */
import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Feedback } from '../types/index.js';
import type { Verdict } from './types.js';

export interface VerdictCacheEntry {
  verdict: Verdict;
  feedback: Feedback;
  verdictMessageTs: string;
}

export interface VerdictStore {
  get(feedbackId: string): Promise<VerdictCacheEntry | undefined>;
  set(feedbackId: string, entry: VerdictCacheEntry): Promise<void>;
  /** Not required for correctness (TTL cleans up eventually) but tidy to have. */
  delete(feedbackId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory — Socket Mode / local dev.
// ---------------------------------------------------------------------------
export class InMemoryVerdictStore implements VerdictStore {
  private cache = new Map<string, VerdictCacheEntry>();

  async get(feedbackId: string): Promise<VerdictCacheEntry | undefined> {
    return this.cache.get(feedbackId);
  }

  async set(feedbackId: string, entry: VerdictCacheEntry): Promise<void> {
    this.cache.set(feedbackId, entry);
  }

  async delete(feedbackId: string): Promise<void> {
    this.cache.delete(feedbackId);
  }
}

// ---------------------------------------------------------------------------
// DynamoDB — Lambda (receiver + worker are separate invocations/processes).
// ---------------------------------------------------------------------------
const DEFAULT_TABLE_NAME = process.env.VERDICT_TABLE_NAME ?? 'slackagent-verdicts';
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days — plenty for a demo window

export class DynamoVerdictStore implements VerdictStore {
  private doc: DynamoDBDocumentClient;
  private tableName: string;

  constructor(tableName: string = DEFAULT_TABLE_NAME, config?: DynamoDBClientConfig) {
    this.tableName = tableName;
    // Feedback.user is `string | undefined` — the DocumentClient otherwise
    // throws ("Pass options.removeUndefinedValues=true...") rather than
    // silently dropping the key, unlike a plain JSON.stringify would.
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient(config ?? {}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async get(feedbackId: string): Promise<VerdictCacheEntry | undefined> {
    const res = await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { feedbackId } }),
    );
    if (!res.Item) return undefined;
    const { verdict, feedback, verdictMessageTs } = res.Item as Record<string, unknown>;
    return {
      verdict: verdict as Verdict,
      feedback: feedback as Feedback,
      verdictMessageTs: verdictMessageTs as string,
    };
  }

  async set(feedbackId: string, entry: VerdictCacheEntry): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          feedbackId,
          ...entry,
          ttl: Math.floor(Date.now() / 1000) + TTL_SECONDS,
        },
      }),
    );
  }

  async delete(feedbackId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.tableName, Key: { feedbackId } }),
    );
  }
}
