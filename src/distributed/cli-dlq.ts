#!/usr/bin/env node
/**
 * DLQ inspection/replay CLI.
 *
 *   node --import tsx src/distributed/cli-dlq.ts list
 *   node --import tsx src/distributed/cli-dlq.ts replay <n>
 *
 * `scripts/dist-dlq.mjs` is a thin wrapper so `npm run dist:dlq` works with
 * plain node while the logic stays in TypeScript and is covered by tests.
 */
import { loadDistributedConfig } from './config.js';
import { closeDlq, dlqDepth, openDlq, replayDlq } from './dlq.js';

const [, , command, argument] = process.argv;

async function main(): Promise<void> {
  if (command !== 'list' && command !== 'replay') {
    process.stderr.write('usage: dist:dlq list | dist:dlq replay <count>\n');
    process.exitCode = 2;
    return;
  }
  const config = loadDistributedConfig();
  const handle = await openDlq(config.amqpUrl);
  try {
    if (command === 'list') {
      process.stdout.write(
        JSON.stringify({
          event: 'dlq_list',
          queue: handle.topology.deadLetterQueue,
          messages: await dlqDepth(handle),
        }) + '\n',
      );
      return;
    }
    const count = Number(argument ?? 1);
    if (!Number.isSafeInteger(count) || count < 1) {
      process.stderr.write('replay: <count> must be a positive integer\n');
      process.exitCode = 2;
      return;
    }
    const result = await replayDlq(handle, count);
    process.stdout.write(
      JSON.stringify({
        event: 'dlq_replay',
        queue: handle.topology.deadLetterQueue,
        replayed: result.replayed,
        runIds: result.runIds,
      }) + '\n',
    );
  } finally {
    await closeDlq(handle);
  }
}

main().catch((error) => {
  process.stderr.write(
    JSON.stringify({
      event: 'dlq_failed',
      error: error instanceof Error ? error.message.slice(0, 300) : 'unknown',
    }) + '\n',
  );
  process.exitCode = 1;
});
