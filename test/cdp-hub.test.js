import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ContainerVault } from '../src/cdp-hub/container-vault.js';
import { hubHttpRequest } from '../src/cdp-hub/launcher.js';
import { CdpHubServer } from '../src/cdp-hub/server.js';
import { connectWebSocket, upgradeToWebSocket } from '../src/cdp-hub/ws.js';

function createRpcClient(ws) {
  let seq = 0;
  const pending = new Map();
  const events = [];

  ws.on('message', raw => {
    const msg = JSON.parse(String(raw));
    if (msg.id !== undefined) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
    } else if (msg.method) {
      events.push(msg);
    }
  });

  return {
    events,
    send(method, params = {}, sessionId = undefined) {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        ws.send(JSON.stringify(payload));
      });
    }
  };
}

test('CdpHubServer enforces Origin guard and Bearer token authentication (Fable H5)', async () => {
  const vault = new ContainerVault({ filePath: null, autoSave: false });
  const hub = new CdpHubServer({
    port: 0,
    token: 'test-secret-token-123456',
    requireAuth: true,
    vault
  });
  const addr = await hub.start();

  try {
    // 1. Web page Origin must be rejected with 403
    await assert.rejects(
      () =>
        connectWebSocket(addr.wsEndpoint, {
          headers: {
            Origin: 'https://malicious.example.com',
            Authorization: 'Bearer test-secret-token-123456'
          }
        }),
      /403/
    );

    // 2. Missing token must be rejected with 401
    await assert.rejects(() => connectWebSocket(addr.wsEndpoint), /401/);

    // 3. Valid Bearer token without web Origin succeeds
    const validWs = await connectWebSocket(addr.wsEndpoint, {
      headers: { Authorization: 'Bearer test-secret-token-123456' }
    });
    validWs.close();

    // 4. Control endpoint /cdp MUST reject chrome-extension:// Origin if Bearer token is missing
    await assert.rejects(
      () =>
        connectWebSocket(addr.wsEndpoint, {
          headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }
        }),
      /401/
    );

    // 5. Chrome Extension Origin succeeds on /ext and pins the trusted extension ID
    const extWs = await connectWebSocket(`ws://127.0.0.1:${addr.port}/ext`, {
      headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }
    });
    extWs.close();

    // 6. A different Chrome Extension ID on /ext must be rejected once pinned
    await assert.rejects(
      () =>
        connectWebSocket(`ws://127.0.0.1:${addr.port}/ext`, {
          headers: { Origin: 'chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }
        }),
      /401/
    );
  } finally {
    await hub.stop();
  }
});

