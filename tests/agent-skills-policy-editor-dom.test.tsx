// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PolicyModeCards } from '../web/src/components/agents/AgentSkillsPolicyEditor';
import type { RuntimePolicyMode } from '../web/src/utils/agent-runtime-policy';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const options = [
  {
    value: 'disabled' as const,
    label: '不使用',
    description: '不加载宿主机 Skill。',
  },
  {
    value: 'custom' as const,
    label: '选择部分',
    description: '只加载明确选择的宿主机 Skills。',
  },
  {
    value: 'inherit' as const,
    label: '全部使用',
    description: '现在和以后新增的宿主机 Skills 都会生效。',
  },
];

function Harness({ onSubmit }: { onSubmit: () => void }) {
  const [mode, setMode] = useState<RuntimePolicyMode>('custom');
  return (
    <main data-testid="agent-profile-page">
      <h1>智能体设置</h1>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <PolicyModeCards
          label="宿主机 Skills 使用方式"
          value={mode}
          onChange={setMode}
          options={options}
        />
      </form>
    </main>
  );
}

describe('宿主机 Skills 模式卡片', () => {
  test('点击全部使用不会提交表单、导航或清空页面', () => {
    const submit = vi.fn();
    window.history.replaceState(
      null,
      '',
      '/agent-profiles?agent=research#agent-capabilities',
    );
    const before = window.location.href;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<Harness onSubmit={submit} />));

    const all = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    ).find((button) => button.textContent?.includes('全部使用'));
    expect(all).toBeDefined();
    expect(all?.type).toBe('button');

    act(() => all?.click());

    expect(submit).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    expect(all?.getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('h1')?.textContent).toBe('智能体设置');
    expect(container.textContent).toContain('全部使用');
  });

  test('支持 radiogroup 方向键切换和 roving tabIndex', () => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root?.render(<Harness onSubmit={vi.fn()} />));

    const radios = Array.from(
      container.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
    );
    const custom = radios.find((button) =>
      button.textContent?.includes('选择部分'),
    )!;
    const all = radios.find((button) =>
      button.textContent?.includes('全部使用'),
    )!;
    expect(custom.tabIndex).toBe(0);
    expect(all.tabIndex).toBe(-1);

    custom.focus();
    act(() => {
      custom.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowRight',
          bubbles: true,
        }),
      );
    });

    expect(all.getAttribute('aria-checked')).toBe('true');
    expect(all.tabIndex).toBe(0);
    expect(custom.tabIndex).toBe(-1);
  });
});
