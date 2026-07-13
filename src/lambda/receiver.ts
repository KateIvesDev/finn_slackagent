/**
 * The "front door" Lambda, behind API Gateway (HTTP API). Verifies the
 * request is really from Slack, acks fast, and hands the actual work off to
 * the worker Lambda — see the WorkTask doc comment in src/slack/types.ts for
 * why this split exists (Lambda can freeze/reclaim the execution environment
 * the instant this function's HTTP response is sent; a long-lived process
 * doesn't have that constraint, which is why Socket Mode's app.ts doesn't
 * need this split and just calls runTask inline).
 *
 * Deployed by Terraform (infra/lambda.tf) as `slackagent-receiver`.
 */
import bolt from '@slack/bolt';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { loadConfig, requireConfig } from '../config/index.js';
import { registerListeners } from '../slack/listeners.js';
import { registerFinnAgent } from '../slack/assistant.js';
import type { WorkTask } from '../slack/types.js';

const { App, AwsLambdaReceiver } = bolt;

requireConfig(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
const cfg = loadConfig();

const workerFunctionName = process.env.WORKER_FUNCTION_NAME;
if (!workerFunctionName) {
  throw new Error('WORKER_FUNCTION_NAME is not set — the receiver has nowhere to hand work off to.');
}

const lambda = new LambdaClient({});

// signatureVerification uses SLACK_SIGNING_SECRET to confirm requests really
// came from Slack — requireConfig above guarantees it's set.
const awsLambdaReceiver = new AwsLambdaReceiver({ signingSecret: cfg.SLACK_SIGNING_SECRET as string });

const app = new App({
  token: cfg.SLACK_BOT_TOKEN,
  receiver: awsLambdaReceiver,
});

/** Fire-and-forget async invoke of the worker Lambda. Returning from this
 *  function only means "the invoke request was accepted", not "the task
 *  finished" — by design, since this function's own execution ends the
 *  moment the HTTP response goes back to API Gateway/Slack. */
async function dispatch(task: WorkTask): Promise<void> {
  await lambda.send(
    new InvokeCommand({
      FunctionName: workerFunctionName,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify(task)),
    }),
  );
}

registerListeners(app, dispatch);
registerFinnAgent(app, dispatch);

export const handler = await awsLambdaReceiver.start();
