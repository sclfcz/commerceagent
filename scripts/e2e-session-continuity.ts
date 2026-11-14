/**
 * Session continuity end-to-end check (real provider requests, may incur cost).
 *
 * Drives the product's own Host-mode runner chain
 * (`runAgentWithModelFallback(runHostAgent, …)` → container/agent-runner) the
 * same way `src/index.ts` and `src/task-scheduler.ts` do, without the Web
 * service or any IM channel, and checks that a conversation survives:
 *
 *   A. an AgentProfile prompt edit (identity_hash/version bump),
 *   B. a switch to a provider pair verified in the continuity matrix,
 *   C. a switch to an unverified pair (thinking-strip resume).
 *
 * Every run uses a throwaway COMMERCEAGENT_DATA_DIR holding copies (mode 0600)
 * of only the provider config, its key and the continuity matrix. The copy is
 * deleted on exit; the source data directory is never written. Output is
 * scenario names and booleans only: no endpoints, models, credentials or
 * response text.
 *
 * Usage:
 *   npm run e2e:session-continuity
 *   npm run e2e:session-continuity -- --from <providerId> --to <providerId>
 *   npm run e2e:session-continuity -- --only A,C
 *   COMMERCEAGENT_E2E_SOURCE_DATA_DIR=/path/to/data npm run e2e:session-continuity
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const TURN_TIMEOUT_MS = 300_000;
const CONFIG_FILES = [
  'claude-provider.json',
  'claude-provider.key',
  'session-continuity-matrix.json',
];

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function resolveSourceDataDir(): string {
  const explicit = process.env.COMMERCEAGENT_E2E_SOURCE_DATA_DIR;
  if (explicit) return path.resolve(explicit);
  if (process.env.COMMERCEAGENT_DATA_DIR) {
    return path.resolve(process.env.COMMERCEAGENT_DATA_DIR);
  }
  // A git worktree has no data/ of its own; fall back to the main checkout.
  const candidates = [path.join(PROJECT_ROOT, 'data')];
  const worktreeMarker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const markerIndex = PROJECT_ROOT.indexOf(worktreeMarker);
  if (markerIndex > 0) {
    candidates.push(path.join(PROJECT_ROOT.slice(0, markerIndex), 'data'));
  }
  const found = candidates.find((dir) =>
    fs.existsSync(path.join(dir, 'config', 'claude-provider.json')),
  );
  if (!found) {
    throw new Error(
      'No provider config found; set COMMERCEAGENT_E2E_SOURCE_DATA_DIR',
    );
  }
  return found;
}

// ─── Temp data dir must exist before any product module is imported ───
const sourceDataDir = resolveSourceDataDir();
const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-e2e-sc-'));
fs.chmodSync(tempDataDir, 0o700);
fs.mkdirSync(path.join(tempDataDir, 'config'), { mode: 0o700 });
for (const name of CONFIG_FILES) {
  const src = path.join(sourceDataDir, 'config', name);
  if (!fs.existsSync(src)) {
    if (name === 'session-continuity-matrix.json') continue;
    throw new Error(`Missing source config file: ${name}`);
  }
  const dest = path.join(tempDataDir, 'config', name);
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o600);
}
process.env.COMMERCEAGENT_DATA_DIR = tempDataDir;
// Product logs can include provider ids and runner stderr; keep them quiet.
process.env.LOG_LEVEL = process.env.COMMERCEAGENT_E2E_LOG_LEVEL || 'silent';

let cleanedUp = false;
function cleanup(): void {
  if (cleanedUp) return;
  cleanedUp = true;
  fs.rmSync(tempDataDir, { recursive: true, force: true });
}
process.on('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(130);
  });
}

await import('../src/load-env.js');
const db = await import('../src/db.js');
const runner = await import('../src/container-runner.js');
const runtimeConfig = await import('../src/runtime-config.js');
const continuity = await import('../src/session-continuity.js');
const { buildAgentProfilePrompt } =
  await import('../src/agent-profile-prompts.js');
const { resolveEffectiveAgentProfile } =
  await import('../src/agent-profile-runtime.js');
const { formatMessages } = await import('../src/message-prompt.js');
const { DATA_DIR } = await import('../src/config.js');

type AgentProfile = NonNullable<ReturnType<typeof db.getAgentProfile>>;
type ContainerInput = Parameters<typeof runner.runHostAgent>[1];
type RegisteredGroup = Parameters<typeof runner.runHostAgent>[0];

if (path.resolve(DATA_DIR) !== path.resolve(tempDataDir)) {
  throw new Error('DATA_DIR did not resolve to the temporary copy');
}

// ─── Fixture helpers ───

interface Check {
  scenario: string;
  name: string;
  pass: boolean;
}
const checks: Check[] = [];
function check(scenario: string, name: string, pass: boolean): void {
  checks.push({ scenario, name, pass });
  console.log(`[${scenario}] ${name}: ${pass ? 'PASS' : 'FAIL'}`);
}

const ownerId = `e2e-owner-${crypto.randomUUID()}`;
function createOwner(): void {
  const now = new Date().toISOString();
  db.createUser({
    id: ownerId,
    username: `e2e-${crypto.randomBytes(4).toString('hex')}`,
    password_hash: 'x',
    display_name: 'E2E',
    role: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
  });
}

function createWorkspace(
  label: string,
  modelConfigId: string,
): {
  group: RegisteredGroup;
  jid: string;
  profile: AgentProfile;
} {
  const folder = `e2e-sc-${label}-${crypto.randomBytes(3).toString('hex')}`;
  const jid = `web:${folder}`;
  const group: RegisteredGroup = {
    name: folder,
    folder,
    added_at: new Date().toISOString(),
    executionMode: 'host',
    created_by: ownerId,
  };
  db.setRegisteredGroup(jid, group);
  const profile = db.createAgentProfile({
    ownerUserId: ownerId,
    name: `E2E ${label}`,
    identityPrompt: 'You are a concise test assistant. Follow instructions.',
    promptMode: 'append',
    modelConfigId,
  });
  db.assignWorkspaceAgentProfile(folder, profile.id);
  return { group, jid, profile };
}

/** Same projection as `toContainerAgentProfile` in src/index.ts. */
function toRunnerProfile(
  profile: AgentProfile,
): ContainerInput['agentProfile'] {
  const effective = resolveEffectiveAgentProfile(profile)!;
  return {
    id: effective.id,
    name: effective.name,
    version: effective.version,
    isDefault: effective.is_default,
    identityHash: effective.identity_hash,
    identityPrompt: buildAgentProfilePrompt(effective),
    includeClaudePreset: effective.prompt_mode === 'append',
    modelConfigId: effective.model_config_id,
    runtimePolicy: effective.runtime_policy,
  };
}