test('CdpHubServer emulates full Puppeteer 25.10 handshake and replays Runtime contexts across sessions (Fable M1 & H1)', async () => {
  const vault = new ContainerVault({ filePath: null, autoSave: false });
  vault.ensureContainer('acc-1', { color: 'blue' });
  vault.ensureContainer('acc-2', { color: 'orange' });

  const hub = new CdpHubServer({
    port: 0,
    token: 'secret-token-abc123456789',
    requireAuth: true,
    vault
  });
  const addr = await hub.start();

  try {
    const ws = await connectWebSocket(addr.wsEndpoint, {
      headers: { Authorization: 'Bearer secret-token-abc123456789' }
    });
    const rpc = createRpcClient(ws);

    // Step 1: Browser.getVersion
    const ver = await rpc.send('Browser.getVersion');
    assert.match(ver.product, /^Chrome\/149\./);

    // Step 2: Target.getBrowserContexts in deterministic creation order
    const ctxs = await rpc.send('Target.getBrowserContexts');
    assert.deepEqual(ctxs.browserContextIds, ['tether-ctx-acc-1', 'tether-ctx-acc-2']);

    // Step 3: Target.setDiscoverTargets emits Target.targetCreated before replying
    await rpc.send('Target.setDiscoverTargets', { discover: true });
    const createdEvents = rpc.events.filter(e => e.method === 'Target.targetCreated');
    assert.ok(createdEvents.length >= 1);

    // Step 4: Target.setAutoAttach emits `type: 'tab'` target
    await rpc.send('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true
    });
    const tabAttach = rpc.events.find(
      e => e.method === 'Target.attachedToTarget' && e.params?.targetInfo?.type === 'tab'
    );
    assert.ok(tabAttach);
    const tabSessionId = tabAttach.params.sessionId;

    // Step 5: Tab session `Target.setAutoAttach` emits child `type: 'page'` target
    await rpc.send('Target.setAutoAttach', { autoAttach: true, flatten: true }, tabSessionId);
    const pageAttach = rpc.events.find(
      e =>
        e.method === 'Target.attachedToTarget' &&
        e.sessionId === tabSessionId &&
        e.params?.targetInfo?.type === 'page'
    );
    assert.ok(pageAttach);
    const pageSession1 = pageAttach.params.sessionId;
    const pageTargetId = pageAttach.params.targetInfo.targetId;

    // Step 6: Primary page session enables Runtime and receives executionContextCreated
    await rpc.send('Runtime.enable', {}, pageSession1);
    const ctxEvent1 = rpc.events.find(
      e => e.method === 'Runtime.executionContextCreated' && e.sessionId === pageSession1
    );
    assert.ok(ctxEvent1);

    // Step 7: Secondary page session (like McpPage.#initDevToolsUniverseNoThrow) attaches to same page
    const attach2 = await rpc.send('Target.attachToTarget', {
      targetId: pageTargetId,
      flatten: true
    });
    const pageSession2 = attach2.sessionId;
    assert.notEqual(pageSession1, pageSession2);

    // Secondary session sends Runtime.enable -> Hub MUST replay Runtime.executionContextCreated!
    await rpc.send('Runtime.enable', {}, pageSession2);
    const ctxEvent2 = rpc.events.find(
      e => e.method === 'Runtime.executionContextCreated' && e.sessionId === pageSession2
    );
    assert.ok(ctxEvent2, 'Secondary session must receive replayed Runtime.executionContextCreated');

    // Disabling Runtime on session 2 must NOT remove session 1 from ref-count
    await rpc.send('Runtime.disable', {}, pageSession2);
    const tabRecord = hub.tabs.get('1');
    assert.equal(tabRecord.domainRefCounts.Runtime.has(pageSession1), true);
    assert.equal(tabRecord.domainRefCounts.Runtime.has(pageSession2), false);

    ws.close();
  } finally {
    await hub.stop();
  }
});

