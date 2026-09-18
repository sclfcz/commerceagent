import fs from 'node:fs';

export function parseDescriptorMountId(fdInfo) {
  if (typeof fdInfo !== 'string') {
    throw new Error('descriptor mount metadata is not text');
  }
  const matches = [...fdInfo.matchAll(/^mnt_id:\s+([0-9]+)\s*$/gm)];
  if (matches.length !== 1) {
    throw new Error('descriptor mount metadata has no unique mnt_id');
  }
  const mountId = Number(matches[0][1]);
  if (!Number.isSafeInteger(mountId) || mountId <= 0) {
    throw new Error('descriptor mount metadata has an invalid mnt_id');
  }
  return mountId;
}

export function readDescriptorMountId(fd, readFile = fs.readFileSync) {
  const fdInfo = readFile(`/proc/self/fdinfo/${fd}`, 'utf8');
  return parseDescriptorMountId(fdInfo);
}
