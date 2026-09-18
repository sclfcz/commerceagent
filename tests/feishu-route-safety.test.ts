import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

describe('Feishu route safety integration', () => {
  test('treats a configured resolver returning null as a dropped message', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/feishu.ts'),
      'utf8',
    );

    expect(source).toContain('resolveAdmittedChannelRoute<FeishuMessageMeta>');
    expect(source).toContain(
      'Feishu binding resolver rejected route; dropping message',
    );
    expect(source).not.toContain('agentRouting?.effectiveJid ?? chatJid');
  });

  test('bootstraps an unregistered P2P chat before the route check, so the first-ever DM is not fail-closed forever', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/feishu.ts'),
      'utf8',
    );

    // P2P has no external "bot added" event like groups (onBotAddedToGroup)
    // and no /pair step like other channels, so the first DM must be able
    // to register the chat itself before resolveAdmittedChannelRoute is
    // consulted — otherwise a brand-new chat can never pass the route check
    // that must precede its own registration, dropping every message
    // forever. See channel-admission.ts's "pairing establishes ownership
    // before routing" contract.
    const bootstrapIdx = source.indexOf(
      "if (chatType === 'p2p' && resolveEffectiveChatJid) {",
    );
    const routeCheckIdx = source.indexOf(
      'resolveAdmittedChannelRoute<FeishuMessageMeta>',
    );

    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(routeCheckIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeLessThan(routeCheckIdx);
  });

  test('bootstrap swallows only ChannelRouteRejectedError from the per-account resolveEffectiveChatJid wrapper', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/feishu.ts'),
      'utf8',
    );

    // im-manager wraps resolveEffectiveChatJid per-account and throws
    // ChannelRouteRejectedError instead of returning null for an unbound
    // chat. A bare `!resolveEffectiveChatJid(...)` truthiness check never
    // observes that case — the throw unwinds past the bootstrap block
    // straight to the outer catch, onNewChat never runs, and the chat can
    // never register (every first DM permanently fails-closed). The
    // bootstrap must catch that specific error and treat it as "not yet
    // registered", while still rethrowing anything else.
    expect(source).toContain(
      "import {\n  resolveAdmittedChannelRoute,\n  ChannelRouteRejectedError,\n} from './channel-admission.js';",
    );
    const bootstrapIdx = source.indexOf(
      "if (chatType === 'p2p' && resolveEffectiveChatJid) {",
    );
    expect(bootstrapIdx).toBeGreaterThan(-1);
    const catchIdx = source.indexOf(
      'if (!(err instanceof ChannelRouteRejectedError)) throw err;',
      bootstrapIdx,
    );
    expect(catchIdx).toBeGreaterThan(bootstrapIdx);
  });
});
