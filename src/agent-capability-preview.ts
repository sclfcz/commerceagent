import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import {
  buildEffectiveMcpManifest,
  loadPluginMcpDefinitions,
} from './effective-mcp-manifest.js';
import { getEffectiveExternalDir } from './runtime-config.js';
import {
  loadManagedMcpLayers,
  parseManagedMcpReference,
  resolveManagedMcpPolicy,
} from './mcp-utils.js';
import {
  getHostClaudeMcpSourcePaths,
  loadClaudeContextMcpServers,
  loadHostClaudeMcpServers,
  mergeMcpServerLayers,
  readMcpServersFile,
} from './mcp-context.js';
import { resolveEffectiveSkills } from './effective-skill-resolver.js';
import { pluginSkillLayers } from './effective-skill-resolver.js';
import { loadUserPlugins } from './plugin-utils.js';
import { resolveHostSkillPolicy } from './agent-profile-policy.js';
import {
  HOST_CLAUDE_NATIVE_DIRECTORIES,
  HOST_CLAUDE_NATIVE_FILES,
  HOST_CLAUDE_SETTINGS_FILES,
} from './claude-context-resolver.js';
import type { AgentProfile, RegisteredGroup } from './types.js';

export type CapabilityLayerSource =
  | 'builtin'
  | 'host'
  | 'project'
  | 'workspace'
  | 'managed'
  | 'plugin'
  | 'system'
  | 'user';

export interface EffectiveCapabilityEntry {
  id: string;
  source: CapabilityLayerSource;
  overrides: CapabilityLayerSource[];
  available: boolean;
  unavailableReason?: 'system_admin_only';
}

export interface AgentCapabilityPreview {
  workspace: { jid: string; name: string; folder: string } | null;
  context: {
    source: 'managed' | 'host_claude';
    claudeMd: boolean;
    rules: number;
    nativeConfig: {
      settingsFiles: string[];
      entries: Array<{
        name: string;
        kind: 'file' | 'directory';
        entryCount?: number;
      }>;
    };
  };
  skills: {
    mode: AgentProfile['runtime_policy']['skills']['mode'];
    host: NonNullable<AgentProfile['runtime_policy']['skills']['host']>;
    manifestHash: string;
    entries: EffectiveCapabilityEntry[];
    conflicts: string[];
  };
  mcp: {
    mode: AgentProfile['runtime_policy']['mcp']['mode'];
    manifestHash: string;
    entries: EffectiveCapabilityEntry[];
    conflicts: string[];
  };
  notes: string[];
}

function countEntries(root: string): number {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() || entry.isDirectory() || entry.isSymbolicLink(),
      ).length;
  } catch {
    return 0;
  }
}

function mergeLayers(
  layers: Array<{
    source: CapabilityLayerSource;
    ids: string[];
    available?: boolean;
    unavailableReason?: EffectiveCapabilityEntry['unavailableReason'];
  }>,
): { entries: EffectiveCapabilityEntry[]; conflicts: string[] } {
  const entries = new Map<string, EffectiveCapabilityEntry>();
  const conflicts = new Set<string>();
  for (const layer of layers) {
    for (const id of new Set(layer.ids)) {
      const previous = entries.get(id);
      if (previous) conflicts.add(id);
      entries.set(id, {
        id,
        source: layer.source,
        overrides: previous
          ? [...previous.overrides, previous.source].filter(
              (source, index, all) => all.indexOf(source) === index,
            )
          : [],
        available: layer.available !== false,
        ...(layer.available === false && layer.unavailableReason
          ? { unavailableReason: layer.unavailableReason }
          : {}),
      });
    }
  }
  return {
    entries: [...entries.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    ),
    conflicts: [...conflicts].sort(),
  };
}

function mcpIds(filePath: string): string[] {
  return Object.keys(readMcpServersFile(filePath));
}

