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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-failover-tiers-'));

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
const { trySelectPoolProvider } = await import('../src/container-runner.js');
const { providerPool } = await import('../src/provider-pool.js');

const PRIMARY = 'claude-fable-5';
const FALLBACK = 'claude-opus-5';
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
        anthropicModel: PRIMARY,
        enabled: true,
      }).id,
    );
  }
  runtimeConfig.saveSystemSettings({ fallbackModel: FALLBACK });
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

/**
 * Failover is "stay on this account until it can no longer serve us". A model
 * wall means exactly that: the bound account cannot serve this turn's tier.
 * The sticky fast-path reads account health only, so without a tier check it
 * hands the turn straight back to the walled pair, forever.
 */
describe('failover sticky binding vs. per-model tier walls', () => {
  test('a walled primary tier moves the bound session to the next account', () => {
    db.setSessionProviderId('failover-model-wall', null, created[0]);
    providerPool.reportModelFailure(created[0], PRIMARY);

    const result = trySelectPoolProvider('failover-model-wall', null, null);
    expect(result).not.toBeNull();
    expect(result!.profileId).not.toBe(created[0]);
    expect(result!.resetSession).toBe(true);
  });

  test('a fully walled primary tier escalates the bound session to the fallback model', () => {
    db.setSessionProviderId('failover-tier-drained', null, created[0]);
    for (const id of created) providerPool.reportModelFailure(id, PRIMARY);

    const result = trySelectPoolProvider('failover-tier-drained', null, null);
    expect(result).not.toBeNull();
    expect(result!.modelOverride).toBe(FALLBACK);
  });

  test('a healthy bound account on a healthy tier still stays sticky', () => {
    db.setSessionProviderId('failover-sticky-ok', null, created[1]);

    const result = trySelectPoolProvider('failover-sticky-ok', null, null);
    expect(result?.profileId).toBe(created[1]);
    expect(result?.resetSession ?? false).toBe(false);
  });
});
