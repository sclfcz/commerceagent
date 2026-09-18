import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { describe, expect, test } from 'vitest';

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), 'utf8');

describe('builtin Skill catalog bootstrap contract', () => {
  test('standard install and supported start paths materialize the pinned catalog', () => {
    const makefile = read('Makefile');
    const install = makefile.slice(
      makefile.indexOf('install: ##'),
      makefile.indexOf('clean: ##'),
    );
    const dev = makefile.slice(
      makefile.indexOf('dev: ##'),
      makefile.indexOf('dev-backend:'),
    );
    const start = makefile.slice(
      makefile.indexOf('start: ##'),
      makefile.indexOf('# ─── Internal build checks'),
    );

    expect(install).toContain('_ensure-builtin-skills');
    expect(dev).toContain('_ensure-builtin-skills');
    expect(start).toContain('_ensure-builtin-skills');
    expect(makefile).toContain('./scripts/install-host-tools.sh skills');
    expect(makefile).toContain('builtin-skill-catalog.mjs validate');
  });

  test('the container cannot inject an image-only Skill layer', () => {
    const entrypoint = read('container/entrypoint.sh');
    const dockerfile = read('container/Dockerfile');

    expect(entrypoint).not.toContain('/opt/builtin-skills');
    expect(dockerfile).not.toContain('/opt/builtin-skills');
    expect(entrypoint).toContain('/workspace/effective-skills');
  });

  test('rejects stale, partial, and payload-tampered catalogs', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-catalog-'));
    const script = path.join(
      process.cwd(),
      'scripts/builtin-skill-catalog.mjs',
    );
    const validate = () => {
      try {
        execFileSync(process.execPath, [script, 'validate', root]);
        return true;
      } catch {
        return false;
      }
    };
    const write = () => execFileSync(process.execPath, [script, 'write', root]);
    const makeSkill = (id: string) => {
      const directory = path.join(root, id);
      fs.mkdirSync(path.join(directory, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(directory, 'SKILL.md'), `# ${id}\n`);
      fs.writeFileSync(path.join(directory, 'scripts', 'run.js'), 'v1\n');
    };

    try {
      makeSkill('alpha');
      makeSkill('beta');
      write();
      expect(validate()).toBe(true);

      const markerPath = path.join(root, '.catalog.json');
      const stale = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      stale.version = 'v0.0.0';
      fs.writeFileSync(markerPath, JSON.stringify(stale));
      expect(validate()).toBe(false);

      write();
      fs.rmSync(path.join(root, 'beta'), { recursive: true });
      expect(validate()).toBe(false);

      makeSkill('beta');
      write();
      fs.writeFileSync(path.join(root, 'alpha', 'scripts', 'run.js'), 'v2\n');
      expect(validate()).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
