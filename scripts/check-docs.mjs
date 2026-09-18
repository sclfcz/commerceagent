import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const errors = [];

function lineNumber(text, index) {
  return text.slice(0, index).split('\n').length;
}

function repositoryMarkdownFiles() {
  return execFileSync(
    'git',
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z',
      '--',
      '*.md',
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  )
    .split('\0')
    .filter(Boolean)
    .filter((file) => fs.existsSync(path.join(root, file)));
}

function normalizeLocalTarget(raw) {
  const value = raw
    .trim()
    .replace(/^<|>$/g, '')
    .split(/\s+["']/)[0];
  if (
    !value ||
    value.startsWith('#') ||
    /^(?:https?:|mailto:|data:|javascript:)/i.test(value)
  ) {
    return null;
  }
  const withoutFragment = value.split('#')[0].split('?')[0];
  if (!withoutFragment) return null;
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

function checkMarkdownLinks(files) {
  const patterns = [
    /!?\[[^\]]*]\(([^)]+)\)/g,
    /<(?:img|a)\b[^>]*(?:src|href)=["']([^"']+)["'][^>]*>/gi,
  ];
  for (const file of files) {
    const absolute = path.join(root, file);
    const text = fs.readFileSync(absolute, 'utf8');
    const visibleText = text
      .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (block) =>
        block.replace(/[^\n]/g, ' '),
      )
      .replace(/`[^`\n]*`/g, (inline) => ' '.repeat(inline.length));
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        if (visibleText[match.index] === ' ') continue;
        const target = normalizeLocalTarget(match[1]);
        if (!target) continue;
        const resolved = path.resolve(path.dirname(absolute), target);
        if (!fs.existsSync(resolved)) {
          errors.push(
            `${file}:${lineNumber(text, match.index)} references missing ${target}`,
          );
        }
      }
    }
  }
}

const currentReferenceDocs = [
  'README.md',
  'CLAUDE.md',
  'SECURITY.md',
  'docs/API.md',
  'docs/ACL-MATRIX.md',
  'docs/PROMPT-SKILL-RUNTIME-TEST-PLAN.md',
  'web/public/icons/README.md',
];

function checkInlineRepositoryPaths() {
  const repositoryPath =
    /`((?:src|web|container|shared|scripts|config|tests|docs)\/[^`\s]+)`/g;
  for (const file of currentReferenceDocs) {
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) continue;
    const text = fs.readFileSync(absolute, 'utf8');
    for (const match of text.matchAll(repositoryPath)) {
      let target = match[1].replace(/[.,;:]$/, '').replace(/:\d+$/, '');
      if (/[{}*<>]/.test(target)) continue;
      const resolved = path.join(root, target);
      if (!fs.existsSync(resolved)) {
        errors.push(
          `${file}:${lineNumber(text, match.index)} references missing ${target}`,
        );
      }
    }
  }
}

function checkDocumentedMakeTargets() {
  const makefile = fs.readFileSync(path.join(root, 'Makefile'), 'utf8');
  const targets = new Set(
    [...makefile.matchAll(/^([A-Za-z0-9_.-]+)\s*:/gm)].map((match) => match[1]),
  );
  for (const file of ['README.md', 'CLAUDE.md']) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of text.matchAll(/\bmake\s+([A-Za-z0-9_.-]+)/g)) {
      if (!targets.has(match[1])) {
        errors.push(
          `${file}:${lineNumber(text, match.index)} references missing make target ${match[1]}`,
        );
      }
    }
  }
}

function checkApiRouteModuleIndex() {
  const api = fs.readFileSync(path.join(root, 'docs/API.md'), 'utf8');
  const routeDir = path.join(root, 'src/routes');
  for (const entry of fs.readdirSync(routeDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const reference = `src/routes/${entry.name}`;
    if (!api.includes(reference)) {
      errors.push(`docs/API.md does not index route module ${reference}`);
    }
  }
}

const files = repositoryMarkdownFiles();
checkMarkdownLinks(files);
checkInlineRepositoryPaths();
checkDocumentedMakeTargets();
checkApiRouteModuleIndex();

if (errors.length > 0) {
  console.error('Documentation consistency check failed:\n');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Documentation consistency check passed (${files.length} repository Markdown files).`,
);