export function buildAgentCapabilityPreview(options: {
  profile: AgentProfile;
  workspace?: { jid: string; group: RegisteredGroup };
  ownerRole?: 'admin' | 'member';
}): AgentCapabilityPreview {
  const { profile, workspace } = options;
  const policy = profile.runtime_policy;
  const externalClaudeDir = getEffectiveExternalDir();
  const workspaceDir = workspace
    ? path.join(GROUPS_DIR, workspace.group.folder)
    : undefined;
  const hostContext = policy.context.source === 'host_claude';
  const hostSkillPolicy = resolveHostSkillPolicy(policy);
  const enabledPlugins = loadUserPlugins(profile.owner_user_id, {
    runtime: 'host',
  });

  const skillManifest = resolveEffectiveSkills({
    layers: [
      { source: 'builtin', root: path.join(DATA_DIR, 'builtin-skills') },
      ...(hostSkillPolicy.mode !== 'disabled'
        ? [
            {
              source: 'host' as const,
              root: path.join(externalClaudeDir, 'skills'),
            },
          ]
        : []),
      {
        source: 'project',
        root: path.resolve(process.cwd(), 'container', 'skills'),
      },
      {
        source: 'managed',
        root: path.join(DATA_DIR, 'skills', profile.owner_user_id),
      },
      ...(workspaceDir
        ? [
            {
              source: 'workspace' as const,
              root: path.join(workspaceDir, '.claude', 'skills'),
            },
          ]
        : []),
      ...pluginSkillLayers(enabledPlugins),
    ],
    managedPolicy: policy.skills,
    hostPolicy: hostSkillPolicy,
  });
  const skills = {
    entries: skillManifest.selected.map((skill) => ({
      id: skill.id,
      source: skill.source as CapabilityLayerSource,
      overrides: skill.overrides as CapabilityLayerSource[],
      available: true,
    })),
    conflicts: skillManifest.conflicts,
  };

  const allowAdminOnlySystemMcp = options.ownerRole === 'admin';
  const managedMcpLayers = loadManagedMcpLayers(profile.owner_user_id, {
    // Preview needs the complete catalogue so it can explain why a system
    // server is unavailable instead of making it disappear.
    allowAdminOnlySystemMcp: true,
  });
  const restrictedSystemIds = new Set(
    allowAdminOnlySystemMcp ? [] : managedMcpLayers.restrictedSystemIds,
  );
  let selectedSystemMcpIds: string[] = [];
  let selectedUserMcpIds: string[] = [];
  if (policy.mcp.mode === 'inherit') {
    selectedSystemMcpIds = Object.keys(managedMcpLayers.system);
    selectedUserMcpIds = Object.keys(managedMcpLayers.user);
  } else if (policy.mcp.mode === 'custom') {
    for (const reference of policy.mcp.ids) {
      const parsed = parseManagedMcpReference(reference);
      if (
        Object.prototype.hasOwnProperty.call(
          managedMcpLayers[parsed.scope],
          parsed.id,
        )
      ) {
        if (parsed.scope === 'system') selectedSystemMcpIds.push(parsed.id);
        else selectedUserMcpIds.push(parsed.id);
      }
    }
  }
  const mcpLayers: Array<{
    source: CapabilityLayerSource;
    ids: string[];
    available?: boolean;
    unavailableReason?: EffectiveCapabilityEntry['unavailableReason'];
  }> = [];
  if (hostContext) {
    mcpLayers.push({
      source: 'host',
      ids: getHostClaudeMcpSourcePaths(externalClaudeDir).flatMap(mcpIds),
    });
  }
  if (workspaceDir) {
    mcpLayers.push({
      source: 'workspace',
      ids: [
        ...mcpIds(path.join(workspaceDir, '.mcp.json')),
        ...mcpIds(path.join(workspaceDir, '.claude', 'settings.json')),
        ...mcpIds(path.join(workspaceDir, '.claude', 'settings.local.json')),
      ],
    });
  }
  mcpLayers.push({
    source: 'system',
    ids: selectedSystemMcpIds.filter((id) => !restrictedSystemIds.has(id)),
  });
  mcpLayers.push({
    source: 'system',
    ids: selectedSystemMcpIds.filter((id) => restrictedSystemIds.has(id)),
    available: false,
    unavailableReason: 'system_admin_only',
  });
  mcpLayers.push({ source: 'user', ids: selectedUserMcpIds });
  const pluginMcpDefinitions =
    policy.mcp.mode === 'inherit'
      ? loadPluginMcpDefinitions(enabledPlugins)
      : {};
  mcpLayers.push({ source: 'plugin', ids: Object.keys(pluginMcpDefinitions) });
  const mcp = mergeLayers(mcpLayers);
  const runtimeManagedLayers = allowAdminOnlySystemMcp
    ? managedMcpLayers
    : {
        ...managedMcpLayers,
        system: Object.fromEntries(
          Object.entries(managedMcpLayers.system).filter(
            ([id]) => !restrictedSystemIds.has(id),
          ),
        ),
      };
  const runtimeManagedServers = resolveManagedMcpPolicy(
    runtimeManagedLayers,
    policy.mcp,
  ).servers;
  const contextMcpServers = workspaceDir
    ? loadClaudeContextMcpServers({
        workspaceDir,
        externalClaudeDir,
        includeHostClaudeContext: hostContext,
      })
    : hostContext
      ? loadHostClaudeMcpServers(externalClaudeDir)
      : {};
  const mcpManifest = buildEffectiveMcpManifest({
    ...mergeMcpServerLayers(contextMcpServers, runtimeManagedServers),
    ...pluginMcpDefinitions,
  });

  const notes = [
    '系统附加能力与宿主机、项目上下文是叠加关系，不会因继承宿主机配置而被替换。',
  ];
  if (!workspace)
    notes.push('选择一个工作区后可检查该工作区的项目级 Skills 与 MCP。');
  if (skills.conflicts.length > 0) {
    notes.push(
      '同名 Skill 按内置 → 宿主机 → CommerceAgent 项目 → 系统附加 → 工作区项目 → 插件的顺序解析；插件 Skill 使用 plugin:skill 限定名。',
    );
  }
  notes.push(
    'CommerceAgent 用户 Skills 与宿主机 Skills 独立筛选；内置、项目和工作区 Skills 仍按来源优先级解析。',
  );
  if (hostContext) {
    notes.push(
      '运行 cwd 仍是所选工作区；宿主机 ~/.claude 作为完整用户配置层叠加，不会把文件与命令操作切换到配置目录。',
    );
  }
  if (mcp.conflicts.length > 0)
    notes.push(
      '同名 MCP 按宿主机 → 工作区 → 系统 MCP → 用户 MCP 的稳定顺序覆盖。',
    );
  if (restrictedSystemIds.size > 0) {
    notes.push(
      `有 ${restrictedSystemIds.size} 个系统 MCP 仅限管理员，普通成员智能体不会继承。`,
    );
  }

  return {
    workspace: workspace
      ? {
          jid: workspace.jid,
          name: workspace.group.name,
          folder: workspace.group.folder,
        }
      : null,
    context: {
      source: policy.context.source,
      claudeMd:
        hostContext && fs.existsSync(path.join(externalClaudeDir, 'CLAUDE.md')),
      rules: hostContext
        ? countEntries(path.join(externalClaudeDir, 'rules'))
        : 0,
      nativeConfig: {
        settingsFiles: hostContext
          ? HOST_CLAUDE_SETTINGS_FILES.filter((name) =>
              fs.existsSync(path.join(externalClaudeDir, name)),
            )
          : [],
        entries: hostContext
          ? [
              ...HOST_CLAUDE_NATIVE_DIRECTORIES.map((name) => ({
                name,
                kind: 'directory' as const,
                entryCount: countEntries(path.join(externalClaudeDir, name)),
              })),
              ...HOST_CLAUDE_NATIVE_FILES.map((name) => ({
                name,
                kind: 'file' as const,
              })),
            ].filter((entry) =>
              fs.existsSync(path.join(externalClaudeDir, entry.name)),
            )
          : [],
      },
    },
    skills: {
      mode: policy.skills.mode,
      host: hostSkillPolicy,
      manifestHash: skillManifest.hash,
      ...skills,
    },
    mcp: { mode: policy.mcp.mode, manifestHash: mcpManifest.hash, ...mcp },
    notes,
  };
}
