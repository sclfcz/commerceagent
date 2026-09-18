import { beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

vi.mock('../web/src/api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { api } from '../web/src/api/client';
import {
  useMcpServersStore,
  type McpServer,
} from '../web/src/stores/mcp-servers';
import {
  buildMcpPolicyOptions,
  mcpServerEndpoint,
  normalizeMcpPolicyReferences,
  normalizeMcpServers,
  parseMcpSourceKey,
} from '../web/src/utils/mcp-servers';

const server = (overrides: Partial<McpServer> = {}): McpServer => ({
  id: 'github',
  source: 'user',
  sourceKey: 'user:github',
  readonly: false,
  conflictSources: ['user'],
  effective: true,
  command: 'npx',
  enabled: true,
  addedAt: '2026-07-14T00:00:00.000Z',
  ...overrides,
});

describe('source-qualified MCP frontend behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMcpServersStore.setState({
      servers: [],
      loading: false,
      error: null,
      syncing: false,
    });
  });

  test('keeps same-name system and user definitions distinct and marks user effective', () => {
    const normalized = normalizeMcpServers([
      server({
        source: 'system',
        sourceKey: 'system:github',
        readonly: true,
      }),
      server(),
    ]);

    expect(normalized).toHaveLength(2);
    expect(normalized.map((item) => item.sourceKey)).toEqual([
      'system:github',
      'user:github',
    ]);
    expect(normalized[0]).toMatchObject({
      conflictSources: ['system', 'user'],
      effective: false,
    });
    expect(normalized[1]).toMatchObject({
      conflictSources: ['system', 'user'],
      effective: true,
    });
  });

  test('falls back to enabled system definition when same-name user MCP is disabled', () => {
    const normalized = normalizeMcpServers([
      server({ source: 'system', sourceKey: 'system:github' }),
      server({ enabled: false }),
    ]);
    expect(normalized[0].effective).toBe(true);
    expect(normalized[1].effective).toBe(false);
  });

  test('builds source-qualified endpoints and migrates historical bare policy ids', () => {
    expect(parseMcpSourceKey('system:git/hub')).toEqual({
      source: 'system',
      id: 'git/hub',
    });
    expect(mcpServerEndpoint('system:git/hub')).toBe(
      '/api/mcp-servers/git%2Fhub?source=system',
    );
    expect(normalizeMcpPolicyReferences(['legacy', 'system:platform'])).toEqual(
      ['user:legacy', 'system:platform'],
    );
  });

  test('loads both source layers without overwriting equal ids', async () => {
    vi.mocked(api.get).mockResolvedValue({
      servers: [
        server({
          source: 'system',
          sourceKey: 'system:github',
          readonly: true,
        }),
        server(),
      ],
    });

    await useMcpServersStore.getState().loadServers();

    expect(api.get).toHaveBeenCalledWith('/api/mcp-servers');
    expect(
      useMcpServersStore.getState().servers.map((item) => item.sourceKey),
    ).toEqual(['system:github', 'user:github']);
  });

  test('passes scope on create and source on detail, update, toggle and delete', async () => {
    vi.mocked(api.post).mockResolvedValue({ server: server() });
    vi.mocked(api.get)
      .mockResolvedValueOnce({ servers: [] })
      .mockResolvedValueOnce({ server: server() })
      .mockResolvedValue({ servers: [] });
    vi.mocked(api.patch).mockResolvedValue({ success: true });
    vi.mocked(api.delete).mockResolvedValue({ success: true });

    const store = useMcpServersStore.getState();
    await store.addServer({
      id: 'platform',
      scope: 'system',
      command: 'platform-mcp',
      memberAccess: 'admin_only',
    });
    expect(api.post).toHaveBeenCalledWith('/api/mcp-servers', {
      id: 'platform',
      scope: 'system',
      command: 'platform-mcp',
      memberAccess: 'admin_only',
    });

    await store.getServer('system:platform');
    expect(api.get).toHaveBeenCalledWith(
      '/api/mcp-servers/platform?source=system',
    );

    await store.updateServer('system:platform', { description: 'shared' });
    expect(api.patch).toHaveBeenCalledWith(
      '/api/mcp-servers/platform?source=system',
      { description: 'shared' },
    );

    await store.toggleServer('user:github', false);
    expect(api.patch).toHaveBeenCalledWith(
      '/api/mcp-servers/github?source=user',
      { enabled: false },
    );

    await store.deleteServer('user:github');
    expect(api.delete).toHaveBeenCalledWith(
      '/api/mcp-servers/github?source=user',
    );
  });

  test('Agent picker values are sourceKeys and imported host copies stay user-scoped', () => {
    const options = buildMcpPolicyOptions(
      normalizeMcpServers([
        server({ source: 'system', sourceKey: 'system:github' }),
        server({ importedFromHost: true }),
      ]),
    );

    expect(options.map((option) => option.id)).toEqual([
      'system:github',
      'user:github',
    ]);
    expect(options[1].name).toContain('我的');
  });

  test('excludes admin-only system MCP from member Agent policy options', () => {
    const options = buildMcpPolicyOptions(
      normalizeMcpServers([
        server({
          source: 'system',
          sourceKey: 'system:private',
          memberAccess: 'admin_only',
          runtimeAvailable: false,
        }),
        server({
          id: 'shared',
          source: 'system',
          sourceKey: 'system:shared',
          memberAccess: 'shared',
          runtimeAvailable: true,
        }),
      ]),
    );

    expect(options.map((option) => option.id)).toEqual(['system:shared']);
  });

  test('system create/edit forms expose explicit access choices and warn about full runtime config', () => {
    const addDialog = fs.readFileSync(
      path.join(
        process.cwd(),
        'web/src/components/mcp-servers/AddMcpServerDialog.tsx',
      ),
      'utf8',
    );
    const detail = fs.readFileSync(
      path.join(
        process.cwd(),
        'web/src/components/mcp-servers/McpServerDetail.tsx',
      ),
      'utf8',
    );

    for (const source of [addDialog, detail]) {
      expect(source).toContain("['admin_only', '仅管理员'");
      expect(source).toContain("['shared', '共享给成员'");
      expect(source).toContain('完整 command、args、url、env 和 headers');
    }
    expect(addDialog).toContain("scope === 'system'");
    expect(detail).toContain("server.source === 'system'");
    expect(addDialog).toContain(
      "...(scope === 'system' ? { memberAccess } : {})",
    );
    expect(detail).toContain("...(server.source === 'system'");
  });

  test('toggle failures preserve the loaded list and reject for row-level feedback', async () => {
    const current = server();
    useMcpServersStore.setState({
      servers: [current],
      error: null,
    });
    vi.mocked(api.patch).mockRejectedValue(new Error('connection refused'));

    await expect(
      useMcpServersStore.getState().toggleServer(current.sourceKey, false),
    ).rejects.toThrow('connection refused');

    expect(useMcpServersStore.getState()).toMatchObject({
      servers: [current],
      error: null,
    });
  });

  test('renders selection and toggle as sibling native controls', () => {
    const filePath = path.join(
      process.cwd(),
      'web/src/components/mcp-servers/McpServerCard.tsx',
    );
    const source = ts.createSourceFile(
      filePath,
      fs.readFileSync(filePath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const nativeButtons: ts.JsxElement[] = [];
    const switches: ts.JsxSelfClosingElement[] = [];
    const customButtonRoles: ts.JsxAttribute[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isJsxElement(node) &&
        node.openingElement.tagName.getText(source) === 'button'
      ) {
        nativeButtons.push(node);
      }
      if (
        ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText(source) === 'Switch'
      ) {
        switches.push(node);
      }
      if (ts.isJsxAttribute(node) && node.name.getText(source) === 'role') {
        const value = node.initializer?.getText(source).replaceAll('"', '');
        if (value === 'button') customButtonRoles.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(nativeButtons).toHaveLength(1);
    expect(switches).toHaveLength(1);
    expect(customButtonRoles).toHaveLength(0);
    expect(
      nativeButtons[0].openingElement.attributes.properties.some(
        (attribute) =>
          ts.isJsxAttribute(attribute) &&
          attribute.name.getText(source) === 'aria-pressed',
      ),
    ).toBe(true);

    let ancestor: ts.Node | undefined = switches[0].parent;
    while (ancestor) {
      expect(nativeButtons).not.toContain(ancestor);
      ancestor = ancestor.parent;
    }
  });
});
