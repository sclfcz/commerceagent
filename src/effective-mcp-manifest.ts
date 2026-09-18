import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface EffectiveMcpManifest {
  schemaVersion: 1;
  hash: string;
  serverIds: string[];
}

export interface LocalPluginRef {
  type: 'local';
  path: string;
}

function readPluginMcpFile(filePath: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    const record = parsed as Record<string, unknown>;
    const servers = record.mcpServers;
    return servers && typeof servers === 'object' && !Array.isArray(servers)
      ? (servers as Record<string, unknown>)
      : record;
  } catch {
    return {};
  }
}

/** Mirror Claude plugin MCP discovery for provenance and preview purposes. */
export function loadPluginMcpDefinitions(
  plugins: LocalPluginRef[],
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};
  for (const plugin of plugins) {
    const segments = path.resolve(plugin.path).split(path.sep);
    const qualifier = segments.slice(-2).join('/');
    const files = [path.join(plugin.path, '.mcp.json')];
    const directory = path.join(plugin.path, 'mcp-servers');
    try {
      files.push(
        ...fs
          .readdirSync(directory, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
          .map((entry) => path.join(directory, entry.name))
          .sort(),
      );
    } catch {
      /* optional plugin directory */
    }
    for (const file of files) {
      for (const [serverId, definition] of Object.entries(
        readPluginMcpFile(file),
      )) {
        if (!definition || typeof definition !== 'object') continue;
        result[`plugin:${qualifier}:${serverId}`] = definition as Record<
          string,
          unknown
        >;
      }
    }
  }
  return result;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

/** Hash the exact resolved runtime map without exposing commands or secrets. */
export function buildEffectiveMcpManifest(
  servers: Record<string, Record<string, unknown>>,
): EffectiveMcpManifest {
  const serverIds = Object.keys(servers).sort();
  const definitions = Object.fromEntries(
    serverIds.map((id) => [id, canonicalize(servers[id])]),
  );
  return {
    schemaVersion: 1,
    hash: createHash('sha256')
      .update(JSON.stringify({ schemaVersion: 1, definitions }), 'utf8')
      .digest('hex'),
    serverIds,
  };
}
