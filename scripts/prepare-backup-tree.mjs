#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const [, , dataDirArg] = process.argv;
if (!dataDirArg) {
  console.error(
    'Usage: node scripts/prepare-backup-tree.mjs <staged-data-dir>',
  );
  process.exit(2);
}

const dataDir = path.resolve(dataDirArg);
const links = [];
let generatedLinkCount = 0;
let nonPortableWorkspaceLinkCount = 0;

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
}

function toArchivePath(candidate) {
  return path.relative(dataDir, candidate).split(path.sep).join('/');
}

function isGeneratedSessionClaudeLink(archivePath) {
  const segments = archivePath.split('/');
  return segments[0] === 'sessions' && segments.includes('.claude');
}

function walk(current) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const candidate = path.join(current, entry.name);
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      const archivePath = toArchivePath(candidate);
      if (isGeneratedSessionClaudeLink(archivePath)) {
        fs.unlinkSync(candidate);
        generatedLinkCount += 1;
        continue;
      }

      const target = fs.readlinkSync(candidate);
      const resolvedTarget = path.resolve(path.dirname(candidate), target);
      const isPortableTarget =
        !path.isAbsolute(target) && isInside(dataDir, resolvedTarget);
      if (!isPortableTarget && archivePath.startsWith('groups/')) {
        fs.unlinkSync(candidate);
        nonPortableWorkspaceLinkCount += 1;
        continue;
      }
      if (path.isAbsolute(target)) {
        throw new Error(
          `Unsafe absolute runtime symlink: ${archivePath} -> ${target}`,
        );
      }
      if (!isInside(dataDir, resolvedTarget)) {
        throw new Error(
          `Runtime symlink escapes the backup root: ${archivePath} -> ${target}`,
        );
      }
      links.push({ path: archivePath, target });
      fs.unlinkSync(candidate);
      continue;
    }
    if (stat.isDirectory()) {
      walk(candidate);
      continue;
    }
    if (!stat.isFile()) {
      throw new Error(
        `Unsafe runtime special file: ${toArchivePath(candidate)}`,
      );
    }
    // A regular file with more than one hard link is stored by tar as a
    // link-type ('h') entry pointing at its first-seen sibling instead of
    // a full copy. restore-backup.mjs's validateArchiveEntries rejects
    // link-type entries outright, so a hard link that slips through here
    // produces a backup that reports success but can never be restored —
    // fail fast during creation instead of failing silently at restore.
    if (stat.nlink > 1) {
      throw new Error(
        `Unsafe runtime hard-linked file (nlink=${stat.nlink}): ${toArchivePath(candidate)}`,
      );
    }
  }
}

walk(dataDir);
links.sort((left, right) => left.path.localeCompare(right.path));
fs.writeFileSync(
  path.join(dataDir, 'backup-symlinks.json'),
  `${JSON.stringify({ formatVersion: 1, links }, null, 2)}\n`,
  { mode: 0o600 },
);

if (generatedLinkCount > 0) {
  console.log(
    `ℹ️  已忽略 ${generatedLinkCount} 个可在运行时重建的会话 .claude 符号链接`,
  );
}
if (nonPortableWorkspaceLinkCount > 0) {
  console.log(
    `ℹ️  已忽略 ${nonPortableWorkspaceLinkCount} 个指向工作区外部、无法安全迁移的符号链接`,
  );
}
if (links.length > 0) {
  console.log(`ℹ️  已安全记录 ${links.length} 个工作区内部相对符号链接`);
}
