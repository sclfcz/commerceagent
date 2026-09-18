import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const readAgentProfilesPage = () =>
  fs.readFileSync(
    path.join(process.cwd(), 'web/src/pages/AgentProfilesPage.tsx'),
    'utf8',
  );

describe('Agent creation workspace', () => {
  test('opens creation in the main workspace instead of a compact sidebar panel', () => {
    const page = readAgentProfilesPage();
    const aside = page.slice(page.indexOf('<aside'), page.indexOf('</aside>'));
    const main = page.slice(page.indexOf('<main'));

    expect(aside).toContain('onClick={handleOpenCreatePanel}');
    expect(aside).not.toContain('new-agent-description');
    expect(aside).not.toContain('<Textarea');
    expect(main).toContain('{createPanelOpen && !draftMode ? (');
    expect(main).toContain('id="create-agent-title"');
    expect(main).toContain('id="new-agent-description"');
    expect(main).toContain('AI 生成配置');
    expect(main).toContain('空白创建');
  });

  test('keeps the large creation workspace labelled, responsive, and keyboard accessible', () => {
    const page = readAgentProfilesPage();

    expect(page).toContain('aria-labelledby="create-agent-title"');
    expect(page).toContain('htmlFor="new-agent-description"');
    expect(page).toContain('aria-describedby="new-agent-description-help"');
    expect(page).toContain('min-h-[180px]');
    expect(page).toContain('sm:flex-row');
    expect(page).toContain('focus-visible:ring-2');
  });

  test('routes create links to the same main-workspace entry flow', () => {
    const page = readAgentProfilesPage();
    const createRouteEffect = page.slice(
      page.indexOf("if (searchParams.get('create') !== '1') return;"),
      page.indexOf("if (searchParams.get('create') !== '1') return;") + 450,
    );

    expect(createRouteEffect).toContain('setDraftMode(false)');
    expect(createRouteEffect).toContain('setCreatePanelOpen(true)');
    expect(createRouteEffect).not.toContain('setCurrentPrompts');
  });

  test('protects typed creation intent without warning when the primary action consumes it', () => {
    const page = readAgentProfilesPage();
    const generateHandler = page.slice(
      page.indexOf('const handleGenerateDraft = async () => {'),
      page.indexOf('const handleBlankDraft = () => {'),
    );

    expect(page).toContain(
      'createPanelOpen && !draftMode && createDescription.trim().length > 0',
    );
    expect(page).toContain(
      'const hasUnsavedChanges = editorUnsavedChanges || createDirty',
    );
    expect(generateHandler).toContain('confirmDiscardEditorChanges()');
    expect(generateHandler).not.toContain('confirmDiscardUnsavedChanges()');
  });
});
