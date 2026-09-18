/**
 * Shared MCP server loading utilities.
 * Used by container-runner (Docker + Host modes) and routes/mcp-servers.
 */
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';

import { DATA_DIR } from './config.js';

export type McpMemberAccess = 'admin_only' | 'shared';

export interface StoredMcpServerDefinition {
  command?: string;
  args?: string[];
  type?: 'http' | 'sse';
  url?: string;
  enabled: boolean;
  importedFromHost?: boolean;
  /** @deprecated Kept while older clients migrate to importedFromHost. */
  syncedFromHost?: boolean;
  description?: string;
  /** System MCPs are admin-only unless an administrator explicitly shares them. */
  memberAccess?: McpMemberAccess;
  addedAt: string;
}

export interface StoredMcpServerSecrets {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface StoredMcpServersFile {
  servers: Record<string, StoredMcpServerDefinition>;
}

export interface StoredMcpSecretsFile {
  servers: Record<string, StoredMcpServerSecrets>;
}

export type ManagedMcpScope = 'system' | 'user';

export interface ManagedMcpLayers {
  system: Record<string, Record<string, unknown>>;
  user: Record<string, Record<string, unknown>>;
  /** System servers omitted from `system` because policy marks them admin-only. */
  restrictedSystemIds: string[];
}

export interface ManagedMcpAccessOptions {
  /**
   * Include admin-only system MCPs. Callers must opt in only after checking
   * that the runtime principal is an active administrator.
   */
  allowAdminOnlySystemMcp?: boolean;
}

export function getUserMcpServersDir(userId: string): string {
  return path.join(DATA_DIR, 'mcp-servers', userId);
}

export function getUserMcpServersFilePath(userId: string): string {
  return path.join(getUserMcpServersDir(userId), 'servers.json');
}

export function getUserMcpSecretsFilePath(userId: string): string {
  return path.join(getUserMcpServersDir(userId), 'secrets.json');
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const migratingStores = new Set<string>();

interface SecretMigrationLockOwner {
  token: string;
  pid: number;
  processStartTime?: string;
  createdAt: number;
}

interface SecretMigrationLockSnapshot {
  owner: SecretMigrationLockOwner | null;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

// A malformed lock has no verifiable owner. Give a live writer ample time to
// finish writing its small JSON owner record before treating it as abandoned.
const MALFORMED_MIGRATION_LOCK_STALE_MS = 5 * 60 * 1000;

function getProcessStartTime(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    if (commandEnd < 0) return undefined;
    // The tail starts at field 3 (state); starttime is field 22.
    return stat
      .slice(commandEnd + 2)
      .trim()
      .split(/\s+/)[19];
  } catch {
    return undefined;
  }
}

function parseMigrationLockOwner(raw: string): SecretMigrationLockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<SecretMigrationLockOwner>;
    if (
      typeof value.token !== 'string' ||
      value.token.length === 0 ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.createdAt !== 'number'
    ) {
      return null;
    }
    return {
      token: value.token,
      pid: value.pid!,
      createdAt: value.createdAt,
      ...(typeof value.processStartTime === 'string'
        ? { processStartTime: value.processStartTime }
        : {}),
    };
  } catch {
    return null;
  }
}

