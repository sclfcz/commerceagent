#!/usr/bin/env node

import fs from 'node:fs';

import { readDescriptorMountId } from './session-permissions-mount.mjs';

const OPEN_FLAGS =
  fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;
const DIRECTORY_FLAGS = OPEN_FLAGS | fs.constants.O_DIRECTORY;

function procFdPath(fd) {
  return `/proc/self/fd/${fd}`;
}

function procFdChildPath(parentFd, component) {
  return Buffer.concat([Buffer.from(`${procFdPath(parentFd)}/`), component]);
}

function rootBoundary(fd) {
  const stat = fs.fstatSync(fd);
  if (!stat.isDirectory())
    throw new Error('fixed generated root is not a directory');
  return { device: stat.dev, mountId: readDescriptorMountId(fd) };
}

function assertBoundary(fd, boundary) {
  const stat = fs.fstatSync(fd);
  if (
    stat.dev !== boundary.device ||
    readDescriptorMountId(fd) !== boundary.mountId
  ) {
    throw new Error('generated path crosses a nested mount boundary');
  }
  return stat;
}

function openOrCreateDirectory(parentFd, component, boundary) {
  const childPath = procFdChildPath(parentFd, component);
  let childFd;
  try {
    childFd = fs.openSync(childPath, DIRECTORY_FLAGS);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    fs.mkdirSync(childPath, { mode: 0o700 });
    childFd = fs.openSync(childPath, DIRECTORY_FLAGS);
  }
  try {
    assertBoundary(childFd, boundary);
    return childFd;
  } catch (error) {
    fs.closeSync(childFd);
    throw error;
  }
}

function removeTreeContents(directoryFd, boundary) {
  const entries = fs.readdirSync(procFdPath(directoryFd), {
    encoding: 'buffer',
    withFileTypes: true,
  });
  for (const entry of entries) {
    const childPath = procFdChildPath(directoryFd, entry.name);
    if (entry.isSymbolicLink()) {
      fs.unlinkSync(childPath);
      continue;
    }
    const childFd = fs.openSync(childPath, OPEN_FLAGS);
    let directory = false;
    try {
      const stat = assertBoundary(childFd, boundary);
      directory = stat.isDirectory();
      if (directory) removeTreeContents(childFd, boundary);
    } finally {
      fs.closeSync(childFd);
    }
    if (directory) fs.rmdirSync(childPath);
    else fs.unlinkSync(childPath);
  }
}

function ensureNpmGlobal() {
  const extraFd = fs.openSync('/workspace/extra', DIRECTORY_FLAGS);
  const opened = [];
  try {
    const boundary = rootBoundary(extraFd);
    const npmFd = openOrCreateDirectory(
      extraFd,
      Buffer.from('.npm-global'),
      boundary,
    );
    opened.push(npmFd);
    opened.push(openOrCreateDirectory(npmFd, Buffer.from('bin'), boundary));
    opened.push(openOrCreateDirectory(npmFd, Buffer.from('lib'), boundary));
  } finally {
    for (const fd of opened.reverse()) fs.closeSync(fd);
    fs.closeSync(extraFd);
  }
}

function resetSkills() {
  const sessionFd = fs.openSync('/home/node/.claude', DIRECTORY_FLAGS);
  let skillsFd;
  try {
    const boundary = rootBoundary(sessionFd);
    skillsFd = openOrCreateDirectory(
      sessionFd,
      Buffer.from('skills'),
      boundary,
    );
    removeTreeContents(skillsFd, boundary);
  } finally {
    if (skillsFd !== undefined) fs.closeSync(skillsFd);
    fs.closeSync(sessionFd);
  }
}

function linkSkill(name) {
  if (!/^\w[\w-]*$/.test(name)) throw new Error('invalid skill id');

  const effectiveRootFd = fs.openSync(
    '/workspace/effective-skills',
    DIRECTORY_FLAGS,
  );
  let sourceFd;
  let manifestFd;
  let sessionFd;
  let skillsFd;
  try {
    sourceFd = fs.openSync(
      procFdChildPath(effectiveRootFd, Buffer.from(name)),
      DIRECTORY_FLAGS,
    );
    const sourceStat = fs.fstatSync(sourceFd);
    if (!sourceStat.isDirectory())
      throw new Error('skill source is not a directory');
    manifestFd = fs.openSync(
      procFdChildPath(sourceFd, Buffer.from('SKILL.md')),
      OPEN_FLAGS,
    );
    if (!fs.fstatSync(manifestFd).isFile()) {
      throw new Error('skill manifest is not a regular file');
    }

    sessionFd = fs.openSync('/home/node/.claude', DIRECTORY_FLAGS);
    const boundary = rootBoundary(sessionFd);
    skillsFd = fs.openSync(
      procFdChildPath(sessionFd, Buffer.from('skills')),
      DIRECTORY_FLAGS,
    );
    assertBoundary(skillsFd, boundary);
    fs.symlinkSync(
      `/workspace/effective-skills/${name}`,
      procFdChildPath(skillsFd, Buffer.from(name)),
      'dir',
    );
  } finally {
    if (skillsFd !== undefined) fs.closeSync(skillsFd);
    if (sessionFd !== undefined) fs.closeSync(sessionFd);
    if (manifestFd !== undefined) fs.closeSync(manifestFd);
    if (sourceFd !== undefined) fs.closeSync(sourceFd);
    fs.closeSync(effectiveRootFd);
  }
}

const operation = process.argv[2] ?? '';
if (operation === '--ensure-npm-global') ensureNpmGlobal();
else if (operation === '--reset-skills') resetSkills();
else if (operation.startsWith('--link-skill=')) {
  linkSkill(operation.slice('--link-skill='.length));
} else {
  throw new Error('unknown generated-path operation');
}