test('CdpHubServer + simulated Extension creates same-window Container Tabs, captures Set-Cookie, and updates DNR rules', async () => {
  const vault = new ContainerVault({ filePath: null, autoSave: false });
  const hub = new CdpHubServer({
    port: 0,
    token: 'ext-test-token-12345678',
    requireAuth: true,
    vault
  });
  const addr = await hub.start();

  try {
    const extWs = await connectWebSocket(`ws://127.0.0.1:${addr.port}/ext`, {
      headers: { Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }
    });

    const extReceivedRequests = [];
    let nextChromeTabId = 10;

    extWs.on('message', raw => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'hub_request') {
        extReceivedRequests.push(msg);
        if (msg.action === 'create_tab') {
          const tabId = ++nextChromeTabId;
          // Simulate premature chrome.tabs.onUpdated firing before create_tab finishes
          extWs.send(
            JSON.stringify({
              type: 'ext_tab_updated',
              tab: {
                tabId,
                windowId: 1,
                url: 'about:blank',
                title: '',
                containerName: null
              }
            })
          );
          extWs.send(
            JSON.stringify({
              type: 'hub_response',
              reqId: msg.reqId,
              result: {
                tabId,
                windowId: 1, // SAME window!
                url: msg.params.url,
                title: msg.params.url
              }
            })
          );
        } else {
          extWs.send(
            JSON.stringify({
              type: 'hub_response',
              reqId: msg.reqId,
              result: { ok: true }
            })
          );
        }
      }
    });

    // Reserve container `acc-1` via HTTP API (like `tether-containers` create_container)
    const reserveRes = await hubHttpRequest('/containers', {
      method: 'POST',
      port: addr.port,
      token: 'ext-test-token-12345678',
      body: { name: 'acc-1', color: 'blue', reserveNextContext: true }
    });
    assert.equal(reserveRes.statusCode, 200);
    assert.equal(reserveRes.data.container.name, 'acc-1');

    // Connect MCP client and call Target.createBrowserContext {} (bare, as chrome-devtools-mcp does)
    const mcpWs = await connectWebSocket(addr.wsEndpoint, {
      headers: { Authorization: 'Bearer ext-test-token-12345678' }
    });
    const rpc = createRpcClient(mcpWs);

    await rpc.send('Target.setDiscoverTargets', { discover: true });
    await rpc.send('Target.setAutoAttach', { autoAttach: true, flatten: true });
    const createdCtx = await rpc.send('Target.createBrowserContext', {});
    assert.equal(createdCtx.browserContextId, 'tether-ctx-acc-1');

    // Call Target.createTarget with that browserContextId
    const targetRes = await rpc.send('Target.createTarget', {
      url: 'https://portal.example.com/dashboard',
      browserContextId: createdCtx.browserContextId
    });
    assert.equal(targetRes.targetId, 'page-11');

    // Verify Target.attachedToTarget was emitted only ONCE for tab-11 and with browserContextId: 'tether-ctx-acc-1'
    const tab11Attaches = rpc.events.filter(
      e => e.method === 'Target.attachedToTarget' && e.params?.targetInfo?.targetId === 'tab-11'
    );
    assert.equal(tab11Attaches.length, 1);
    assert.equal(tab11Attaches[0].params.targetInfo.browserContextId, 'tether-ctx-acc-1');

    // Verify Extension received create_tab in the same window with initScript and badge
    const createTabReq = extReceivedRequests.find(r => r.action === 'create_tab');
    assert.ok(createTabReq);
    assert.equal(createTabReq.params.containerName, 'acc-1');
    assert.equal(createTabReq.params.color, 'blue');
    assert.equal(createTabReq.params.badge, '🔵');
    assert.match(createTabReq.params.initScript, /__chrometetherContainerInitialized/);

    // Simulate Extension capturing a raw Set-Cookie header on tab 11
    extWs.send(
      JSON.stringify({
        type: 'ext_set_cookie_captured',
        tabId: 11,
        containerName: 'acc-1',
        url: 'https://portal.example.com/login',
        setCookieHeaders: ['session=acc1_live_token; Path=/; Secure; HttpOnly; Max-Age=3600']
      })
    );

    await new Promise(r => setTimeout(r, 80));

    // Verify Vault stored the cookie and Hub pushed updated DNR rules for tab 11
    assert.equal(
      vault.getCookieHeaderForUrl('acc-1', 'https://portal.example.com/dashboard'),
      'session=acc1_live_token'
    );
    const dnrUpdateReq = extReceivedRequests
      .filter(r => r.action === 'update_tab_dnr_rules')
      .pop();
    assert.ok(dnrUpdateReq);
    assert.equal(dnrUpdateReq.params.tabId, 11);
    const cookieSetRule = dnrUpdateReq.params.rules.find(
      r => r.action?.requestHeaders?.[0]?.operation === 'set'
    );
    assert.ok(cookieSetRule);
    assert.equal(cookieSetRule.action.requestHeaders[0].value, 'session=acc1_live_token');

    // Simulate a compromised script inside tab 11 (acc-1) trying to spoof container: 'acc-2'
    vault.ensureContainer('acc-2', { color: 'orange' });
    extWs.send(
      JSON.stringify({
        type: 'ext_cdp_event',
        tabId: 11,
        method: 'Runtime.bindingCalled',
        params: {
          name: '__chrometether_vault_sync',
          payload: JSON.stringify({
            container: 'acc-2',
            type: 'storageSet',
            session: false,
            origin: 'https://portal.example.com',
            key: 'hijack',
            value: 'spoofed'
          })
        }
      })
    );
    await new Promise(r => setTimeout(r, 50));

    // Must be written to acc-1 (tab 11's true container), NEVER to acc-2!
    assert.deepEqual(vault.getStorageSnapshot('acc-2', 'https://portal.example.com'), {});
    assert.deepEqual(vault.getStorageSnapshot('acc-1', 'https://portal.example.com'), {
      hijack: 'spoofed'
    });

    mcpWs.close();
    extWs.close();
  } finally {
    await hub.stop();
  }
});

