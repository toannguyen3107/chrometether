import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AppMapStore } from '../src/app-map/store.js';

test('builds a reusable map from browser pages and network requests without storing query values', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-map-'));
  try {
    const filePath = path.join(directory, 'session', 'map.json');
    const store = new AppMapStore(filePath);
    store.start('https://shop.example/orders', ['https://api.example']);
    store.recordPage('https://shop.example/orders/123?token=private-value&view=detail', 'Order detail');
    const result = store.recordRequests('https://shop.example/orders/123', [
      { url: 'https://api.example/v1/orders/123?token=secret-1', method: 'GET', status: 200, resourceType: 'fetch', headers: { authorization: 'secret' } },
      { url: 'https://api.example/v1/orders/456?token=secret-2', method: 'get', status: 403, resourceType: 'fetch' },
      { url: 'https://analytics.example/track?secret=do-not-store', method: 'POST', status: 204 }
    ]);
    assert.equal(result.recorded, 2);
    assert.equal(result.skipped, 1);

    const reopened = new AppMapStore(filePath).summary();
    assert.equal(reopened.pageCount, 1);
    assert.equal(reopened.endpointCount, 1);
    assert.deepEqual(reopened.pages[0].queryParameters, ['token', 'view']);
    assert.deepEqual(reopened.endpoints[0], {
      key: 'GET https://api.example/v1/orders/{id}',
      method: 'GET',
      origin: 'https://api.example',
      path: '/v1/orders/{id}',
      kind: 'api',
      count: 2,
      statusCodes: [200, 403],
      resourceTypes: ['fetch'],
      queryParameters: ['token'],
      seenOnPages: ['https://shop.example/orders/{id}']
    });
    const persisted = fs.readFileSync(filePath, 'utf8');
    for (const secret of ['private-value', 'secret-1', 'secret-2', 'do-not-store', 'authorization']) {
      assert.ok(!persisted.includes(secret), `Persisted map contains ${secret}`);
    }
    if (process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('skips invalid requests without losing valid requests in the same batch', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-map-'));
  try {
    const store = new AppMapStore(path.join(directory, 'map.json'));
    store.start('https://shop.example');
    const result = store.recordRequests('https://shop.example/orders', [
      { url: 'data:image/png;base64,abc' },
      { url: 'https://shop.example/api/orders/1', method: 'GET', resource_type: 'fetch' },
      { url: 'blob:https://shop.example/id' },
      { url: 'not a url' },
      { url: 'https://shop.example/' + 'x'.repeat(4096) },
      { url: 'https://shop.example/api/orders/2', method: 'GET', resourceType: 'xhr' }
    ]);
    assert.equal(result.recorded, 2);
    assert.equal(result.skipped, 4);
    const endpoint = store.summary().endpoints[0];
    assert.equal(endpoint.count, 2);
    assert.deepEqual(endpoint.resourceTypes, ['fetch', 'xhr']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('normalizes page titles and surfaces document POST requests as API traffic', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-map-'));
  try {
    const store = new AppMapStore(path.join(directory, 'map.json'));
    store.start('https://shop.example');
    assert.equal(store.recordPage('https://shop.example/orders', null).page.title, '');
    assert.equal(store.recordPage('https://shop.example/orders', 'x'.repeat(250)).page.title.length, 200);
    store.recordRequests('https://shop.example/orders', [
      { url: 'https://shop.example/checkout', method: 'POST', resourceType: 'document' },
      { url: 'https://shop.example/orders', method: 'GET', resourceType: 'document' }
    ]);
    const endpoints = store.summary().endpoints;
    assert.equal(endpoints.find(item => item.method === 'POST').kind, 'api');
    assert.equal(endpoints.find(item => item.method === 'GET').kind, 'navigation');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects out-of-scope pages and invalid origins before saving them', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-map-'));
  try {
    const store = new AppMapStore(path.join(directory, 'map.json'));
    assert.throws(() => store.start('file:///etc/passwd'), /HTTP\(S\)/);
    assert.throws(() => store.start('https://example.test', ['https://api.example.test/private']), /origins/);
    store.start('https://example.test');
    assert.throws(() => store.recordPage('https://other.test/page'), /outside/);
    assert.throws(() => store.recordRequests('https://other.test/page', []), /outside/);
    assert.equal(store.summary().pageCount, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('separates API traffic from browser assets in the same exploration', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-map-'));
  try {
    const store = new AppMapStore(path.join(directory, 'map.json'));
    store.start('https://shop.example');
    store.recordRequests('https://shop.example/orders', [
      { url: 'https://shop.example/assets/app.js', resourceType: 'script', status: 200 },
      { url: 'https://shop.example/api/orders/987', resourceType: 'fetch', status: 200 }
    ]);
    const map = store.summary();
    assert.equal(map.endpointCount, 2);
    assert.equal(map.apiEndpointCount, 1);
    assert.equal(map.endpoints.find(item => item.kind === 'api').key, 'GET https://shop.example/api/orders/{id}');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('exposes the application mapping workflow through MCP stdio', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-mcp-map-'));
  const serverPath = fileURLToPath(new URL('../src/app-map/server.js', import.meta.url));
  const proc = spawn(process.execPath, [serverPath], {
    env: { ...process.env, CHROMETETHER_MAP_FILE: path.join(directory, 'map.json') },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map();
  let buffer = '';
  proc.stdout.on('data', chunk => {
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
      }, 5000);
      pending.set(id, message => {
        clearTimeout(timer);
        resolve(message);
      });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  try {
    const initialized = await request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'map-test', version: '1.0' }
    });
    assert.ok(initialized.result);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = await request('tools/list');
    assert.deepEqual(tools.result.tools.map(tool => tool.name), [
      'start_app_map', 'record_app_page', 'record_app_requests', 'get_app_map'
    ]);
    const start = await request('tools/call', { name: 'start_app_map', arguments: { target_url: 'https://shop.example' } });
    assert.equal(start.result.isError, undefined);
    const recorded = await request('tools/call', { name: 'record_app_requests', arguments: {
      page_url: 'https://shop.example/orders', requests: [{ url: 'https://shop.example/api/orders/1', method: 'GET', status: 200 }]
    } });
    assert.equal(JSON.parse(recorded.result.content[0].text).recorded, 1);
    const map = await request('tools/call', { name: 'get_app_map', arguments: {} });
    assert.equal(JSON.parse(map.result.content[0].text).endpointCount, 1);
    const apiMap = await request('tools/call', { name: 'get_app_map', arguments: { kind: 'api', limit: 1 } });
    assert.equal(JSON.parse(apiMap.result.content[0].text).filteredEndpointCount, 1);
  } finally {
    proc.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