function readMigrationLockSnapshot(
  lockPath: string,
): SecretMigrationLockSnapshot | null {
  try {
    const stat = fs.statSync(lockPath);
    return {
      owner: parseMigrationLockOwner(fs.readFileSync(lockPath, 'utf8')),
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isMigrationLockOwnerAlive(owner: SecretMigrationLockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM still proves that the PID exists.
    if (code !== 'EPERM') return false;
  }
  if (owner.processStartTime) {
    const actualStartTime = getProcessStartTime(owner.pid);
    // On Linux, a different start time proves PID reuse. If /proc is not
    // available, fall back to the successful signal-0 liveness check.
    if (actualStartTime && actualStartTime !== owner.processStartTime) {
      return false;
    }
  }
  return true;
}

function sameMigrationLockSnapshot(
  left: SecretMigrationLockSnapshot,
  right: SecretMigrationLockSnapshot,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.owner?.token === right.owner?.token
  );
}

function reclaimStaleMigrationLock(lockPath: string): boolean {
  const observed = readMigrationLockSnapshot(lockPath);
  if (!observed) return true;
  const stale = observed.owner
    ? !isMigrationLockOwnerAlive(observed.owner)
    : Date.now() - observed.mtimeMs >= MALFORMED_MIGRATION_LOCK_STALE_MS;
  if (!stale) return false;

  // Re-read immediately before unlinking. The inode/fingerprint and owner
  // token checks prevent the usual stale-lock bug where a newly acquired live
  // lock is mistaken for the abandoned one observed earlier.
  const current = readMigrationLockSnapshot(lockPath);
  if (!current || !sameMigrationLockSnapshot(observed, current)) return false;
  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

function acquireMigrationLock(lockPath: string): string | null {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const owner: SecretMigrationLockOwner = {
      token: randomUUID(),
      pid: process.pid,
      processStartTime: getProcessStartTime(process.pid),
      createdAt: Date.now(),
    };
    let fd: number | undefined;
    try {
      fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(owner)}\n`);
      fs.fsyncSync(fd);
      return owner.token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!reclaimStaleMigrationLock(lockPath)) return null;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return null;
}

function releaseMigrationLock(lockPath: string, token: string): void {
  const current = readMigrationLockSnapshot(lockPath);
  if (!current || current.owner?.token !== token) return;
  try {
    fs.unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function persistMigratedStoreSync(
  userId: string,
  definitions: StoredMcpServersFile,
  secrets: StoredMcpSecretsFile,
): void {
  const key = getUserMcpServersDir(userId);
  if (migratingStores.has(key)) return;
  migratingStores.add(key);
  const dir = getUserMcpServersDir(userId);
  const definitionsPath = getUserMcpServersFilePath(userId);
  const secretsPath = getUserMcpSecretsFilePath(userId);
  const lockPath = path.join(dir, '.secret-migration.lock');
  const suffix = `${process.pid}.${randomUUID()}.tmp`;
  const definitionsTmp = `${definitionsPath}.${suffix}`;
  const secretsTmp = `${secretsPath}.${suffix}`;
  let lockToken: string | null = null;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best effort on unusual filesystems */
    }
    lockToken = acquireMigrationLock(lockPath);
    if (!lockToken) return;
    fs.writeFileSync(secretsTmp, `${JSON.stringify(secrets, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.writeFileSync(
      definitionsTmp,
      `${JSON.stringify(definitions, null, 2)}\n`,
      { mode: 0o600 },
    );
    // Secret copy is durable before legacy values are scrubbed. A crash can
    // temporarily leave duplicates, never erase the only copy.
    fs.renameSync(secretsTmp, secretsPath);
    fs.chmodSync(secretsPath, 0o600);
    fs.renameSync(definitionsTmp, definitionsPath);
    fs.chmodSync(definitionsPath, 0o600);
  } finally {
    if (lockToken) releaseMigrationLock(lockPath, lockToken);
    fs.rmSync(definitionsTmp, { force: true });
    fs.rmSync(secretsTmp, { force: true });
    migratingStores.delete(key);
  }
}

/**
 * Read definitions and secrets separately. Legacy files that embedded env or
 * headers remain readable, but every subsequent route mutation rewrites them
 * into servers.json + mode-0600 secrets.json.
 */
export function readStoredUserMcpServers(userId: string): {
  definitions: StoredMcpServersFile;
  secrets: StoredMcpSecretsFile;
} {
  const definitionsRaw = readJsonRecord(getUserMcpServersFilePath(userId));
  const rawServers =
    definitionsRaw.servers &&
    typeof definitionsRaw.servers === 'object' &&
    !Array.isArray(definitionsRaw.servers)
      ? (definitionsRaw.servers as Record<string, Record<string, unknown>>)
      : {};
  const secretsRaw = readJsonRecord(getUserMcpSecretsFilePath(userId));
  const rawSecretServers =
    secretsRaw.servers &&
    typeof secretsRaw.servers === 'object' &&
    !Array.isArray(secretsRaw.servers)
      ? (secretsRaw.servers as Record<string, StoredMcpServerSecrets>)
      : {};

  const definitions: StoredMcpServersFile = { servers: {} };
  const secrets: StoredMcpSecretsFile = { servers: {} };
  let requiresMigration = false;
  for (const [id, raw] of Object.entries(rawServers)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const { env: legacyEnv, headers: legacyHeaders, ...definition } = raw;
    if (legacyEnv !== undefined || legacyHeaders !== undefined) {
      requiresMigration = true;
    }
    const storedDefinition = definition as unknown as StoredMcpServerDefinition;
    if (
      userId === 'system' &&
      storedDefinition.memberAccess !== 'admin_only' &&
      storedDefinition.memberAccess !== 'shared'
    ) {
      // Old or malformed system definitions must never become member-visible
      // based on their command/url/secret contents. Persist the fail-closed
      // default so all future readers observe the same explicit policy.
      storedDefinition.memberAccess = 'admin_only';
      requiresMigration = true;
    }
    definitions.servers[id] = storedDefinition;
    const separated = rawSecretServers[id];
    const env =
      separated?.env ??
      (legacyEnv && typeof legacyEnv === 'object' && !Array.isArray(legacyEnv)
        ? (legacyEnv as Record<string, string>)
        : undefined);
    const headers =
      separated?.headers ??
      (legacyHeaders &&
      typeof legacyHeaders === 'object' &&
      !Array.isArray(legacyHeaders)
        ? (legacyHeaders as Record<string, string>)
        : undefined);
    if (env || headers) secrets.servers[id] = { env, headers };
  }
  if (requiresMigration) {
    persistMigratedStoreSync(userId, definitions, secrets);
  }
  return { definitions, secrets };
}

/**
 * Load enabled MCP server configs for a user.
 * Reads data/mcp-servers/{userId}/servers.json.
 * All workspaces owned by this user share the same MCP server set.
 */
export function loadUserMcpServers(
  userId: string,
): Record<string, Record<string, unknown>> {
  const { definitions, secrets } = readStoredUserMcpServers(userId);
  const merged = {
    servers: Object.fromEntries(
      Object.entries(definitions.servers).map(([id, definition]) => [
        id,
        { ...definition, ...(secrets.servers[id] ?? {}) },
      ]),
    ),
  };
  // Keep validation and runtime projection in one place. The temporary object
  // mirrors the historical servers.json shape without ever writing secrets
  // back into the definition file.
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(merged.servers)) {
    if (!server.enabled) continue;
    const isHttpType = server.type === 'http' || server.type === 'sse';
    if (isHttpType) {
      if (!server.url) continue;
      result[name] = {
        type: server.type,
        url: server.url,
        ...(server.headers && Object.keys(server.headers).length > 0
          ? { headers: server.headers }
          : {}),
      };
      continue;
    }
    if (!server.command) continue;
    result[name] = {
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length > 0
        ? { env: server.env }
        : {}),
    };
  }
  return result;
}

export function loadManagedMcpLayers(
  userId: string,
  options: ManagedMcpAccessOptions = {},
): ManagedMcpLayers {
  const systemDefinitions = readStoredUserMcpServers('system').definitions;
  const allSystemServers = loadUserMcpServers('system');
  const restrictedSystemIds = Object.keys(allSystemServers)
    .filter((id) => systemDefinitions.servers[id]?.memberAccess !== 'shared')
    .sort();
  const restricted = new Set(restrictedSystemIds);
  return {
    system: options.allowAdminOnlySystemMcp
      ? allSystemServers
      : Object.fromEntries(
          Object.entries(allSystemServers).filter(
            ([id]) => !restricted.has(id),
          ),
        ),
    user: loadUserMcpServers(userId),
    restrictedSystemIds,
  };
}

export function parseManagedMcpReference(reference: string): {
  scope: ManagedMcpScope;
  id: string;
} {
  if (reference.startsWith('system:')) {
    return { scope: 'system', id: reference.slice('system:'.length) };
  }
  if (reference.startsWith('user:')) {
    return { scope: 'user', id: reference.slice('user:'.length) };
  }
  // Backward compatibility: historical policies stored bare user MCP ids.
  return { scope: 'user', id: reference };
}

export function resolveManagedMcpPolicy(
  layers: ManagedMcpLayers,
  policy: { mode: 'inherit' | 'custom' | 'disabled'; ids: string[] },
): { servers: Record<string, Record<string, unknown>>; missing: string[] } {
  if (policy.mode === 'disabled') return { servers: {}, missing: [] };
  if (policy.mode === 'inherit') {
    return { servers: { ...layers.system, ...layers.user }, missing: [] };
  }

  const selectedSystem: Record<string, Record<string, unknown>> = {};
  const selectedUser: Record<string, Record<string, unknown>> = {};
  const missing: string[] = [];
  for (const reference of policy.ids) {
    const { scope, id } = parseManagedMcpReference(reference);
    const source = layers[scope];
    if (!id || !Object.prototype.hasOwnProperty.call(source, id)) {
      missing.push(reference);
      continue;
    }
    if (scope === 'system') selectedSystem[id] = source[id];
    else selectedUser[id] = source[id];
  }
  return {
    // User scope wins deterministic runtime name collisions, matching inherit.
    servers: { ...selectedSystem, ...selectedUser },
    missing,
  };
}