/** Same notice decision as `agentProfileRefreshNotice` in src/index.ts. */
function refreshNotice(folder: string, profile: AgentProfile): string {
  const plan = continuity.planAgentProfileSessionContinuity(
    db.getSessionAgentIdentity(folder, null),
    profile,
  );
  return plan.kind === 'refresh'
    ? continuity.buildAgentProfileRefreshNotice(profile, plan)
    : '';
}

interface TurnOutcome {
  ok: boolean;
  text: string;
  sessionIdBefore?: string;
  sessionIdAfter?: string;
  prompt: string;
}

async function runTurn(
  workspace: { group: RegisteredGroup; jid: string },
  profileId: string,
  userText: string,
): Promise<TurnOutcome> {
  const { group, jid } = workspace;
  const profile = db.getAgentProfile(profileId)!;
  const sessionIdBefore = db.getSession(group.folder) || undefined;
  const now = new Date().toISOString();
  const prompt =
    refreshNotice(group.folder, profile) +
    formatMessages([
      {
        id: `e2e-${crypto.randomUUID()}`,
        chat_jid: jid,
        sender: ownerId,
        sender_name: 'Tester',
        content: userText,
        timestamp: now,
      },
    ]);

  const ipcInputDir = path.join(DATA_DIR, 'ipc', group.folder, 'input');
  const closeRunner = () => {
    fs.mkdirSync(ipcInputDir, { recursive: true });
    fs.writeFileSync(path.join(ipcInputDir, '_close'), '');
  };
  let text = '';
  let completed = false;
  let failed = false;
  let child: import('node:child_process').ChildProcess | undefined;
  const timer = setTimeout(() => {
    failed = true;
    closeRunner();
    setTimeout(() => child?.kill('SIGKILL'), 10_000).unref();
  }, TURN_TIMEOUT_MS);

  // Mirrors the session bookkeeping of wrappedOnOutput in src/index.ts.
  const onOutput = async (
    output: Awaited<ReturnType<typeof runner.runHostAgent>>,
  ) => {
    if (output.providerFailure || output.status === 'error') failed = true;
    if (
      output.newSessionId &&
      output.status !== 'error' &&
      !output.providerFailure
    ) {
      db.setSession(group.folder, output.newSessionId, undefined, {
        agentProfileId: profile.id,
        agentProfileVersion: profile.version,
        identityHash: profile.identity_hash,
      });
    }
    if (output.status !== 'stream' && output.result) text = output.result;
    if (!output.providerFailure && output.inputTurnCompleted === true) {
      completed = true;
      // A warm runner waits for the next IPC message; this turn is done.
      closeRunner();
    }
  };

  try {
    const output = await runner.runAgentWithModelFallback(
      runner.runHostAgent,
      group,
      {
        prompt,
        sessionId: sessionIdBefore,
        turnId: crypto.randomUUID(),
        groupFolder: group.folder,
        chatJid: jid,
        isMain: false,
        isHome: false,
        isAdminHome: false,
        agentProfile: toRunnerProfile(profile),
      },
      (proc) => {
        child = proc;
      },
      onOutput,
    );
    if (output.status === 'error' || output.providerFailure) failed = true;
    if (output.status !== 'stream' && output.result) text = output.result;
    if (output.inputTurnCompleted === true) completed = true;
  } catch {
    failed = true;
  } finally {
    clearTimeout(timer);
  }
  return {
    ok: completed && !failed,
    text,
    sessionIdBefore,
    sessionIdAfter: db.getSession(group.folder) || undefined,
    prompt,
  };
}

