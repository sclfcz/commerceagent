import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import { AppearanceConfigSchema } from '../src/schemas.js';
import { resolveAgentDisplayIdentity } from '../web/src/utils/agent-identity.js';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf-8');

describe('frontend identity ownership', () => {
  test('uses the active Agent name ahead of historical sender labels', () => {
    expect(
      resolveAgentDisplayIdentity({
        agentName: '代码审查员',
        messageSenderName: 'Legacy bot',
      }),
    ).toMatchObject({
      name: '代码审查员',
      imageUrl: expect.stringContaining('icons/commerceagent-icon.png'),
      fallbackChar: '代',
    });
  });

  test('uses the branded avatar as the final global fallback', () => {
    expect(resolveAgentDisplayIdentity()).toMatchObject({
      name: 'CommerceAgent',
      imageUrl: expect.stringContaining('icons/commerceagent-icon.png'),
    });
  });

  test('inherits the main avatar unless a custom Agent overrides it', () => {
    expect(
      resolveAgentDisplayIdentity({
        agentName: '代码审查员',
        mainAvatarUrl: '/api/auth/avatars/system-agent-main.png',
        mainAvatarEmoji: '🐱',
        mainAvatarColor: '#123456',
      }),
    ).toMatchObject({
      imageUrl: '/api/auth/avatars/system-agent-main.png',
      emoji: '🐱',
      color: '#123456',
    });
    expect(
      resolveAgentDisplayIdentity({
        agentName: '代码审查员',
        avatarEmoji: '🧑‍💻',
        avatarColor: '#654321',
        mainAvatarUrl: '/api/auth/avatars/system-agent-main.png',
      }),
    ).toMatchObject({
      imageUrl: undefined,
      emoji: '🧑‍💻',
      color: '#654321',
    });
  });

  test('accepts a system-brand-only appearance update', () => {
    expect(
      AppearanceConfigSchema.safeParse({ appName: 'Team Claw' }).success,
    ).toBe(true);
    expect(AppearanceConfigSchema.safeParse({ appName: '' }).success).toBe(
      false,
    );
  });

  test('removes legacy bot appearance editors and reads from chat rendering', () => {
    const profile = read('web/src/components/settings/ProfileSection.tsx');
    const appearance = read(
      'web/src/components/settings/AppearanceSection.tsx',
    );
    const chatSources = [
      'web/src/components/chat/MessageBubble.tsx',
      'web/src/components/chat/MessageList.tsx',
      'web/src/components/chat/StreamingDisplay.tsx',
      'web/src/components/chat/ShareImageDialog.tsx',
    ]
      .map(read)
      .join('\n');

    expect(profile).not.toContain('我的机器人');
    expect(appearance).not.toContain('AI 默认外观');
    expect(chatSources).not.toMatch(/ai_name/);
    expect(chatSources).toContain('mainAvatarUrl');
  });

  test('renders uploaded user images in desktop and mobile account menus', () => {
    expect(read('web/src/components/layout/UnifiedSidebar.tsx')).toContain(
      'imageUrl={user?.avatar_url}',
    );
    expect(read('web/src/pages/ChatPage.tsx')).toContain(
      'imageUrl={user?.avatar_url}',
    );
  });
});
