import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  buildClaudeContextPlan,
  loadHostClaudeSettings,
  syncHostClaudeContext,
} from '../src/claude-context-resolver.js';

function writeFile(file: string, text = 'x'): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function makeSkill(root: string, name: string): void {
  writeFile(path.join(root, name, 'SKILL.md'), `# ${name}`);
}

function fakeGroup(folder: string, ownerId: string, isHome = false) {
  return {
    name: folder,
    folder,
    added_at: '2026-05-18T00:00:00.000Z',
    created_by: ownerId,
    is_home: isHome,
  };
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'commerceagent-context-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ClaudeContextResolver', () => {
  test('host sync links admin CLAUDE.md/rules/skills from the effective external dir', () => {
    const external = path.join(tmp, 'external-claude');
    const dataDir = path.join(tmp, 'data');
    const projectRoot = path.join(tmp, 'project');
    const sessionDir = path.join(tmp, 'sessions', 'main', '.claude');

    writeFile(path.join(external, 'CLAUDE.md'), '# admin playbook');
    writeFile(path.join(external, 'rules', 'browser.md'), '# browser rule');
    writeFile(path.join(external, 'agents', 'researcher.md'), '# researcher');
    writeFile(path.join(external, 'commands', 'review.md'), '# review');
    writeFile(path.join(external, 'hooks', 'on-stop.sh'), '#!/bin/sh');
    writeFile(path.join(external, 'workflows', 'research.md'), '# workflow');
    writeFile(path.join(external, 'output-styles', 'concise.md'), '# concise');
    writeFile(path.join(external, 'plugins', 'config.json'), '{}');
    writeFile(path.join(external, 'keybindings.json'), '{}');
    writeFile(
      path.join(external, 'settings.json'),
      JSON.stringify({
        env: {
          HOST_BASE: '1',
          ANTHROPIC_BASE_URL: 'https://stale-provider.example',
          ANTHROPIC_AUTH_TOKEN: 'stale-token',
          ANTHROPIC_DEFAULT_SONNET_MODEL: 'stale-model',
          CLAUDE_CODE_OAUTH_TOKEN: 'stale-oauth',
        },
        hooks: { Stop: ['base'] },
      }),
    );
    writeFile(
      path.join(external, 'settings.local.json'),
      JSON.stringify({ env: { HOST_LOCAL: '1' }, model: 'opus' }),
    );
    makeSkill(path.join(external, 'skills'), 'external-skill');
    makeSkill(path.join(dataDir, 'builtin-skills'), 'builtin-skill');
    makeSkill(path.join(projectRoot, 'container', 'skills'), 'project-skill');
    makeSkill(path.join(dataDir, 'skills', 'admin'), 'user-skill');

    const plan = buildClaudeContextPlan({
      executionMode: 'host',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot,
      dataDir,
      groupSessionsDir: sessionDir,
      includeHostClaudeContext: true,
    });
    const sync = syncHostClaudeContext(plan, sessionDir);

    expect(plan.audit.skills.includedSkills).toBe(4);
    expect(plan.audit.skills.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'builtin', count: 1 }),
        expect.objectContaining({ name: 'external', count: 1 }),
        expect.objectContaining({ name: 'project', count: 1 }),
        expect.objectContaining({ name: 'managed', count: 1 }),
        expect.objectContaining({ name: 'workspace', count: 0 }),
      ]),
    );

    expect(sync.claudeMdStatus).toBe('linked');
    expect(fs.readlinkSync(path.join(sessionDir, 'CLAUDE.md'))).toBe(
      path.join(external, 'CLAUDE.md'),
    );
    for (const name of [
      'agents',
      'commands',
      'hooks',
      'workflows',
      'output-styles',
      'plugins',
      'keybindings.json',
    ]) {
      expect(fs.readlinkSync(path.join(sessionDir, name))).toBe(
        path.join(external, name),
      );
    }
    expect(loadHostClaudeSettings(plan)).toMatchObject({
      env: { HOST_BASE: '1', HOST_LOCAL: '1' },
      hooks: { Stop: ['base'] },
      model: 'opus',
    });
    expect(loadHostClaudeSettings(plan).env).not.toHaveProperty(
      'ANTHROPIC_BASE_URL',
    );
    expect(loadHostClaudeSettings(plan).env).not.toHaveProperty(
      'ANTHROPIC_AUTH_TOKEN',
    );
    expect(loadHostClaudeSettings(plan).env).not.toHaveProperty(
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
    );
    expect(loadHostClaudeSettings(plan).env).not.toHaveProperty(
      'CLAUDE_CODE_OAUTH_TOKEN',
    );
    expect(plan.audit.nativeConfig).toMatchObject({
      enabled: true,
      settingSources: ['user', 'project', 'local'],
    });
    expect(fs.readlinkSync(path.join(sessionDir, 'rules', 'browser.md'))).toBe(
      path.join(external, 'rules', 'browser.md'),
    );
    expect(
      fs.readlinkSync(path.join(sessionDir, 'skills', 'builtin-skill')),
    ).toBe(path.join(dataDir, 'builtin-skills', 'builtin-skill'));
    expect(
      fs.readlinkSync(path.join(sessionDir, 'skills', 'external-skill')),
    ).toBe(path.join(external, 'skills', 'external-skill'));
    expect(
      fs.readlinkSync(path.join(sessionDir, 'skills', 'project-skill')),
    ).toBe(path.join(projectRoot, 'container', 'skills', 'project-skill'));
    expect(fs.readlinkSync(path.join(sessionDir, 'skills', 'user-skill'))).toBe(
      path.join(dataDir, 'skills', 'admin', 'user-skill'),
    );
  });

  test('host sync preserves a real session CLAUDE.md and reports shadowed', () => {
    const external = path.join(tmp, 'external-claude');
    const sessionDir = path.join(tmp, 'sessions', 'main', '.claude');
    writeFile(path.join(external, 'CLAUDE.md'), '# external');
    writeFile(path.join(sessionDir, 'CLAUDE.md'), '# local');

    const plan = buildClaudeContextPlan({
      executionMode: 'host',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: sessionDir,
      includeHostClaudeContext: true,
    });
    const sync = syncHostClaudeContext(plan, sessionDir);

    expect(sync.claudeMdStatus).toBe('shadowed');
    expect(sync.warnings).toContain('CLAUDE.md shadowed by session file');
    expect(
      fs.lstatSync(path.join(sessionDir, 'CLAUDE.md')).isSymbolicLink(),
    ).toBe(false);
  });

  test('container plan mounts admin triad but does not expose it to ordinary users', () => {
    const external = path.join(tmp, 'external-claude');
    writeFile(path.join(external, 'CLAUDE.md'), '# admin');
    writeFile(path.join(external, 'rules', 'r.md'), '# rule');
    makeSkill(path.join(external, 'skills'), 'external-skill');

    const adminPlan = buildClaudeContextPlan({
      executionMode: 'container',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: path.join(tmp, 'sessions', 'main', '.claude'),
      includeHostClaudeContext: true,
    });
    expect(adminPlan.audit.claudeMd).toMatchObject({
      sourcePath: path.join(external, 'CLAUDE.md'),
      runtimePath: '/home/node/.claude/CLAUDE.md',
      status: 'mounted',
    });
    expect(adminPlan.audit.rules).toMatchObject({
      sourcePath: path.join(external, 'rules'),
      runtimePath: '/home/node/.claude/rules',
      status: 'mounted',
      fileCount: 1,
    });
    expect(
      adminPlan.audit.skills.sources.some(
        (source) => source.name === 'external',
      ),
    ).toBe(true);

    const userPlan = buildClaudeContextPlan({
      executionMode: 'container',
      group: fakeGroup('alice-home', 'alice', true) as any,
      ownerHomeFolder: 'alice-home',
      externalClaudeDir: external,
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: path.join(tmp, 'sessions', 'alice-home', '.claude'),
    });
    expect(userPlan.audit.claudeMd.status).toBe('unavailable');
    expect(userPlan.audit.externalClaudeDir).toBeUndefined();
    expect(userPlan.audit.claudeMd.sourcePath).toBeUndefined();
    expect(userPlan.audit.rules.status).toBe('unavailable');
    expect(
      userPlan.audit.skills.sources.some(
        (source) => source.name === 'external',
      ),
    ).toBe(false);
  });

  test('host sync reports skill name conflict across sources', () => {
    const external = path.join(tmp, 'external-claude');
    const dataDir = path.join(tmp, 'data');
    const projectRoot = path.join(tmp, 'project');
    const sessionDir = path.join(tmp, 'sessions', 'main', '.claude');
    const selectedUserSkills = path.join(
      dataDir,
      'agent-profile-runtime',
      'admin',
      'custom-agent',
      'v2',
      'skills',
    );

    writeFile(path.join(external, 'CLAUDE.md'), '# admin');
    // builtin 与 external 都有同名 skill，合并时应记录冲突。
    makeSkill(path.join(dataDir, 'builtin-skills'), 'dup-skill');
    makeSkill(path.join(external, 'skills'), 'dup-skill');
    makeSkill(selectedUserSkills, 'dup-skill');

    const plan = buildClaudeContextPlan({
      executionMode: 'host',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot,
      dataDir,
      groupSessionsDir: sessionDir,
      includeHostClaudeContext: true,
      userSkillsDirOverride: selectedUserSkills,
    });
    const sync = syncHostClaudeContext(plan, sessionDir);

    expect(
      sync.warnings.some((w) => w.includes('skill name conflict: dup-skill')),
    ).toBe(true);
    // Host context is a base layer. The managed user Skill is linked later
    // and therefore remains authoritative for the Agent's selected add-ons.
    expect(fs.readlinkSync(path.join(sessionDir, 'skills', 'dup-skill'))).toBe(
      path.join(selectedUserSkills, 'dup-skill'),
    );
    expect(plan.audit.skills.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'builtin', count: 0 }),
        expect.objectContaining({ name: 'external', count: 0 }),
        expect.objectContaining({ name: 'managed', count: 1 }),
      ]),
    );
  });

  test('managed admin Agent does not inherit host context without explicit opt-in', () => {
    const external = path.join(tmp, 'external-claude');
    const dataDir = path.join(tmp, 'data');
    const projectRoot = path.join(tmp, 'project');
    writeFile(path.join(external, 'CLAUDE.md'), '# private admin context');
    writeFile(path.join(external, 'commands', 'private.md'), '# private');
    makeSkill(path.join(external, 'skills'), 'private-host-skill');
    makeSkill(path.join(dataDir, 'builtin-skills'), 'builtin-skill');
    makeSkill(path.join(projectRoot, 'container', 'skills'), 'project-skill');
    makeSkill(path.join(dataDir, 'skills', 'admin'), 'user-skill');

    const plan = buildClaudeContextPlan({
      executionMode: 'host',
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot,
      dataDir,
      groupSessionsDir: path.join(tmp, 'sessions', 'main', '.claude'),
    });

    expect(plan.claudeMdSource).toBeUndefined();
    expect(plan.rulesSourceDir).toBeUndefined();
    expect(plan.externalSkillsDir).toBeUndefined();
    expect(plan.audit.claudeMd.status).toBe('unavailable');
    expect(plan.audit.skills.sources.map((source) => source.name)).toEqual([
      'builtin',
      'project',
      'managed',
      'workspace',
    ]);
  });

  test('managed context can select host Skills without linking host prompts or rules', () => {
    const external = path.join(tmp, 'external-claude');
    const sessionDir = path.join(tmp, 'sessions', 'selected-host', '.claude');
    writeFile(path.join(external, 'CLAUDE.md'), '# must stay isolated');
    writeFile(
      path.join(external, 'rules', 'global.md'),
      '# must stay isolated',
    );
    makeSkill(path.join(external, 'skills'), 'selected-host-skill');
    makeSkill(path.join(external, 'skills'), 'unselected-host-skill');

    const plan = buildClaudeContextPlan({
      executionMode: 'host',
      group: fakeGroup('selected-host', 'admin') as any,
      externalClaudeDir: external,
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: sessionDir,
      includeHostClaudeContext: false,
      hostSkillPolicy: {
        mode: 'custom',
        ids: ['selected-host-skill'],
      },
    });
    syncHostClaudeContext(plan, sessionDir);

    expect(plan.claudeMdSource).toBeUndefined();
    expect(plan.rulesSourceDir).toBeUndefined();
    expect(plan.audit.claudeMd.status).toBe('unavailable');
    expect(plan.effectiveSkills.selected.map((skill) => skill.id)).toContain(
      'selected-host-skill',
    );
    expect(
      plan.effectiveSkills.selected.map((skill) => skill.id),
    ).not.toContain('unselected-host-skill');
    expect(fs.existsSync(path.join(sessionDir, 'CLAUDE.md'))).toBe(false);
    expect(fs.readdirSync(path.join(sessionDir, 'rules'))).toEqual([]);
    expect(
      fs.readlinkSync(path.join(sessionDir, 'skills', 'selected-host-skill')),
    ).toBe(path.join(external, 'skills', 'selected-host-skill'));
  });

  test('host context opt-in works for an admin whose home folder is not main', () => {
    const external = path.join(tmp, 'external-claude');
    writeFile(path.join(external, 'CLAUDE.md'), '# second admin');
    makeSkill(path.join(external, 'skills'), 'second-admin-skill');

    const plan = buildClaudeContextPlan({
      executionMode: 'container',
      group: fakeGroup('home-admin-2', 'admin-2', true) as any,
      ownerHomeFolder: 'home-admin-2',
      externalClaudeDir: external,
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: path.join(tmp, 'sessions', 'home-admin-2', '.claude'),
      includeHostClaudeContext: true,
    });

    expect(plan.claudeMdSource).toBe(path.join(external, 'CLAUDE.md'));
    expect(plan.audit.externalClaudeDir).toBe(external);
    expect(
      plan.audit.skills.sources.some((source) => source.name === 'external'),
    ).toBe(true);
  });

  test('switching away from host_claude removes its linked context only', () => {
    const external = path.join(tmp, 'external-claude');
    const sessionDir = path.join(tmp, 'sessions', 'main', '.claude');
    writeFile(path.join(external, 'CLAUDE.md'), '# private admin context');
    writeFile(path.join(external, 'commands', 'private.md'), '# private');

    const base = {
      executionMode: 'host' as const,
      group: fakeGroup('main', 'admin', true) as any,
      ownerHomeFolder: 'main',
      externalClaudeDir: external,
      projectRoot: path.join(tmp, 'project'),
      dataDir: path.join(tmp, 'data'),
      groupSessionsDir: sessionDir,
    };
    syncHostClaudeContext(
      buildClaudeContextPlan({ ...base, includeHostClaudeContext: true }),
      sessionDir,
    );
    expect(
      fs.lstatSync(path.join(sessionDir, 'CLAUDE.md')).isSymbolicLink(),
    ).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, 'commands'))).toBe(true);

    syncHostClaudeContext(buildClaudeContextPlan(base), sessionDir);
    expect(fs.existsSync(path.join(sessionDir, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(sessionDir, 'commands'))).toBe(false);
    expect(loadHostClaudeSettings(buildClaudeContextPlan(base))).toEqual({});

    writeFile(path.join(sessionDir, 'CLAUDE.md'), '# session-authored');
    syncHostClaudeContext(buildClaudeContextPlan(base), sessionDir);
    expect(fs.readFileSync(path.join(sessionDir, 'CLAUDE.md'), 'utf8')).toBe(
      '# session-authored',
    );
  });
});