function newFact(): string {
  return `${crypto.randomBytes(3).toString('hex').toUpperCase()}-${crypto.randomInt(1000, 9999)}`;
}

const rememberPrompt = (fact: string) =>
  `Please remember this code word for later: ${fact}. Reply with just "OK".`;
const recallPrompt =
  'What was the code word I asked you to remember earlier? Reply with the code word only.';

function transcriptEntries(
  folder: string,
  sessionId: string,
): Array<{ uuid?: string; type?: string; message?: { content?: unknown } }> {
  const root = path.join(DATA_DIR, 'sessions', folder, '.claude', 'projects');
  if (!fs.existsSync(root)) return [];
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) continue;
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line) => {
        if (!line.trim()) return [];
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }
  return [];
}

/**
 * A thinking-strip copy keeps the original entries (same uuids) in order. A
 * fresh session started by the runner's resume-failure fallback shares none.
 */
function isStrippedCopyOf(
  folder: string,
  originalId: string,
  copyId: string,
): boolean {
  const original = new Set(
    transcriptEntries(folder, originalId)
      .map((entry) => entry.uuid)
      .filter((uuid): uuid is string => !!uuid),
  );
  const copied = transcriptEntries(folder, copyId).filter(
    (entry) => entry.uuid && original.has(entry.uuid),
  );
  return copied.length > 0 && !transcriptHasThinkingIn(copied);
}

