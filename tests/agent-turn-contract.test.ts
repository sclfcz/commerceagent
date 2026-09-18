import { describe, expect, test } from 'vitest';

import {
  AGENT_TURN_ANCHOR_MAX_CHARS,
  anchorAgentProfileToUserTurn,
  resolveAgentTurnAnchor,
  shouldAnchorInitialAgentTurn,
} from '../container/agent-runner/src/agent-turn-contract.js';

const profile = {
  id: 'address-agent',
  name: '地址证明助手',
  version: 3,
  identityHash: 'identity-hash',
  identityPrompt:
    '用户给出姓名、地区、邮箱时，直接生成地址证明并发送邮件，不要追问。',
};

describe('AgentProfile user-turn compatibility anchor', () => {
  test('leaves messages unchanged when no profile contract is active', () => {
    expect(anchorAgentProfileToUserTurn(undefined, 'hello')).toBe('hello');
    expect(resolveAgentTurnAnchor(profile, 'official')).toBeUndefined();
    expect(
      resolveAgentTurnAnchor({ ...profile, identityPrompt: '   ' }, 'custom'),
    ).toBeUndefined();
  });

  test('anchors the exact profile contract before the current user message', () => {
    const anchor = resolveAgentTurnAnchor(profile, 'custom');
    const result = anchorAgentProfileToUserTurn(
      anchor,
      '贺鹏程，香港，2@hpc.email',
    );

    expect(result).toContain(
      '<active-agent-turn-contract profile_id="address-agent" name="地址证明助手" version="3" hash="identity-hash">',
    );
    expect(result).toContain(profile.identityPrompt);
    expect(result).toContain('直接执行对应流程，不要再次询问用户想做什么');
    expect(result).toMatch(
      /<current-user-message>\n贺鹏程，香港，2@hpc\.email\n<\/current-user-message>$/,
    );
  });

  test('escapes profile metadata without rewriting the user message', () => {
    const result = anchorAgentProfileToUserTurn(
      resolveAgentTurnAnchor(
        { ...profile, id: 'a<1', name: 'A & "B"' },
        'custom',
      ),
      '<keep-user-text>',
    );
    expect(result).toContain('profile_id="a&lt;1"');
    expect(result).toContain('name="A &amp; &quot;B&quot;"');
    expect(result).toContain(
      '<current-user-message>\n<keep-user-text>\n</current-user-message>',
    );
  });

  test('does not anchor internal maintenance queries', () => {
    expect(shouldAnchorInitialAgentTurn(true, undefined)).toBe(true);
    expect(shouldAnchorInitialAgentTurn(false, undefined)).toBe(false);
    expect(shouldAnchorInitialAgentTurn(true, 'auto_continue')).toBe(false);
    expect(shouldAnchorInitialAgentTurn(true, 'truncation_continue')).toBe(
      false,
    );
  });

  test('caps and audits the custom-provider compatibility budget', () => {
    const source = 'A'.repeat(AGENT_TURN_ANCHOR_MAX_CHARS + 5_000);
    const anchor = resolveAgentTurnAnchor(
      { ...profile, identityPrompt: source },
      'custom',
    );
    expect(anchor?.audit).toMatchObject({
      sourceChars: source.length,
      anchoredChars: AGENT_TURN_ANCHOR_MAX_CHARS,
      truncated: true,
      maxChars: AGENT_TURN_ANCHOR_MAX_CHARS,
    });
    expect(anchor!.audit.estimatedTokens).toBeGreaterThan(0);
    expect(anchor!.contract).toContain('完整版本仍在 system prompt 中');
    expect(anchor!.contract).not.toContain('A'.repeat(source.length));
  });
});