test('Phase 0 Direct-CDP Multiplexer shares 1 upstream connection across multiple MCP clients', async () => {
  // Start a mock Chrome DevToolsActivePort WebSocket server
  let upstreamConnectionsCount = 0;
  const mockChromeServer = http.createServer();
  mockChromeServer.on('upgrade', (req, socket, head) => {
    upstreamConnectionsCount += 1;
    const ws = upgradeToWebSocket(req, socket, head);
    ws.on('message', raw => {
      const msg = JSON.parse(String(raw));
      if (msg.method === 'Target.setDiscoverTargets') {
        ws.send(
          JSON.stringify({
            method: 'Target.targetCreated',
            params: {
              targetInfo: {
                targetId: 'REAL_TAB_1',
                type: 'page',
                title: 'Shared Daily Tab',
                url: 'https://example.com/'
              }
            }
          })
        );
        ws.send(JSON.stringify({ id: msg.id, result: {} }));
      } else if (msg.method === 'Target.attachToTarget') {
        ws.send(
          JSON.stringify({
            id: msg.id,
            result: { sessionId: `real-sess-${msg.params.targetId}` }
          })
        );
      } else {
        ws.send(
          JSON.stringify({
            id: msg.id,
            sessionId: msg.sessionId,
            result: {}
          })
        );
      }
    });
  });

  await new Promise(resolve => mockChromeServer.listen(0, '127.0.0.1', resolve));
  const chromePort = mockChromeServer.address().port;

  const vault = new ContainerVault({ filePath: null, autoSave: false });
  const hub = new CdpHubServer({
    port: 0,
    token: 'phase0-token-12345678',
    requireAuth: true,
    vault,
    upstreamWsUrl: `ws://127.0.0.1:${chromePort}/devtools/browser/mock-uuid`,
    autoConnectDirectCdp: true
  });
  const addr = await hub.start();

  try {
    // Connect TWO concurrent MCP clients
    const client1Ws = await connectWebSocket(addr.wsEndpoint, {
      headers: { Authorization: 'Bearer phase0-token-12345678' }
    });
    const client2Ws = await connectWebSocket(addr.wsEndpoint, {
      headers: { Authorization: 'Bearer phase0-token-12345678' }
    });
    const rpc1 = createRpcClient(client1Ws);
    const rpc2 = createRpcClient(client2Ws);

    await rpc1.send('Target.setDiscoverTargets', { discover: true });
    await rpc2.send('Target.setDiscoverTargets', { discover: true });

    // Both clients discovered REAL_TAB_1, while Chrome only received 1 connection!
    assert.equal(upstreamConnectionsCount, 1);
    assert.ok(
      rpc1.events.some(
        e => e.method === 'Target.targetCreated' && e.params?.targetInfo?.targetId === 'REAL_TAB_1'
      )
    );
    assert.ok(
      rpc2.events.some(
        e => e.method === 'Target.targetCreated' && e.params?.targetInfo?.targetId === 'REAL_TAB_1'
      )
    );

    client1Ws.close();
    client2Ws.close();
  } finally {
    await hub.stop();
    await new Promise(resolve => mockChromeServer.close(resolve));
  }
});

