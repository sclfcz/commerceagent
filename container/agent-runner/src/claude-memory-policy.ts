import path from 'node:path';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function contextSource(runtimePolicy: unknown): string | undefined {
  if (!isRecord(runtimePolicy) || !isRecord(runtimePolicy.context)) {
    return undefined;
  }
  return typeof runtimePolicy.context.source === 'string'
    ? runtimePolicy.context.source
    : undefined;
}

function isAbsolutePortable(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value);
}

function pathApiFor(value: string): typeof path.posix | typeof path.win32 {
  return path.win32.isAbsolute(value) ? path.win32 : path.posix;
}

/** Claude Code treats these values as picomatch patterns on every platform. */
function toClaudePattern(value: string): string {
  return value.replace(/\\/g, '/');
}

function joinClaudePattern(root: string, ...segments: string[]): string {
  return toClaudePattern(pathApiFor(root).join(root, ...segments));
}

/**
 * Claude Code resolves user memory from the operating-system home directory,
 * even when CLAUDE_CONFIG_DIR points at CommerceAgent's per-session directory.
 * In managed mode, exclude those host instructions explicitly while keeping
 * the session's selected user-source Skills available.
 */
export function resolveManagedHostClaudeMdExcludes(options: {
  executionMode: 'host' | 'container';
  runtimePolicy?: unknown;
  externalClaudeDir?: string;
  homeDir?: string;
  projectRoot?: string;
}): string[] {
  if (
    options.executionMode !== 'host' ||
    contextSource(options.runtimePolicy) === 'host_claude'
  ) {
    return [];
  }

  const roots = new Set<string>();
  const candidates = [
    options.homeDir ? path.join(options.homeDir, '.claude') : undefined,
    options.externalClaudeDir,
  ];
  for (const candidate of candidates) {
    if (!candidate || !isAbsolutePortable(candidate)) continue;
    roots.add(pathApiFor(candidate).normalize(candidate));
  }

  const excludes = [...roots].flatMap((root) => [
    joinClaudePattern(root, 'CLAUDE.md'),
    joinClaudePattern(root, 'rules', '**'),
  ]);

  // Host agents run inside data/groups/<folder>, which is nested beneath the
  // CommerceAgent git repository. Claude Code therefore discovers the repository's
  // own CLAUDE.md as Project memory. That file is useful while developing
  // CommerceAgent, but it must not redefine a managed business Agent as a codebase
  // assistant. Exclude only the platform repository root; workspace-local
  // CLAUDE.md files inside the group's directory remain available.
  if (options.projectRoot && isAbsolutePortable(options.projectRoot)) {
    const projectRoot = pathApiFor(options.projectRoot).normalize(
      options.projectRoot,
    );
    excludes.push(
      joinClaudePattern(projectRoot, 'CLAUDE.md'),
      joinClaudePattern(projectRoot, '.claude', 'CLAUDE.md'),
      joinClaudePattern(projectRoot, 'CLAUDE.local.md'),
      joinClaudePattern(projectRoot, '.claude', 'rules', '**'),
    );
  }

  return [...new Set(excludes)];
}

/** Return SDK-reported memory files that should have matched an exclusion. */
export function findClaudeMdExcludeLeaks(
  memoryFiles: Array<{ path: string }>,
  excludes: string[],
): string[] {
  return memoryFiles
    .map((file) => toClaudePattern(file.path))
    .filter((filePath) =>
      excludes.some((exclude) => {
        const normalized = toClaudePattern(exclude);
        if (!normalized.endsWith('/**')) {
          return filePath === normalized;
        }
        const root = normalized.slice(0, -'/**'.length);
        return filePath === root || filePath.startsWith(`${root}/`);
      }),
    );
}
