import fs from 'fs';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/ui/button', () => ({
  Button: () => null,
}));
vi.mock('@/components/ui/input', () => ({
  Input: () => null,
}));
vi.mock('@/components/ui/label', () => ({
  Label: () => null,
}));
vi.mock('../web/src/components/shared/DirectoryBrowser', () => ({
  DirectoryBrowser: () => null,
}));

import {
  CONTAINER_MOUNT_ROOT,
  MAX_HOST_DIRECTORY_MOUNTS,
  type HostDirectoryMountDraft,
  toAdditionalMountInputs,
  validateHostDirectoryMounts,
} from '../web/src/components/chat/HostDirectoryMountEditor';

function draft(
  id: string,
  hostPath: string,
  containerPath: string,
): HostDirectoryMountDraft {
  return {
    id,
    hostPath,
    containerPath,
    containerPathTouched: true,
  };
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

describe('host directory mount editor contract', () => {
  it('accepts multiple distinct host directories below the fixed prefix', () => {
    expect(MAX_HOST_DIRECTORY_MOUNTS).toBe(8);
    expect(CONTAINER_MOUNT_ROOT).toBe('/workspace/extra/');
    expect(
      validateHostDirectoryMounts([
        draft('one', '/srv/projects/one', 'project-one'),
        draft('two', '/srv/projects/two', 'teams/two'),
      ]),
    ).toEqual({});
  });

  it.each([
    ['', 'target', 'additional_mounts.0.host_path'],
    ['relative/source', 'target', 'additional_mounts.0.host_path'],
    ['/srv/source', '', 'additional_mounts.0.container_path'],
    ['/srv/source', '/absolute', 'additional_mounts.0.container_path'],
    ['/srv/source', '../escape', 'additional_mounts.0.container_path'],
    ['/srv/source', '.', 'additional_mounts.0.container_path'],
    ['/srv/source', 'one/../two', 'additional_mounts.0.container_path'],
    ['/srv/source', 'one\\two', 'additional_mounts.0.container_path'],
    ['/srv/source', '.npm-global', 'additional_mounts.0.container_path'],
    ['/srv/source', '.npm-global/cache', 'additional_mounts.0.container_path'],
  ])(
    'rejects unsafe draft host=%j target=%j',
    (hostPath, containerPath, field) => {
      expect(
        validateHostDirectoryMounts([draft('unsafe', hostPath, containerPath)]),
      ).toHaveProperty(field);
    },
  );

  it('marks duplicate and nested targets on every conflicting row', () => {
    const duplicate = validateHostDirectoryMounts([
      draft('one', '/srv/one', 'shared'),
      draft('two', '/srv/two', 'shared'),
    ]);
    expect(duplicate).toHaveProperty('additional_mounts.0.container_path');
    expect(duplicate).toHaveProperty('additional_mounts.1.container_path');

    const nested = validateHostDirectoryMounts([
      draft('one', '/srv/one', 'shared'),
      draft('two', '/srv/two', 'shared/nested'),
    ]);
    expect(nested).toHaveProperty('additional_mounts.0.container_path');
    expect(nested).toHaveProperty('additional_mounts.1.container_path');
  });

  it('rejects more than eight rows even if state is externally manipulated', () => {
    const mounts = Array.from({ length: 9 }, (_, index) =>
      draft(`row-${index}`, `/srv/source-${index}`, `target-${index}`),
    );

    expect(validateHostDirectoryMounts(mounts)).toHaveProperty(
      'additional_mounts',
    );
  });

  it('serializes the API payload with snake_case fields and forced read-only', () => {
    expect(
      toAdditionalMountInputs([
        draft('one', ' /srv/projects/one ', ' project-one '),
        draft('two', ' /srv/projects/two ', ' teams/two '),
      ]),
    ).toEqual([
      {
        host_path: '/srv/projects/one',
        container_path: 'project-one',
        readonly: true,
      },
      {
        host_path: '/srv/projects/two',
        container_path: 'teams/two',
        readonly: true,
      },
    ]);
  });

  it('gates mount controls to container-mode admins and clears stale drafts', () => {
    const dialog = read('web/src/components/chat/CreateContainerDialog.tsx');

    expect(dialog).toContain(
      "const canHostExec = useAuthStore((s) => s.user?.role === 'admin');",
    );
    expect(dialog).toContain(
      "if (canHostExec && executionMode === 'container') return;",
    );
    expect(dialog).toContain('setHostMounts([]);');
    expect(dialog).toContain('setFieldErrors({});');
    expect(dialog).toContain("canHostExec && executionMode === 'container'");
    expect(dialog).toContain('<HostDirectoryMountEditor');
  });

  it('passes mounts through createFlow and preserves the real API error', () => {
    const dialog = read('web/src/components/chat/CreateContainerDialog.tsx');
    const store = read('web/src/stores/chat.ts');

    expect(dialog).toContain(
      'options.additional_mounts = toAdditionalMountInputs(hostMounts);',
    );
    expect(store).toContain(
      'body.additional_mounts = options.additional_mounts;',
    );
    expect(dialog).toContain('const message = extractErrorMessage(err)');
    expect(dialog).toContain('setSubmitError(message);');
    expect(store).toMatch(
      /catch \(err\) \{\s*set\(\{ error: extractErrorMessage\(err\) \}\);\s*throw err;/,
    );
  });

  it('keeps non-selectable mount browse paths navigable but not selectable', () => {
    const browser = read('web/src/components/shared/DirectoryBrowser.tsx');

    expect(browser).toContain('selectable?: boolean;');
    expect(browser).toContain('currentSelectable?: boolean;');
    expect(browser).toContain(
      "purpose !== 'mount' || directory.selectable !== false",
    );
    expect(browser).toContain('disabled={!canSelectCurrent}');
    expect(browser).toContain('disabled={!canSelectDirectory}');
    expect(browser).toContain('仅可用于导航，不能直接挂载');
  });
});
