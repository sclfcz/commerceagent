import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  createUnsavedNavigationGuard,
  navigationLocationKey,
} from '../web/src/utils/unsaved-navigation';

const current = {
  pathname: '/agent-profiles',
  search: '?agent=reviewer',
  hash: '',
};

describe('Agent profile unsaved navigation guard', () => {
  test('runs inside a data router and wires both SPA and document navigation blockers', () => {
    const app = fs.readFileSync(
      path.join(process.cwd(), 'web/src/App.tsx'),
      'utf8',
    );
    const page = fs.readFileSync(
      path.join(process.cwd(), 'web/src/pages/AgentProfilesPage.tsx'),
      'utf8',
    );

    expect(app).toContain('createBrowserRouter');
    expect(app).toContain('createHashRouter');
    expect(app).toContain('<RouterProvider router={getAppRouter()} />');
    expect(page).toContain('useBlocker(shouldBlockNavigation)');
    expect(page).toContain('useBeforeUnload(');
    expect(page).not.toContain("document.addEventListener('click'");
  });

  test('blocks dirty push, replace, query, hash, back, and forward destinations', () => {
    const guard = createUnsavedNavigationGuard();
    for (const next of [
      { pathname: '/chat', search: '', hash: '' },
      { pathname: '/settings', search: '?tab=profile', hash: '' },
      { pathname: '/agent-profiles', search: '?agent=writer', hash: '' },
      {
        pathname: '/agent-profiles',
        search: '?agent=reviewer',
        hash: '#tools',
      },
    ]) {
      expect(guard.shouldBlock(true, current, next)).toBe(true);
      expect(guard.shouldBlock(false, current, next)).toBe(false);
    }
  });

  test('allows an already-confirmed destination exactly once', () => {
    const guard = createUnsavedNavigationGuard();
    const next = { pathname: '/agent-profiles', search: '?agent=writer' };
    guard.allowNext(next);

    expect(guard.shouldBlock(true, current, next)).toBe(false);
    expect(guard.shouldBlock(true, current, next)).toBe(true);
  });

  test('cancels unused allowances so they cannot leak into later history navigation', () => {
    const guard = createUnsavedNavigationGuard();
    const next = { pathname: '/chat' };
    const token = guard.allowNext(next);
    guard.cancelAllowance(token);

    expect(guard.shouldBlock(true, current, next)).toBe(true);
    expect(guard.shouldBlock(true, current, current)).toBe(false);
    expect(navigationLocationKey(current)).toBe(
      '/agent-profiles?agent=reviewer',
    );
  });

  test('guards restoring a historical prompt version behind the unsaved-changes confirmation', () => {
    const history = fs.readFileSync(
      path.join(
        process.cwd(),
        'web/src/components/agents/AgentPromptVersionHistory.tsx',
      ),
      'utf8',
    );
    const page = fs.readFileSync(
      path.join(process.cwd(), 'web/src/pages/AgentProfilesPage.tsx'),
      'utf8',
    );

    // The version-history component must accept the same guard used by every
    // other mutating handler on the page, and must consult it before
    // committing the restore (i.e. before overwriting the live prompt
    // textareas via onRestored/setCurrentPrompts).
    expect(history).toContain('confirmDiscardUnsavedChanges: () => boolean;');
    const handleRestoreBody = history.slice(
      history.indexOf('const handleRestore'),
      history.indexOf('const handleRestore') + 200,
    );
    expect(handleRestoreBody).toContain(
      'if (!confirmDiscardUnsavedChanges()) return;',
    );

    // The page must wire its shared guard into the component instead of
    // leaving the restore flow to bypass it.
    const versionHistoryUsage = page
      .slice(
        page.indexOf('<AgentPromptVersionHistory'),
        page.indexOf('<AgentPromptVersionHistory') + 600,
      )
      .replace(/\s+/g, ' ');
    expect(versionHistoryUsage).toContain(
      'confirmDiscardUnsavedChanges={ confirmDiscardUnsavedChanges }',
    );
  });
});
