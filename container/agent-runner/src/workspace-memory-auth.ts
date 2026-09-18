import { createHmac } from 'node:crypto';

export interface WorkspaceMemoryMutationNamespace {
  groupFolder: string;
  agentId?: string | null;
  taskRunId?: string | null;
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

/**
 * Sign the exact mutation request that will be written to IPC. The secret is
 * retained only in the runner closure; the IPC payload contains this HMAC, not
 * the reusable bearer material.
 */
export function signWorkspaceMemoryMutation(
  secret: string,
  namespace: WorkspaceMemoryMutationNamespace,
  request: Record<string, unknown>,
): string {
  const { mutationSignature: _signature, ...unsignedRequest } = request;
  const payload = JSON.stringify(
    normalizeForCanonicalJson({
      namespace: {
        groupFolder: namespace.groupFolder,
        agentId: namespace.agentId ?? null,
        taskRunId: namespace.taskRunId ?? null,
      },
      request: unsignedRequest,
    }),
  );
  return createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('base64url');
}
