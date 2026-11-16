import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

// Provider switches keep the SDK session: instead of deleting it, the host asks
// the runner to resume a copy of the transcript with the thinking blocks
// removed (their signatures only validate on the upstream that produced them).
// These tests pin down both halves of that decision: the pool result that flags
// a cross-provider move, and the pure mapping into ContainerInput.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-switch-strip-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const db = await import('../src/db.js');
const { resolveSessionResumeMode, trySelectPoolProvider } =
  await import('../src/container-runner.js');
const { providerPool } = await import('../src/provider-pool.js');
const continuity = await import('../src/session-continuity.js');

const created: string[] = [];

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups'), { recursive: true });
  db.initDatabase();
  for (const name of ['Account A', 'Account B', 'Account C']) {
    created.push(
      runtimeConfig.createProvider({
        name,
        type: 'official',
        anthropicApiKey: `${name.replace(/\s+/g, '-').toLowerCase()}-key`,
        anthropicModel: 'claude-fable-5',
        enabled: true,
      }).id,
    );
  }
  runtimeConfig.saveBalancingConfig({
    strategy: 'failover',
    unhealthyThreshold: 1,
    recoveryIntervalMs: 300_000,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  for (const id of created) providerPool.resetHealth(id);
});

describe('resolveSessionResumeMode', () => {
  test('plain resume without a session id or an invalidation', () => {
    expect(resolveSessionResumeMode({ sessionId: undefined })).toBeUndefined();
    expect(
      resolveSessionResumeMode({
        sessionId: 'sdk-1',
        stripSessionThinking: false,
        durableStripMarker: false,
      }),
    ).toBeUndefined();
  });

  test('a cross-provider pool selection strips thinking', () => {
    expect(
      resolveSessionResumeMode({
        sessionId: 'sdk-1',
        stripSessionThinking: true,
      }),
    ).toBe('strip_thinking');
  });

  test('a durable config-change marker strips thinking', () => {
    expect(
      resolveSessionResumeMode({
        sessionId: 'sdk-1',
        durableStripMarker: true,
      }),
    ).toBe('strip_thinking');
  });

  test('a fresh session is never stripped', () => {
    // Nothing to copy: the runner starts a new transcript anyway.
    expect(
      resolveSessionResumeMode({
        sessionId: null,
        stripSessionThinking: true,
        durableStripMarker: true,
      }),
    ).toBeUndefined();
  });
});

describe('trySelectPoolProvider strip decisions', () => {
  test('moving a bound session to an unverified provider asks for a strip', () => {
    db.setSessionProviderId('strip-pinned-move', null, created[0]);

    const result = trySelectPoolProvider('strip-pinned-move', null, created[1]);

    expect(result?.profileId).toBe(created[1]);
    expect(result?.stripSessionThinking).toBe(true);
    // The session row itself is untouched: the runner resumes a stripped copy.
    expect(db.getSessionProviderId('strip-pinned-move')).toBe(created[1]);
  });

  test('re-selecting the bound provider resumes as-is', () => {
    db.setSessionProviderId('strip-pinned-same', null, created[0]);

    const result = trySelectPoolProvider('strip-pinned-same', null, created[0]);

    expect(result?.stripSessionThinking ?? false).toBe(false);
  });

  test('an unhealthy sticky binding moves the session and strips thinking', () => {
    db.setSessionProviderId('strip-unhealthy', null, created[0]);
    providerPool.reportFailure(created[0], true);

    const result = trySelectPoolProvider('strip-unhealthy', null, null);

    expect(result).not.toBeNull();
    expect(result!.profileId).not.toBe(created[0]);
    expect(result!.stripSessionThinking).toBe(true);
  });

  test('a disabled bound provider moves the session and strips thinking', () => {
    db.setSessionProviderId('strip-disabled', null, created[2]);
    runtimeConfig.setProviderEnabled(created[2], false);
    try {
      const result = trySelectPoolProvider('strip-disabled', null, null);
      expect(result).not.toBeNull();
      expect(result!.profileId).not.toBe(created[2]);
      expect(result!.stripSessionThinking).toBe(true);
    } finally {
      runtimeConfig.setProviderEnabled(created[2], true);
    }
  });

  test('a healthy sticky binding keeps the session without a strip', () => {
    db.setSessionProviderId('strip-sticky', null, created[0]);

    const result = trySelectPoolProvider('strip-sticky', null, null);

    expect(result?.profileId).toBe(created[0]);
    expect(result?.stripSessionThinking ?? false).toBe(false);
  });

  test('rotation across a verified provider pair resumes as-is', () => {
    const providers = runtimeConfig
      .getProviders()
      .filter((provider) => created.includes(provider.id));
    const [a, b] = providers;
    continuity.writeResumeMatrixEntries(
      [
        [a, b],
        [b, a],
      ].map(([from, to]) => ({
        fromFingerprint: continuity.providerContinuityFingerprint(from),
        toFingerprint: continuity.providerContinuityFingerprint(to),
        fromName: from.name,
        toName: to.name,
        checks: {
          resumed: true,
          recalledToolResult: true,
          toolCallAfterResume: true,
          streamed: true,
        },
        resume: true,
        checkedAt: new Date().toISOString(),
      })),
    );
    runtimeConfig.saveBalancingConfig({ strategy: 'round-robin' });
    try {
      db.setSession('strip-verified-rotation', 'sdk-session', null);
      db.setSessionProviderId('strip-verified-rotation', null, a.id);

      for (let i = 0; i < 6; i += 1) {
        const next = trySelectPoolProvider(
          'strip-verified-rotation',
          null,
          null,
        );
        expect(next?.stripSessionThinking ?? false).toBe(false);
      }
    } finally {
      fs.rmSync(continuity.SESSION_CONTINUITY_MATRIX_FILE, { force: true });
      runtimeConfig.saveBalancingConfig({ strategy: 'failover' });
    }
  });
});
