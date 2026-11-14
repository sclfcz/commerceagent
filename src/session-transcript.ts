import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';

/**
 * 定位某个工作区（或工作区内的 Agent 会话）对应的 Claude SDK transcript 目录。
 *
 * 目录布局与 container-runner 一致：
 * - 主会话：      `data/sessions/{folder}/.claude`
 * - Agent 会话：  `data/sessions/{folder}/agents/{agentId}/.claude`
 *
 * SDK 把 transcript 写在 `<sessionsDir>/projects/{encodedCwd}/{sessionId}.jsonl`，
 * 其中 encodedCwd 会把 cwd 里所有非字母数字字符替换为 `-`。这里不重启编码规则，
 * 直接在该目录下按 session id / 修改时间查找，避免 customCwd、软链接等差异导致
 * 推错目录。
 */
export function resolveGroupSessionsDir(
  folder: string,
  agentId?: string | null,
): string {
  if (agentId) {
    return path.join(
      DATA_DIR,
      'sessions',
      folder,
      'agents',
      agentId,
      '.claude',
    );
  }
  return path.join(DATA_DIR, 'sessions', folder, '.claude');
}

function listProjectDirs(projectsRoot: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(projectsRoot, entry.name));
}

/**
 * 找到要迁移的旧 transcript 文件。
 *
 * - 已知旧 SDK session id 时优先精确命中 `{sessionId}.jsonl`；
 * - 否则取该工作区（或该 Agent）最近修改的 transcript —— 崩溃恢复时旧
 *   session id 已经从 DB 删掉，但最近一次写入的文件就是它。
 *
 * 只扫描 `projects/{cwd}/` 一层，天然跳过 `subagents/**` 子代理 transcript。
 */
export function findSessionTranscript(
  sessionsDir: string,
  sessionId?: string | null,
): string | null {
  const projectsRoot = path.join(sessionsDir, 'projects');
  const projectDirs = listProjectDirs(projectsRoot);
  if (projectDirs.length === 0) return null;

  if (sessionId) {
    for (const dir of projectDirs) {
      const candidate = path.join(dir, `${sessionId}.jsonl`);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // 继续找下一个 projects 目录
      }
    }
  }

  let newest: { file: string; mtimeMs: number } | null = null;
  for (const dir of projectDirs) {
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(dir, entry.name);
      try {
        const { mtimeMs } = fs.statSync(file);
        if (!newest || mtimeMs > newest.mtimeMs) newest = { file, mtimeMs };
      } catch {
        // 文件在扫描期间消失，忽略
      }
    }
  }
  return newest?.file ?? null;
}

/** 读取 transcript 内容；文件不存在或不可读时返回 null。 */
export function readSessionTranscript(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}
