import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const source = fs.readFileSync(
  path.join(process.cwd(), 'src/index.ts'),
  'utf8',
);

describe('authorized chat unbind lifecycle', () => {
  test('/unbind restores the account default instead of clearing the route', () => {
    const start = source.indexOf('function unbindImGroup(');
    const end = source.indexOf('\n/**\n * Remove an IM group entirely', start);
    const body = source.slice(start, end);
    expect(body).toContain('restoreDefaultChannelMount(');
    expect(body).not.toContain('buildUnmountUpdate(');
    expect(source).toContain('已恢复 Bot 默认工作区。');
    expect(source).toContain('已保留当前绑定');
  });

  test('health repair reuses default restoration and keeps the old route on failure', () => {
    const start = source.indexOf('async function checkImBindingsHealth()');
    const body = source.slice(start);
    expect(body).toContain('const restored = unbindImGroup(');
    expect(body).toContain('kept orphaned main binding');
    expect(body).toContain('kept orphaned session binding');
  });

  test('thread workspace detaches only after the last source leaves', () => {
    const start = source.indexOf('function detachThreadMapWorkspace(');
    const end = source.indexOf('\n/** Restore an authorized chat', start);
    const body = source.slice(start, end);
    expect(body).toContain('hasRemainingThreadMapMount(');
  });
});
