import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
  pluginSkillLayers,
  reconcileSessionSkills,
  resolveEffectiveSkills,
} from '../src/effective-skill-resolver.js';
import { buildClaudeContextPlan } from '../src/claude-context-resolver.js';

let root: string;

function skill(
  layer: string,
  id: string,
  options: { disabled?: boolean; body?: string } = {},
): string {
  const directory = path.join(root, layer, id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, options.disabled ? 'SKILL.md.disabled' : 'SKILL.md'),
    options.body ?? `# ${layer}/${id}`,
  );
  return directory;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'effective-skills-'));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('EffectiveSkillResolver', () => {
  test('disabled managed collision does not shadow enabled project Skill', () => {
    const project = path.join(root, 'project');
    const managed = path.join(root, 'managed');
    skill('project', 'foo');
    skill('managed', 'foo', { disabled: true });

    const manifest = resolveEffectiveSkills({
      layers: [
        { source: 'project', root: project },
        { source: 'managed', root: managed },
      ],
      managedPolicy: { mode: 'inherit' },
    });

    expect(manifest.selected).toMatchObject([
      { id: 'foo', source: 'project', path: path.join(project, 'foo') },
    ]);
    expect(
      manifest.candidates.find((candidate) => candidate.source === 'managed'),
    ).toMatchObject({ enabled: false, excludedReason: 'disabled' });
  });

  test.each([
    ['inherit', ['alpha', 'beta']],
    ['custom', ['beta']],
    ['disabled', []],
  ] as const)('managed %s policy selects the expected ids', (mode, ids) => {
    const managed = path.join(root, 'managed');
    skill('managed', 'alpha');
    skill('managed', 'beta');
    const manifest = resolveEffectiveSkills({
      layers: [{ source: 'managed', root: managed }],
      managedPolicy:
        mode === 'custom' ? { mode, ids: ['beta'] } : { mode, ids: [] },
    });
    expect(manifest.selected.map((entry) => entry.id)).toEqual(ids);
  });

  test.each([
    ['inherit', ['alpha', 'beta']],
    ['custom', ['beta']],
    ['disabled', []],
  ] as const)('host %s policy selects the expected ids', (mode, ids) => {
    const host = path.join(root, 'host');
    skill('host', 'alpha');
    skill('host', 'beta');
    const manifest = resolveEffectiveSkills({
      layers: [{ source: 'host', root: host }],
      hostPolicy:
        mode === 'custom' ? { mode, ids: ['beta'] } : { mode, ids: [] },
    });

    expect(manifest.selected.map((entry) => entry.id)).toEqual(ids);
    expect(manifest.hostPolicy).toEqual({
      mode,
      ids: mode === 'custom' ? ['beta'] : [],
    });
  });

  test('host policy participates in the manifest hash and reports missing selections', () => {
    const host = path.join(root, 'host');
    skill('host', 'available');
    const all = resolveEffectiveSkills({
      layers: [{ source: 'host', root: host }],
      hostPolicy: { mode: 'inherit', ids: [] },
    });
    const selected = resolveEffectiveSkills({
      layers: [{ source: 'host', root: host }],
      hostPolicy: { mode: 'custom', ids: ['available', 'missing'] },
    });

    expect(selected.hash).not.toBe(all.hash);
    expect(selected.missingHostSkillIds).toEqual(['missing']);
  });

  test('real session ghost is quarantined and cannot survive reconciliation', () => {
    const managed = path.join(root, 'managed');
    const selected = skill('managed', 'selected');
    const session = path.join(root, 'session', '.claude');
    skill(path.relative(root, path.join(session, 'skills')), 'ghost');
    const manifest = resolveEffectiveSkills({
      layers: [{ source: 'managed', root: managed }],
    });

    const result = reconcileSessionSkills(session, manifest, {
      materializeLinks: true,
    });

    expect(result.quarantined).toEqual(['ghost']);
    expect(fs.existsSync(path.join(session, 'skills', 'ghost'))).toBe(false);
    expect(fs.readlinkSync(path.join(session, 'skills', 'selected'))).toBe(
      selected,
    );
    expect(
      fs.existsSync(path.join(result.quarantineDir!, 'ghost', 'SKILL.md')),
    ).toBe(true);
  });

  test('plugin Skills use qualified ids and remain plugin-owned', () => {
    const pluginRoot = path.join(root, 'plugins', 'review-kit');
    skill(path.relative(root, path.join(pluginRoot, 'skills')), 'review');
    const manifest = resolveEffectiveSkills({
      layers: pluginSkillLayers([{ type: 'local', path: pluginRoot }]),
    });
    const session = path.join(root, 'session-plugin', '.claude');

    reconcileSessionSkills(session, manifest, { materializeLinks: true });

    expect(manifest.selected).toMatchObject([
      { id: 'review-kit:review', source: 'plugin' },
    ]);
    expect(fs.readdirSync(path.join(session, 'skills'))).toEqual([]);
  });

  test('host and container plans produce the same selected ids and hash', () => {
    const dataDir = path.join(root, 'data');
    const projectRoot = path.join(root, 'repo');
    skill(path.relative(root, path.join(dataDir, 'builtin-skills')), 'base');
    skill(
      path.relative(root, path.join(projectRoot, 'container', 'skills')),
      'project',
    );
    skill(
      path.relative(root, path.join(dataDir, 'skills', 'owner')),
      'managed',
    );
    skill(
      path.relative(root, path.join(dataDir, 'skills', 'owner')),
      'managed-filtered',
    );
    skill(
      path.relative(
        root,
        path.join(dataDir, 'groups', 'workspace', '.claude', 'skills'),
      ),
      'workspace',
    );
    const pluginRoot = path.join(root, 'runtime', 'review-plugin');
    skill(
      path.relative(root, path.join(pluginRoot, 'skills')),
      'review-helper',
    );
    const common = {
      group: {
        name: 'workspace',
        folder: 'workspace',
        added_at: '',
        created_by: 'owner',
      } as any,
      externalClaudeDir: path.join(root, 'external'),
      projectRoot,
      dataDir,
      groupSessionsDir: path.join(root, 'sessions', '.claude'),
      managedSkillPolicy: { mode: 'custom' as const, ids: ['managed'] },
      pluginSkillLayers: pluginSkillLayers([
        { type: 'local' as const, path: pluginRoot },
      ]),
    };

    const hostPlan = buildClaudeContextPlan({
      ...common,
      executionMode: 'host',
    });
    const containerPlan = buildClaudeContextPlan({
      ...common,
      executionMode: 'container',
    });
    const host = hostPlan.effectiveSkills;
    const container = containerPlan.effectiveSkills;

    expect(container.selected.map((entry) => entry.id)).toEqual(
      host.selected.map((entry) => entry.id),
    );
    expect(container.hash).toBe(host.hash);
    expect(host.selected.map((entry) => entry.id)).toContain(
      'review-plugin:review-helper',
    );
    expect(containerPlan.audit.skills.sources).toContainEqual(
      expect.objectContaining({
        name: 'plugin',
        runtimePath: 'options.plugins',
        count: 1,
      }),
    );
    expect(containerPlan.audit.skills.sources).toContainEqual(
      expect.objectContaining({ name: 'managed', count: 1 }),
    );
    expect(container.selected.map((entry) => entry.id)).not.toContain(
      'managed-filtered',
    );
  });

  test('manifest hash changes when an executable Skill payload changes', () => {
    const managed = path.join(root, 'managed');
    const directory = skill('managed', 'scripted');
    fs.mkdirSync(path.join(directory, 'scripts'), { recursive: true });
    const scriptPath = path.join(directory, 'scripts', 'run.js');
    fs.writeFileSync(scriptPath, 'export const result = 1;\n');

    const first = resolveEffectiveSkills({
      layers: [{ source: 'managed', root: managed }],
    });
    fs.writeFileSync(scriptPath, 'export const result = 2;\n');
    const changed = resolveEffectiveSkills({
      layers: [{ source: 'managed', root: managed }],
    });

    expect(changed.hash).not.toBe(first.hash);
    expect(changed.selected[0].definitionHash).not.toBe(
      first.selected[0].definitionHash,
    );
  });
});