function transcriptHasThinkingIn(
  entries: Array<{ type?: string; message?: { content?: unknown } }>,
): boolean {
  return entries.some(
    (entry) =>
      entry.type === 'assistant' &&
      Array.isArray(entry.message?.content) &&
      (entry.message.content as Array<{ type?: string }>).some(
        (block) =>
          block?.type === 'thinking' || block?.type === 'redacted_thinking',
      ),
  );
}

function transcriptExists(folder: string, sessionId: string): boolean {
  const root = path.join(DATA_DIR, 'sessions', folder, '.claude', 'projects');
  if (!fs.existsSync(root)) return false;
  return fs
    .readdirSync(root)
    .some((dir) => fs.existsSync(path.join(root, dir, `${sessionId}.jsonl`)));
}

// ─── Scenarios ───

async function scenarioA(providerId: string): Promise<void> {
  const S = 'A agent-config-change';
  const ws = createWorkspace('a', providerId);
  const fact = newFact();
  const first = await runTurn(ws, ws.profile.id, rememberPrompt(fact));
  check(S, 'turn 1 completed', first.ok && !!first.sessionIdAfter);

  const before = db.getAgentProfile(ws.profile.id)!;
  const updated = db.updateAgentProfile(ws.profile.id, ownerId, {
    identityPrompt:
      'You are a concise, careful test assistant. Follow instructions exactly.',
  })!;
  check(
    S,
    'profile identity_hash and version bumped',
    updated.identity_hash !== before.identity_hash &&
      updated.version === before.version + 1,
  );

  const second = await runTurn(ws, ws.profile.id, recallPrompt);
  check(S, 'turn 2 completed', second.ok);
  check(
    S,
    'prompt carries refresh notice',
    second.prompt.startsWith('<system_context>') &&
      second.prompt.includes(`（版本 ${updated.version}）`),
  );
  check(
    S,
    'sessions row keeps sessionId',
    !!first.sessionIdAfter &&
      second.sessionIdBefore === first.sessionIdAfter &&
      second.sessionIdAfter === first.sessionIdAfter,
  );
  check(S, 'model recalls earlier fact', second.text.includes(fact));
  const identity = db.getSessionAgentIdentity(ws.group.folder, null);
  check(
    S,
    'session identity updated to new version',
    identity?.identity_hash === updated.identity_hash &&
      identity?.agent_profile_version === updated.version,
  );
  check(
    S,
    'no notice on the following turn',
    refreshNotice(ws.group.folder, updated) === '',
  );
}

async function scenarioProviderSwitch(
  S: string,
  label: string,
  fromId: string,
  toId: string,
  expectVerified: boolean,
): Promise<void> {
  const providers = runtimeConfig.getProviders();
  const from = providers.find((p) => p.id === fromId);
  const to = providers.find((p) => p.id === toId);
  const verified = continuity.canResumeAcrossProviders(from, to);
  check(
    S,
    `matrix treats pair as ${expectVerified ? 'verified' : 'unverified'}`,
    verified === expectVerified,
  );

  const ws = createWorkspace(label, fromId);
  const fact = newFact();
  const first = await runTurn(ws, ws.profile.id, rememberPrompt(fact));
  check(S, 'turn 1 completed', first.ok && !!first.sessionIdAfter);
  check(
    S,
    'session bound to provider X',
    db.getSessionProviderId(ws.group.folder, null) === fromId,
  );
  const firstHadThinking =
    !!first.sessionIdAfter &&
    transcriptHasThinkingIn(
      transcriptEntries(ws.group.folder, first.sessionIdAfter),
    );

  db.updateAgentProfile(ws.profile.id, ownerId, { modelConfigId: toId });
  const second = await runTurn(ws, ws.profile.id, recallPrompt);
  check(S, 'turn 2 completed', second.ok);
  check(
    S,
    'session bound to provider Y',
    db.getSessionProviderId(ws.group.folder, null) === toId,
  );
  check(S, 'model recalls earlier fact', second.text.includes(fact));
  if (expectVerified) {
    check(
      S,
      'sessions row keeps sessionId',
      !!first.sessionIdAfter && second.sessionIdAfter === first.sessionIdAfter,
    );
  } else {
    const newId = second.sessionIdAfter;
    check(
      S,
      'strip_thinking resume produced a new sessionId',
      !!newId && !!first.sessionIdAfter && newId !== first.sessionIdAfter,
    );
    check(
      S,
      'new session is a thinking-free copy of the original',
      !!newId &&
        !!first.sessionIdAfter &&
        isStrippedCopyOf(ws.group.folder, first.sessionIdAfter, newId),
    );
    check(
      S,
      'original transcript left in place',
      !!first.sessionIdAfter &&
        transcriptExists(ws.group.folder, first.sessionIdAfter),
    );
    check(
      S,
      'resume_strip_thinking marker clear after resume',
      !db.getSessionResumeStripThinking(ws.group.folder, null),
    );
    // Informational: whether turn 1 produced thinking blocks to strip.
    console.log(
      `[${S}] info turn 1 transcript had thinking blocks: ${firstHadThinking}`,
    );
  }
}

