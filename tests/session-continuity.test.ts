import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-continuity-'));
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const continuity = await import('../src/session-continuity.js');
type Profile = Parameters<
  typeof continuity.planAgentProfileSessionContinuity
>[1];

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const profile = {
  id: 'agent-1',
  name: 'Shop <Bot>',
  version: 3,
  identity_hash: 'hash-b',
} as unknown as NonNullable<Profile>;

describe('planAgentProfileSessionContinuity', () => {
  test('unchanged when identity, version and profile match', () => {
    expect(
      continuity.planAgentProfileSessionContinuity(
        {
          agent_profile_id: 'agent-1',
          agent_profile_version: 3,
          identity_hash: 'hash-b',
        },
        profile,
      ),
    ).toEqual({ kind: 'unchanged' });
  });

  test('a model-only version bump refreshes without dropping the session', () => {
    expect(
      continuity.planAgentProfileSessionContinuity(
        {
          agent_profile_id: 'agent-1',
          agent_profile_version: 2,
          identity_hash: 'hash-b',
        },
        profile,
      ),
    ).toEqual({ kind: 'refresh', profileSwitched: false });
  });

  test('switching the workspace to another profile is flagged', () => {
    expect(
      continuity.planAgentProfileSessionContinuity(
        {
          agent_profile_id: 'agent-0',
          agent_profile_version: 3,
          identity_hash: 'hash-a',
        },
        profile,
      ),
    ).toEqual({ kind: 'refresh', profileSwitched: true });
  });

  test('legacy sessions without identity are left alone', () => {
    expect(
      continuity.planAgentProfileSessionContinuity(
        {
          agent_profile_id: null,
          agent_profile_version: null,
          identity_hash: null,
        },
        profile,
      ),
    ).toEqual({ kind: 'unchanged' });
  });

  test('refresh notice escapes the profile name', () => {
    const notice = continuity.buildAgentProfileRefreshNotice(profile, {
      kind: 'refresh',
      profileSwitched: false,
    });
    expect(notice).toContain('Shop &lt;Bot&gt;');
    expect(notice).toContain('版本 3');
  });
});

describe('canResumeAcrossProviders', () => {
  const a = { id: 'a', anthropicBaseUrl: '', anthropicModel: 'claude-x' };
  const b = { id: 'b', anthropicBaseUrl: '', anthropicModel: 'claude-x' };
  const file = path.join(root, 'matrix.json');
  const passing = {
    resumed: true,
    recalledToolResult: true,
    toolCallAfterResume: true,
    streamed: true,
  };

  test('same provider always resumes; unknown pairs never do', () => {
    expect(continuity.canResumeAcrossProviders(a, a, file)).toBe(true);
    expect(continuity.canResumeAcrossProviders(a, b, file)).toBe(false);
  });

  test('a verified pair resumes in the verified direction only', () => {
    continuity.writeResumeMatrixEntries(
      [
        {
          fromFingerprint: continuity.providerContinuityFingerprint(a),
          toFingerprint: continuity.providerContinuityFingerprint(b),
          fromName: 'A',
          toName: 'B',
          checks: passing,
          resume: continuity.resumeChecksPass(passing),
          checkedAt: new Date().toISOString(),
        },
      ],
      file,
    );
    expect(continuity.canResumeAcrossProviders(a, b, file)).toBe(true);
    expect(continuity.canResumeAcrossProviders(b, a, file)).toBe(false);
  });

  test('editing the model voids the earlier verification', () => {
    expect(
      continuity.canResumeAcrossProviders(
        a,
        { ...b, anthropicModel: 'claude-y' },
        file,
      ),
    ).toBe(false);
  });

  test('any failing behavior check fails the pair', () => {
    expect(
      continuity.resumeChecksPass({ ...passing, recalledToolResult: false }),
    ).toBe(false);
  });
});

describe('summarizeProviderContinuity', () => {
  const a = { id: 'a', anthropicBaseUrl: '', anthropicModel: 'claude-x' };
  const b = { id: 'b', anthropicBaseUrl: '', anthropicModel: 'claude-x' };
  const c = { id: 'c', anthropicBaseUrl: '', anthropicModel: 'claude-x' };
  const file = path.join(root, 'catalog-matrix.json');
  const passing = {
    resumed: true,
    recalledToolResult: true,
    toolCallAfterResume: true,
    streamed: true,
  };
  const entry = (
    from: typeof a,
    to: typeof a,
    resume: boolean,
    checkedAt = '2026-11-01T00:00:00.000Z',
  ) => ({
    fromFingerprint: continuity.providerContinuityFingerprint(from),
    toFingerprint: continuity.providerContinuityFingerprint(to),
    fromName: from.id,
    toName: to.id,
    checks: resume ? passing : { ...passing, resumed: false },
    resume,
    checkedAt,
  });

  test('a provider without a baseline entry is unverified', () => {
    expect(continuity.summarizeProviderContinuity(a, [a, b], file)).toEqual({
      status: 'unverified',
      checkedAt: null,
      bidirectionalProviderIds: [],
    });
  });

  test('a passing baseline is verified and keeps its check time', () => {
    const verifiedFile = path.join(root, 'catalog-verified.json');
    continuity.writeResumeMatrixEntries([entry(a, a, true)], verifiedFile);
    expect(
      continuity.summarizeProviderContinuity(a, [a, b], verifiedFile),
    ).toEqual({
      status: 'verified',
      checkedAt: '2026-11-01T00:00:00.000Z',
      bidirectionalProviderIds: [],
    });
  });

  test('a failing baseline is failed even when cross pairs exist', () => {
    const failedFile = path.join(root, 'catalog-failed.json');
    continuity.writeResumeMatrixEntries(
      [entry(a, a, false), entry(a, b, true), entry(b, a, true)],
      failedFile,
    );
    expect(
      continuity.summarizeProviderContinuity(a, [a, b], failedFile),
    ).toMatchObject({
      status: 'failed',
      bidirectionalProviderIds: ['b'],
    });
  });

  test('only providers sharing both directions count as bidirectional', () => {
    const pairFile = path.join(root, 'catalog-pairs.json');
    continuity.writeResumeMatrixEntries(
      [
        entry(a, a, true),
        entry(a, b, true),
        entry(b, a, true),
        entry(a, c, true),
        entry(c, a, false),
      ],
      pairFile,
    );
    expect(
      continuity.summarizeProviderContinuity(a, [a, b, c], pairFile)
        .bidirectionalProviderIds,
    ).toEqual(['b']);
  });

  test('editing the model voids the baseline', () => {
    const staleFile = path.join(root, 'catalog-stale.json');
    continuity.writeResumeMatrixEntries([entry(a, a, true)], staleFile);
    expect(
      continuity.summarizeProviderContinuity(
        { ...a, anthropicModel: 'claude-y' },
        [],
        staleFile,
      ).status,
    ).toBe('unverified');
  });
});