test('Real bundled puppeteer-core@25.10.0 connects to CdpHubServer and completes TargetManager init + multi-session evaluate (Fable S3)', async () => {
  const { puppeteer } = await import(
    '../node_modules/chrome-devtools-mcp/build/src/third_party/index.js'
  );
  const vault = new ContainerVault({ filePath: null, autoSave: false });
  vault.ensureContainer('acc-1', { color: 'blue' });

  const hub = new CdpHubServer({
    port: 0,
    token: 'pptr-conformance-token-999',
    requireAuth: true,
    vault
  });
  const addr = await hub.start();

  try {
    const browser = await puppeteer.connect({
      browserWSEndpoint: addr.wsEndpoint,
      headers: {
        Authorization: 'Bearer pptr-conformance-token-999'
      },
      defaultViewport: null
    });

    const contexts = browser.browserContexts();
    // Default context + persistent acc-1 context
    assert.ok(contexts.length >= 2);

    const pages = await browser.pages();
    assert.ok(pages.length >= 1);

    // Reserve `acc-2` and create a new isolated BrowserContext + Page via Puppeteer
    hub.reserveNextContext('acc-2');
    const acc2Context = await browser.createBrowserContext();
    const acc2Page = await acc2Context.newPage();
    assert.ok(acc2Page);

    // Open a secondary CDP session on the same page (as McpPage.#initDevToolsUniverseNoThrow does)
    const secondarySession = await acc2Page.createCDPSession();
    await secondarySession.send('Runtime.enable');

    const evalRes = await acc2Page.evaluate(() => 'ok');
    assert.equal(evalRes, 'ok');

    await acc2Page.close();
    await browser.disconnect();
  } finally {
    await hub.stop();
  }
});

test('tether-containers MCP tool handlers create, list, open, and clear containers end-to-end', async () => {
  const { handleContainerToolCall } = await import('../src/containers-server/index.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tether-mcp-containers-'));
  const prevFile = process.env.CHROMETETHER_CONTAINERS_FILE;
  const prevPort = process.env.CHROMETETHER_HUB_PORT;
  const prevToken = process.env.CHROMETETHER_HUB_TOKEN;

  const vaultFile = path.join(tmpDir, 'containers.json');
  process.env.CHROMETETHER_CONTAINERS_FILE = vaultFile;
  process.env.CHROMETETHER_HUB_TOKEN = 'mcp-containers-token-12345';

  const vault = new ContainerVault({ filePath: vaultFile });
  const hub = new CdpHubServer({
    port: 0,
    token: 'mcp-containers-token-12345',
    requireAuth: true,
    vault
  });
  const addr = await hub.start();
  process.env.CHROMETETHER_HUB_PORT = String(addr.port);

  try {
    const created = await handleContainerToolCall('create_container', {
      name: 'acc-1',
      color: 'blue'
    });
    assert.equal(created.ok, true);
    assert.equal(created.container.name, 'acc-1');
    assert.equal(created.container.mcpIsolatedContextName, 'isolated-context-1');

    const opened = await handleContainerToolCall('open_container_page', {
      container: 'acc-1',
      url: 'https://dashboard.example.com/home',
      background: true
    });
    assert.equal(opened.ok, true);
    assert.equal(opened.container, 'acc-1');
    assert.equal(opened.tab.url, 'https://dashboard.example.com/home');

    const listed = await handleContainerToolCall('list_containers', {});
    assert.equal(listed.ok, true);
    assert.equal(listed.containers.length, 1);
    assert.equal(listed.containers[0].tabs.length, 1);

    const cleared = await handleContainerToolCall('clear_container', { name: 'acc-1' });
    assert.equal(cleared.ok, true);
    assert.equal(cleared.cleared, true);

    const deleted = await handleContainerToolCall('delete_container', { name: 'acc-1' });
    assert.equal(deleted.ok, true);
    assert.equal(deleted.deleted, true);

    const listedAfterDelete = await handleContainerToolCall('list_containers', {});
    assert.equal(listedAfterDelete.containers.length, 0);
  } finally {
    await hub.stop();
    if (prevFile === undefined) delete process.env.CHROMETETHER_CONTAINERS_FILE;
    else process.env.CHROMETETHER_CONTAINERS_FILE = prevFile;
    if (prevPort === undefined) delete process.env.CHROMETETHER_HUB_PORT;
    else process.env.CHROMETETHER_HUB_PORT = prevPort;
    if (prevToken === undefined) delete process.env.CHROMETETHER_HUB_TOKEN;
    else process.env.CHROMETETHER_HUB_TOKEN = prevToken;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
