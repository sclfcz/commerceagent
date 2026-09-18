import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

export interface WorkspaceMemoryCapabilityScope {
  groupFolder: string;
  agentId?: string | null;
  taskRunId?: string | null;
}

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
interface RegisteredSigningSecret {
  runnerInstanceId: string;
  secret: Buffer;
  admittedTurnIds: Set<string>;
  usedSignatures: Set<string>;
}

const capabilities = new Map<string, Map<string, RegisteredSigningSecret>>();
const currentRunnerByScope = new Map<string, string>();

function scopeKey(scope: WorkspaceMemoryCapabilityScope): string {
  return JSON.stringify([
    scope.groupFolder,
    scope.agentId ?? null,
    scope.taskRunId ?? null,
  ]);
}

function normalizeForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : normalizeForCanonicalJson(item),
    );
  }
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(source)
        .sort()
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, normalizeForCanonicalJson(source[key])]),
    );
  }
  return value;
}

function mutationPayload(
  scope: WorkspaceMemoryCapabilityScope,
  request: Record<string, unknown>,
): string {
  const { mutationSignature: _signature, ...unsignedRequest } = request;
  return JSON.stringify(
    normalizeForCanonicalJson({
      namespace: {
        groupFolder: scope.groupFolder,
        agentId: scope.agentId ?? null,
        taskRunId: scope.taskRunId ?? null,
      },
      request: unsignedRequest,
    }),
  );
}

/**
 * Issue a runner-process capability for Workspace Memory mutations.
 *
 * The caller must deliver the returned value only through the runner's stdin
 * bootstrap payload. It must never be copied into process environment variables,
 * mounted files, logs, or model-visible tool schemas.
 */
export function issueWorkspaceMemoryWriteCapability(
  scope: WorkspaceMemoryCapabilityScope,
  initialTurnId?: string | null,
): { runnerInstanceId: string; signingSecret: string } {
  const signingSecret = randomBytes(TOKEN_BYTES).toString('base64url');
  const runnerInstanceId = randomUUID();
  const key = scopeKey(scope);
  const registered =
    capabilities.get(key) ?? new Map<string, RegisteredSigningSecret>();
  registered.set(runnerInstanceId, {
    runnerInstanceId,
    secret: Buffer.from(signingSecret, 'utf8'),
    admittedTurnIds: new Set(
      typeof initialTurnId === 'string' && initialTurnId ? [initialTurnId] : [],
    ),
    usedSignatures: new Set(),
  });
  capabilities.set(key, registered);
  currentRunnerByScope.set(key, runnerInstanceId);
  return { runnerInstanceId, signingSecret };
}

/**
 * Admit a host-issued warm input only to the runner that currently owns this
 * runtime scope. Old overlapping processes remain registered until finally,
 * but never receive turns published to their replacement.
 */
export function grantWorkspaceMemoryTurnToCurrentRunner(
  scope: WorkspaceMemoryCapabilityScope,
  runtimeTurnId: string,
): boolean {
  if (!runtimeTurnId) return false;
  const key = scopeKey(scope);
  const runnerInstanceId = currentRunnerByScope.get(key);
  const registered = runnerInstanceId
    ? capabilities.get(key)?.get(runnerInstanceId)
    : undefined;
  if (!registered) return false;
  registered.admittedTurnIds.add(runtimeTurnId);
  return true;
}

/**
 * Verify and atomically consume one mutation signature. A byte-for-byte replay
 * is rejected even while the issuing runner is still alive.
 */
export function verifyAndConsumeWorkspaceMemoryMutation(
  scope: WorkspaceMemoryCapabilityScope,
  request: Record<string, unknown>,
  candidateSignature: unknown,
): boolean {
  return verifyWorkspaceMemoryCapability(
    scope,
    request,
    candidateSignature,
    true,
  );
}

/**
 * Verify a request from the current admitted runner. Owner Profile uses the
 * non-consuming form for its per-turn read/claim refresh and the consuming
 * form for mutations.
 */
export function verifyWorkspaceMemoryCapability(
  scope: WorkspaceMemoryCapabilityScope,
  request: Record<string, unknown>,
  candidateSignature: unknown,
  consume: boolean = false,
): boolean {
  if (
    typeof candidateSignature !== 'string' ||
    !TOKEN_PATTERN.test(candidateSignature)
  ) {
    return false;
  }
  const key = scopeKey(scope);
  const registered = capabilities.get(key);
  const runnerInstanceId = request.runnerInstanceId;
  if (
    !registered ||
    typeof runnerInstanceId !== 'string' ||
    currentRunnerByScope.get(key) !== runnerInstanceId
  ) {
    return false;
  }
  const entry = registered.get(runnerInstanceId);
  const inputTurnId = request.inputTurnId;
  if (
    !entry ||
    typeof inputTurnId !== 'string' ||
    !entry.admittedTurnIds.has(inputTurnId)
  ) {
    return false;
  }
  const payload = mutationPayload(scope, request);
  const candidate = Buffer.from(candidateSignature, 'utf8');
  const expectedText = createHmac('sha256', entry.secret)
    .update(payload, 'utf8')
    .digest('base64url');
  const expected = Buffer.from(expectedText, 'utf8');
  if (
    expected.length === candidate.length &&
    timingSafeEqual(expected, candidate)
  ) {
    if (consume) {
      if (entry.usedSignatures.has(candidateSignature)) return false;
      entry.usedSignatures.add(candidateSignature);
    }
    return true;
  }
  return false;
}

/**
 * Revoke only the capability issued to the completing runner. This prevents an
 * older runner's finally block from invalidating a newer overlapping process.
 */
export function revokeWorkspaceMemoryWriteCapability(
  scope: WorkspaceMemoryCapabilityScope,
  runnerInstanceId: string,
): void {
  const key = scopeKey(scope);
  const registered = capabilities.get(key);
  if (!registered) return;
  registered.delete(runnerInstanceId);
  if (currentRunnerByScope.get(key) === runnerInstanceId) {
    currentRunnerByScope.delete(key);
  }
  if (registered.size === 0) {
    capabilities.delete(key);
    currentRunnerByScope.delete(key);
  }
}
