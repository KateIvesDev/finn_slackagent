/**
 * A queryable, structured mirror of what recordVerdict (finnledger.ts) writes
 * to the Canvas. The Canvas is the human-facing durable record and has no
 * clean "read it back" API (canvases.* only creates/edits/deletes); rather
 * than round-trip through parsing rendered markdown, decisions are recorded
 * here too — same moment, same data — so a chat prompt like "what's been
 * decided recently?" can just query structured entries directly.
 *
 * Two implementations, same split as VerdictStore:
 *   - InMemoryDecisionLog — a plain array. Fine in Socket Mode's one long-lived
 *     process.
 *   - DynamoDecisionLog — required on Lambda, where the invocation that RECORDS
 *     a decision and the one that SERVES "what's been decided?" are separate
 *     processes with no shared memory. Keyed (channel HASH, at RANGE) so a
 *     channel's recent decisions are one Query.
 */
import {
  DynamoDBClient,
  type DynamoDBClientConfig,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { LedgerEntry } from './finnledger.js';

export interface DecisionLogEntry extends LedgerEntry {
  channel: string;
}

export interface DecisionLog {
  record(entry: DecisionLogEntry): Promise<void>;
  /** Entries for `channel` from the last `sinceMs` milliseconds, oldest first. */
  listRecent(channel: string, sinceMs: number): Promise<DecisionLogEntry[]>;
}

export class InMemoryDecisionLog implements DecisionLog {
  private entries: DecisionLogEntry[] = [];

  async record(entry: DecisionLogEntry): Promise<void> {
    this.entries.push(entry);
  }

  async listRecent(channel: string, sinceMs: number): Promise<DecisionLogEntry[]> {
    const cutoff = Date.now() - sinceMs;
    return this.entries
      .filter((e) => e.channel === channel && (e.at ?? new Date()).getTime() >= cutoff)
      .sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
  }
}

// ---------------------------------------------------------------------------
// DynamoDB — Lambda (record + summary run in separate invocations).
// ---------------------------------------------------------------------------
const DEFAULT_TABLE_NAME = process.env.DECISION_TABLE_NAME ?? 'slackagent-decisions';
const TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days — matches the summary's lookback window

export class DynamoDecisionLog implements DecisionLog {
  private doc: DynamoDBDocumentClient;
  private tableName: string;

  constructor(tableName: string = DEFAULT_TABLE_NAME, config?: DynamoDBClientConfig) {
    this.tableName = tableName;
    // Entries carry optional fields (threadPermalink, feedback.user) — strip
    // undefined so the DocumentClient doesn't throw. `at` (a Date) is converted
    // to epoch ms below, never marshalled directly.
    this.doc = DynamoDBDocumentClient.from(new DynamoDBClient(config ?? {}), {
      marshallOptions: { removeUndefinedValues: true },
    });
  }

  async record(entry: DecisionLogEntry): Promise<void> {
    const { at, ...rest } = entry;
    const atMs = (at ?? new Date()).getTime();
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        // `at` is the numeric RANGE key (epoch ms); rest carries verdict,
        // decision, decidedBy, feedbackSummary, channel (the HASH key).
        Item: { ...rest, at: atMs, ttl: Math.floor(Date.now() / 1000) + TTL_SECONDS },
      }),
    );
  }

  async listRecent(channel: string, sinceMs: number): Promise<DecisionLogEntry[]> {
    const cutoff = Date.now() - sinceMs;
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        // `at` and `channel` aliased — both can collide with DynamoDB reserved words.
        KeyConditionExpression: '#ch = :c AND #at >= :cut',
        ExpressionAttributeNames: { '#ch': 'channel', '#at': 'at' },
        ExpressionAttributeValues: { ':c': channel, ':cut': cutoff },
        ScanIndexForward: true, // oldest first, matching InMemory
      }),
    );
    return (res.Items ?? []).map((item) => {
      const { at, ttl: _ttl, ...rest } = item as Record<string, unknown>;
      // Rebuild the Date the rest of the code expects from the stored epoch ms.
      return { ...rest, at: new Date(Number(at)) } as DecisionLogEntry;
    });
  }
}
