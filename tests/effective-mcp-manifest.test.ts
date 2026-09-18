import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  buildEffectiveMcpManifest,
  loadPluginMcpDefinitions,
} from '../src/effective-mcp-manifest.js';

describe('Effective MCP Manifest', () => {
  test('is order-stable and changes for add, remove, or definition changes', () => {
    const first = buildEffectiveMcpManifest({
      alpha: { command: 'alpha', args: ['one'], env: { TOKEN: 'secret-a' } },
      beta: { type: 'http', url: 'https://example.test/mcp' },
    });
    const reordered = buildEffectiveMcpManifest({
      beta: { url: 'https://example.test/mcp', type: 'http' },
      alpha: { env: { TOKEN: 'secret-a' }, args: ['one'], command: 'alpha' },
    });
    const changedDefinition = buildEffectiveMcpManifest({
      alpha: { command: 'alpha', args: ['two'], env: { TOKEN: 'secret-a' } },
      beta: { type: 'http', url: 'https://example.test/mcp' },
    });
    const removed = buildEffectiveMcpManifest({
      alpha: { command: 'alpha', args: ['one'], env: { TOKEN: 'secret-a' } },
    });

    expect(reordered).toEqual(first);
    expect(changedDefinition.hash).not.toBe(first.hash);
    expect(removed.hash).not.toBe(first.hash);
    expect(first.serverIds).toEqual(['alpha', 'beta']);
  });

  test('includes plugin-only MCP discovery and changes with its definition', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-mcp-'));
    const plugin = path.join(root, 'market', 'search-plugin');
    fs.mkdirSync(plugin, { recursive: true });
    const config = path.join(plugin, '.mcp.json');
    fs.writeFileSync(
      config,
      JSON.stringify({ search: { command: 'search-v1' } }),
    );
    try {
      const first = buildEffectiveMcpManifest(
        loadPluginMcpDefinitions([{ type: 'local', path: plugin }]),
      );
      fs.writeFileSync(
        config,
        JSON.stringify({ search: { command: 'search-v2' } }),
      );
      const changed = buildEffectiveMcpManifest(
        loadPluginMcpDefinitions([{ type: 'local', path: plugin }]),
      );

      expect(first.serverIds).toEqual(['plugin:market/search-plugin:search']);
      expect(changed.hash).not.toBe(first.hash);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
