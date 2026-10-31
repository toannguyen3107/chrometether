import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectAgents, getConfiguredServers } from '../src/installer/agent-detector.js';
import { withTempHome } from './helpers/temp-home.js';

test('antigravity is not detected in an empty home', async () => {
  await withTempHome({}, () => {
    const agy = detectAgents().find(a => a.id === 'antigravity');
    assert.equal(agy.isDetected, false);
    assert.equal(agy.isConfigured, false);
  });
});

test('antigravity is detected but not configured when .gemini/antigravity exists alone', async () => {
  await withTempHome({ '.gemini/antigravity': null }, () => {
    const agy = detectAgents().find(a => a.id === 'antigravity');
    assert.equal(agy.isDetected, true);
    assert.equal(agy.isConfigured, false);
    assert.equal(agy.pluginInstalled, false);
  });
});

test('antigravity with only built-in chrome_devtools is partially configured, not fully configured', async () => {
  await withTempHome(
    {
      '.gemini/config/mcp_config.json': {
        mcpServers: { chrome_devtools: { command: 'node', args: [] } }
      }
    },
    () => {
      const agy = detectAgents().find(a => a.id === 'antigravity');
      assert.equal(agy.isDetected, true);
      assert.equal(agy.isConfigured, false);
      assert.equal(agy.isPartiallyConfigured, true);
      assert.deepEqual(agy.configuredServers, ['chrome_devtools']);
    }
  );
});

test('antigravity is configured when tether-reader and tether-map are in global mcp_config.json', async () => {
  await withTempHome(
    {
      '.gemini/config/mcp_config.json': {
        mcpServers: {
          chrome_devtools: {},
          'tether-reader': {},
          'tether-map': {}
        }
      }
    },
    () => {
      const agy = detectAgents().find(a => a.id === 'antigravity');
      assert.equal(agy.isConfigured, true);
      assert.ok(agy.configuredServers.includes('tether-reader'));
      assert.ok(agy.configuredServers.includes('tether-map'));
    }
  );
});

test('antigravity is configured when tether servers are in plugin mcp_config.json', async () => {
  await withTempHome(
    {
      '.gemini/antigravity': null,
      '.gemini/config/plugins/agy-browser/plugin.json': { name: 'agy-browser' },
      '.gemini/config/plugins/agy-browser/mcp_config.json': {
        mcpServers: { 'tether-reader': {}, 'tether-map': {} }
      }
    },
    () => {
      const agy = detectAgents().find(a => a.id === 'antigravity');
      assert.equal(agy.isConfigured, true);
      assert.equal(agy.pluginInstalled, true);
    }
  );
});

test('plugin manifest alone never marks antigravity as configured', async () => {
  await withTempHome(
    {
      '.gemini/config/plugins/agy-browser/plugin.json': { name: 'agy-browser' }
    },
    () => {
      const agy = detectAgents().find(a => a.id === 'antigravity');
      assert.equal(agy.isConfigured, false);
      assert.deepEqual(agy.configuredServers, []);
    }
  );
});

test('dsh yaml patch detection extracts normalized server names', async () => {
  const yml = `# dsh profile patch
- insert:
    - id: mcp-tether-reader
      name: '@deepseek-ai/dsh-mcp-client'
    - id: mcp-chrome-devtools
      name: '@deepseek-ai/dsh-mcp-client'
`;
  await withTempHome({ '.dsh/profiles/web/cordis.patch.yml': yml }, () => {
    const dsh = detectAgents().find(a => a.id === 'dsh');
    assert.equal(dsh.isConfigured, true);
    assert.deepEqual(dsh.configuredServers, ['tether-reader', 'chrome-devtools']);
  });
});

test('opencode JSONC with comments and trailing commas is detected as configured', async () => {
  const jsonc = `{
    // OpenCode config
    "mcp": {
      "tether-reader": { "type": "local", "command": ["node", "index.js"], },
    },
  }`;
  await withTempHome({ '.config/opencode/opencode.jsonc': jsonc }, () => {
    const oc = detectAgents().find(a => a.id === 'opencode');
    assert.equal(oc.isConfigured, true);
  });
});

test('malformed JSON config does not throw and reports not configured', async () => {
  await withTempHome({ '.cursor/mcp.json': '{ oops' }, () => {
    const cursor = detectAgents().find(a => a.id === 'cursor');
    assert.equal(cursor.isDetected, true);
    assert.equal(cursor.isConfigured, false);
  });
});

test('getConfiguredServers handles standard, zcode, and garbage inputs safely', () => {
  assert.deepEqual(
    getConfiguredServers('{"mcpServers":{"tether-reader":{}}}', 'standard'),
    ['tether-reader']
  );
  assert.deepEqual(
    getConfiguredServers('{"mcp":{"servers":{"tether-map":{}}}}', 'zcode'),
    ['tether-map']
  );
  assert.deepEqual(getConfiguredServers('', 'standard'), []);
  assert.deepEqual(getConfiguredServers('{invalid', 'standard'), []);
});