/** Remove one pair from the temp matrix so it reads as unverified. */
function forgetMatrixPair(fromId: string, toId: string): void {
  const providers = runtimeConfig.getProviders();
  const from = providers.find((p) => p.id === fromId)!;
  const to = providers.find((p) => p.id === toId)!;
  const file = continuity.SESSION_CONTINUITY_MATRIX_FILE;
  if (path.dirname(path.dirname(file)) !== path.resolve(tempDataDir)) {
    throw new Error('Refusing to edit a matrix outside the temp data dir');
  }
  const matrix = continuity.readResumeMatrix(file);
  const key = `${continuity.providerContinuityFingerprint(from)}>${continuity.providerContinuityFingerprint(to)}`;
  const pairs = { ...matrix.pairs };
  delete pairs[key];
  fs.writeFileSync(file, JSON.stringify({ version: 1, pairs }, null, 2), {
    mode: 0o600,
  });
  // The matrix reader caches by mtime; make the rewrite unambiguous.
  const future = new Date(Date.now() + 5_000);
  fs.utimesSync(file, future, future);
}

function pickPair(): { fromId: string; toId: string } {
  const providers = runtimeConfig.getProviders();
  const fromArg = argValue('--from');
  const toArg = argValue('--to');
  if (fromArg && toArg) return { fromId: fromArg, toId: toArg };
  const ordered = [
    ...providers.filter((p) => p.enabled),
    ...providers.filter((p) => !p.enabled),
  ];
  for (const from of ordered) {
    for (const to of ordered) {
      if (from.id !== to.id && continuity.canResumeAcrossProviders(from, to)) {
        return { fromId: from.id, toId: to.id };
      }
    }
  }
  throw new Error('No verified provider pair in the continuity matrix');
}

async function main(): Promise<void> {
  db.initDatabase();
  createOwner();
  const only = new Set(
    (argValue('--only') ?? 'A,B,C')
      .split(',')
      .map((s) => s.trim().toUpperCase()),
  );
  const { fromId, toId } = pickPair();
  // Agent pinning may bind any saved configuration, so disabled providers in
  // the temp copy are usable without enabling them in the source config.

  if (only.has('A')) await scenarioA(fromId);
  if (only.has('B')) {
    await scenarioProviderSwitch('B verified-switch', 'b', fromId, toId, true);
  }
  if (only.has('C')) {
    forgetMatrixPair(fromId, toId);
    await scenarioProviderSwitch(
      'C unverified-switch',
      'c',
      fromId,
      toId,
      false,
    );
  }

  db.closeDatabase();
  const failed = checks.filter((c) => !c.pass);
  console.log(
    `\nsummary: ${checks.length - failed.length}/${checks.length} checks passed`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

try {
  await main();
} catch (err) {
  // Error text may carry upstream detail; report the type only.
  console.error(
    `e2e aborted: ${err instanceof Error ? err.name : 'unknown error'}`,
  );
  process.exitCode = 1;
} finally {
  cleanup();
}
