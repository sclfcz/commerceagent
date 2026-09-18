#!/usr/bin/env node

import fs from 'node:fs';

import { readDescriptorMountId } from './session-permissions-mount.mjs';

const SOURCE_ROOT = '/app/prompts';
const DESTINATION_ROOT = '/tmp/prompts';
const OPEN_FLAGS =
  fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW;
const DIRECTORY_FLAGS = OPEN_FLAGS | fs.constants.O_DIRECTORY;

function procFdPath(fd) {
  return `/proc/self/fd/${fd}`;
}

function procFdChildPath(parentFd, component) {
  return Buffer.concat([Buffer.from(`${procFdPath(parentFd)}/`), component]);
}

function assertSourceBoundary(fd, rootDevice, rootMountId) {
  const stat = fs.fstatSync(fd);
  const mountId = readDescriptorMountId(fd);
  if (stat.dev !== rootDevice || mountId !== rootMountId) {
    throw new Error('prompt source contains a nested mount boundary');
  }
  return stat;
}

function copyFile(sourceFd, destinationFd) {
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (;;) {
    const bytesRead = fs.readSync(sourceFd, buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    let written = 0;
    while (written < bytesRead) {
      written += fs.writeSync(
        destinationFd,
        buffer,
        written,
        bytesRead - written,
      );
    }
  }
}

function copyDirectory(sourceFd, destinationFd, rootDevice, rootMountId) {
  const entries = fs.readdirSync(procFdPath(sourceFd), {
    encoding: 'buffer',
    withFileTypes: true,
  });
  for (const entry of entries) {
    const sourcePath = procFdChildPath(sourceFd, entry.name);
    const sourceChildFd = fs.openSync(sourcePath, OPEN_FLAGS);
    let destinationChildFd;
    try {
      const stat = assertSourceBoundary(sourceChildFd, rootDevice, rootMountId);
      const destinationPath = procFdChildPath(destinationFd, entry.name);
      if (stat.isDirectory()) {
        fs.mkdirSync(destinationPath, { mode: 0o700 });
        destinationChildFd = fs.openSync(destinationPath, DIRECTORY_FLAGS);
        copyDirectory(
          sourceChildFd,
          destinationChildFd,
          rootDevice,
          rootMountId,
        );
        fs.fchownSync(destinationChildFd, 0, 0);
        fs.fchmodSync(destinationChildFd, 0o555);
      } else if (stat.isFile()) {
        destinationChildFd = fs.openSync(
          destinationPath,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
        copyFile(sourceChildFd, destinationChildFd);
        fs.fchownSync(destinationChildFd, 0, 0);
        fs.fchmodSync(destinationChildFd, 0o444);
      } else {
        throw new Error('prompt source contains a symlink or special file');
      }
    } finally {
      if (destinationChildFd !== undefined) fs.closeSync(destinationChildFd);
      fs.closeSync(sourceChildFd);
    }
  }
}

let sourceRootFd;
let destinationRootFd;
try {
  sourceRootFd = fs.openSync(SOURCE_ROOT, DIRECTORY_FLAGS);
  const sourceRootStat = fs.fstatSync(sourceRootFd);
  if (!sourceRootStat.isDirectory()) {
    throw new Error('prompt source root is not a directory');
  }
  const sourceRootMountId = readDescriptorMountId(sourceRootFd);

  fs.mkdirSync(DESTINATION_ROOT, { mode: 0o700 });
  destinationRootFd = fs.openSync(DESTINATION_ROOT, DIRECTORY_FLAGS);
  copyDirectory(
    sourceRootFd,
    destinationRootFd,
    sourceRootStat.dev,
    sourceRootMountId,
  );
  fs.fchownSync(destinationRootFd, 0, 0);
  fs.fchmodSync(destinationRootFd, 0o555);
} finally {
  if (destinationRootFd !== undefined) fs.closeSync(destinationRootFd);
  if (sourceRootFd !== undefined) fs.closeSync(sourceRootFd);
}
