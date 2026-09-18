#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

export const MANAGED_BACKUP_COMPONENTS = [
  'config',
  'groups',
  'sessions',
  'skills',
  'mcp-servers',
  'plugins',
  'memory',
  'avatars',
  'extra',
  'builtin-skills',
  'db',
];

const [, , dataDirArg] = process.argv;
if (!dataDirArg) {
  console.error('Usage: node scripts/backup-manifest.mjs <staged-data-dir>');
  process.exit(2);
}

const dataDir = path.resolve(dataDirArg);
const presentComponents = MANAGED_BACKUP_COMPONENTS.filter((component) =>
  fs
    .statSync(path.join(dataDir, component), { throwIfNoEntry: false })
    ?.isDirectory(),
);

fs.writeFileSync(
  path.join(dataDir, 'backup-manifest.json'),
  `${JSON.stringify(
    {
      formatVersion: 2,
      managedComponents: MANAGED_BACKUP_COMPONENTS,
      presentComponents,
      excludedTransientComponents: ['ipc', 'env', 'streaming-buffer', 'logs'],
    },
    null,
    2,
  )}\n`,
  { mode: 0o600 },
);
