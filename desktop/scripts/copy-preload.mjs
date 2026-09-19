#!/usr/bin/env node
/** Copy the hand-written CommonJS preload next to the compiled main process. */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', 'src', 'preload', 'index.cjs');
const target = join(here, '..', 'dist', 'preload', 'index.cjs');

mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
console.log(`preload copied -> ${target}`);
