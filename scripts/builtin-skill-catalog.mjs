import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CATALOG_SCHEMA_VERSION = 1;
export const FEISHU_CLI_VERSION = 'v1.35.0';
export const FEISHU_CLI_SOURCE_SHA256 =
  '91b5575833f003527c7b60a26f08703ebfdb348098deecfa9ceed1dcf230f253';

const MARKER_NAME = '.catalog.json';
const IGNORED = new Set([
  MARKER_NAME,
  '.DS_Store',
  '.cache',
  '.git',
  '__pycache__',
  'node_modules',
]);

function payloadHash(root) {
  const hash = createHash('sha256');
  const visit = (directory, relativeRoot) => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => !IGNORED.has(entry.name))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeRoot
        ? path.posix.join(relativeRoot, entry.name)
        : entry.name;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        hash.update(
          `symlink\0${relativePath}\0${fs.readlinkSync(absolutePath)}\0`,
        );
      } else if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\0`);
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0`);
        hash.update(fs.readFileSync(absolutePath));
        hash.update('\0');
      }
    }
  };
  visit(root, '');
  return hash.digest('hex');
}

function skillIds(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .filter((entry) => fs.existsSync(path.join(root, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

export function writeCatalog(root) {
  const ids = skillIds(root);
  if (ids.length === 0) throw new Error('builtin Skill catalog is empty');
  const marker = {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    version: FEISHU_CLI_VERSION,
    sourceSha256: FEISHU_CLI_SOURCE_SHA256,
    payloadHash: payloadHash(root),
    skillIds: ids,
  };
  fs.writeFileSync(
    path.join(root, MARKER_NAME),
    `${JSON.stringify(marker, null, 2)}\n`,
  );
  return marker;
}

export function validateCatalog(root) {
  try {
    const marker = JSON.parse(
      fs.readFileSync(path.join(root, MARKER_NAME), 'utf8'),
    );
    const actualIds = skillIds(root);
    return (
      marker.schemaVersion === CATALOG_SCHEMA_VERSION &&
      marker.version === FEISHU_CLI_VERSION &&
      marker.sourceSha256 === FEISHU_CLI_SOURCE_SHA256 &&
      marker.payloadHash === payloadHash(root) &&
      JSON.stringify(marker.skillIds) === JSON.stringify(actualIds) &&
      actualIds.length > 0
    );
  } catch {
    return false;
  }
}

const [action, rootArg] = process.argv.slice(2);
if (action === 'write' || action === 'validate') {
  const root = path.resolve(rootArg || 'data/builtin-skills');
  if (action === 'write') {
    writeCatalog(root);
  } else if (!validateCatalog(root)) {
    process.exitCode = 1;
  }
}
