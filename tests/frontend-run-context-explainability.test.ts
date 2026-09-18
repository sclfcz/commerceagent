import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const read = (file: string) =>
  fs.readFileSync(path.join(process.cwd(), file), 'utf8');

describe('Agent runtime context explainability', () => {
  test('records actual context audits server-side without publishing them to chat', () => {
    const web = read('src/web.ts');
    const store = read('web/src/stores/chat.ts');

    expect(web).toContain('recordRunContextSnapshot({');
    expect(web).toMatch(
      /if \(event\.eventType === 'context_audit'\)[\s\S]*recordRunContextSnapshot\([\s\S]*return;/,
    );
    expect(store).toContain("if (event.eventType === 'context_audit') return;");
  });

  test('shows prompt provenance, real Skill usage, and total SDK budget per workspace', () => {
    const preview = read(
      'web/src/components/agents/EffectiveCapabilitiesPreview.tsx',
    );

    expect(preview).toContain('run_context: RunContextSnapshot | null');
    expect(preview).toContain('最近真实运行');
    expect(preview).toContain('总上下文');
    expect(preview).toContain('Prompt Plan');
    expect(preview).toContain('snapshot.skills.included');
    expect(preview).toContain('snapshot.skills.manifestHash');
    expect(preview).toContain('usage.mcpTools.length');
    expect(preview).toContain('来自旧智能体配置');
    expect(preview).toContain('snapshot.subagentContract');
  });
});
