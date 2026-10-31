import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const serverPath = fileURLToPath(new URL('../src/reader-server/index.js', import.meta.url));

function createMcpClient() {
  const proc = spawn(process.execPath, [serverPath], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map();
  let buffer = '';

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  let nextId = 1;
  function request(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, 15000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  return { proc, request };
}

test('reader-server MCP stdio exposes tools with domain schema and validates invalid URLs offline', async () => {
  const { proc, request } = createMcpClient();
  try {
    const initialized = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'reader-integration-test', version: '1.0' }
    });
    assert.ok(initialized.result);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const toolsList = await request('tools/list');
    const names = toolsList.result.tools.map(t => t.name);
    assert.deepEqual(names, ['read_url_content', 'search_web']);

    const searchTool = toolsList.result.tools.find(t => t.name === 'search_web');
    assert.ok(searchTool.inputSchema.properties.domain);

    const invalidCall = await request('tools/call', {
      name: 'read_url_content',
      arguments: { url: 'ftp://example.com/file' }
    });
    assert.equal(invalidCall.result.isError, true);
    assert.match(invalidCall.result.content[0].text, /Invalid URL/);

    if (process.env.CHROMETETHER_NETWORK_TESTS === '1') {
      const searchRes = await request('tools/call', {
        name: 'search_web',
        arguments: { query: 'nodejs', max_results: 3 }
      });
      assert.equal(searchRes.result.isError, undefined);
      assert.doesNotMatch(searchRes.result.content[0].text, /duckduckgo\.com\/y\.js/);

      const pageRes = await request('tools/call', {
        name: 'read_url_content',
        arguments: { url: 'https://example.com' }
      });
      assert.equal(pageRes.result.isError, undefined);
      assert.match(pageRes.result.content[0].text, /Example Domain/);
    }
  } finally {
    proc.kill();
  }
});
