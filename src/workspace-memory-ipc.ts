import type { WorkspaceMemoryActor } from './memory-service.js';
import type { WorkspaceMemorySourceType } from './memory-store.js';

export type WorkspaceMemoryIpcOperation =
  | 'snapshot'
  | 'search'
  | 'get'
  | 'create'
  | 'update'
  | 'delete';

export interface WorkspaceMemoryAuthoritativePrincipal {
  actor: WorkspaceMemoryActor;
  workspaceJid: string;
  sourceType: WorkspaceMemorySourceType;
  provenance: {
    sourceId?: string | null;
    sessionId?: string | null;
    observedAt?: string | null;
  };
}

const MUTATIONS = new Set<WorkspaceMemoryIpcOperation>([
  'create',
  'update',
  'delete',
]);

const UPDATE_FIELDS = [
  'kind',
  'title',
  'content',
  'canonicalKey',
  'status',
  'importance',
  'confidence',
  'validFrom',
  'validUntil',
  'expiresAt',
] as const;

export function workspaceMemoryWriteRejection(input: {
  operation: string | undefined;
  hostTurnKind: 'interactive' | 'scheduled' | 'unknown';
  runtimeAgentId: string | null;
  runtimeAgentKind: 'task' | 'conversation' | 'spawn' | null;
  capabilityValid: boolean;
}): { code: string; error: string } | null {
  if (!MUTATIONS.has(input.operation as WorkspaceMemoryIpcOperation)) {
    return null;
  }
  if (input.runtimeAgentId && input.runtimeAgentKind !== 'conversation') {
    return {
      code: 'runtime_agent_memory_read_only',
      error:
        'Spawned and task Agents have read-only Workspace Memory access; return candidate learnings to an interactive conversation session.',
    };
  }
  if (input.hostTurnKind === 'scheduled') {
    return {
      code: 'scheduled_memory_read_only',
      error:
        'Scheduled runs currently have read-only Workspace Memory access; return candidate learnings to an interactive top-level session.',
    };
  }
  if (input.hostTurnKind !== 'interactive') {
    return {
      code: 'workspace_memory_no_active_turn',
      error:
        'Workspace Memory mutations require a host-admitted active interactive turn.',
    };
  }
  if (!input.capabilityValid) {
    return {
      code: 'workspace_memory_invalid_capability',
      error: 'Workspace Memory mutation authorization is missing or invalid.',
    };
  }
  return null;
}

/**
 * Build an update request without spreading attacker-controlled principal
 * fields. Authoritative fields are assigned last as a second line of defense.
 */
export function buildWorkspaceMemoryUpdateInput(
  untrusted: {
    itemId?: string;
    expectedRevision?: number;
    idempotencyKey?: string;
    patch?: Record<string, unknown>;
  },
  principal: WorkspaceMemoryAuthoritativePrincipal,
): Record<string, unknown> {
  const source = untrusted.patch ?? {};
  const patch = Object.fromEntries(
    UPDATE_FIELDS.filter(
      (key) =>
        Object.prototype.hasOwnProperty.call(source, key) &&
        source[key] !== undefined,
    ).map((key) => [key, source[key]]),
  );
  return {
    itemId: untrusted.itemId ?? '',
    expectedRevision: untrusted.expectedRevision ?? 0,
    idempotencyKey: untrusted.idempotencyKey,
    ...patch,
    actor: principal.actor,
    workspaceJid: principal.workspaceJid,
    sourceType: principal.sourceType,
    provenance: principal.provenance,
  };
}
