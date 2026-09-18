import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/container-runner.js', () => ({ killProcessTree: () => {} }));

vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    maxConcurrentContainers: 1,
    // Deliberately smaller than the number of host sessions in the test. The
    // legacy setting remains readable for old config files but must not govern
    // host admission anymore.
    maxConcurrentHostProcesses: 1,
  }),
}));

vi.mock('../src/db.js', () => ({ getTaskById: () => undefined }));

const { GroupQueue } = await import('../src/group-queue.js');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const queues: InstanceType<typeof GroupQueue>[] = [];
const releases: Array<() => void> = [];

function createQueue(host = true): InstanceType<typeof GroupQueue> {
  const queue = new GroupQueue();
  queue.setHostModeChecker(() => host);
  queues.push(queue);
  return queue;
}

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await tick();
  await tick();
  queues.splice(0);
});

describe('GroupQueue host-mode session concurrency', () => {
  test('different Feishu topic sessions start immediately without a global host slot pool', async () => {
    const queue = createQueue();
    // Billing capacity is a Docker allocation concern and must not turn into a
    // hidden host-process limit either.
    queue.setUserConcurrentLimitChecker(() => ({ allowed: false }));

    const first = deferred();
    const second = deferred();
    releases.push(first.resolve, second.resolve);
    const started: string[] = [];

    expect(
      queue.enqueueTask(
        'web:workspace#agent:feishu-topic-a',
        'topic-a-turn',
        async () => {
          started.push('topic-a');
          await first.promise;
        },
      ),
    ).toBe(true);
    expect(
      queue.enqueueTask(
        'web:workspace#agent:feishu-topic-b',
        'topic-b-turn',
        async () => {
          started.push('topic-b');
          await second.promise;
        },
      ),
    ).toBe(true);

    await tick();
    expect(started.sort()).toEqual(['topic-a', 'topic-b']);
    expect(queue.getStatus().activeHostProcessCount).toBe(2);
    expect(queue.getStatus().waitingCount).toBe(0);
  });

  test('the same session remains strictly serialized', async () => {
    const queue = createQueue();
    const first = deferred();
    releases.push(first.resolve);
    const order: string[] = [];
    const jid = 'web:workspace#agent:same-feishu-topic';

    queue.enqueueTask(jid, 'first-turn', async () => {
      order.push('first:start');
      await first.promise;
      order.push('first:end');
    });
    queue.enqueueTask(jid, 'second-turn', async () => {
      order.push('second');
    });

    await tick();
    expect(order).toEqual(['first:start']);
    expect(queue.getStatus().activeHostProcessCount).toBe(1);

    first.resolve();
    await tick();
    await tick();
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  test('Docker mode still honors its explicit capacity limit', async () => {
    const queue = createQueue(false);
    const first = deferred();
    releases.push(first.resolve);
    const started: string[] = [];

    queue.enqueueTask('web:container-a', 'container-a', async () => {
      started.push('container-a');
      await first.promise;
    });
    queue.enqueueTask('web:container-b', 'container-b', async () => {
      started.push('container-b');
    });

    await tick();
    expect(started).toEqual(['container-a']);
    expect(queue.getStatus().activeContainerCount).toBe(1);
    expect(queue.getStatus().waitingCount).toBe(1);

    first.resolve();
    await tick();
    await tick();
    expect(started).toEqual(['container-a', 'container-b']);
  });
});
