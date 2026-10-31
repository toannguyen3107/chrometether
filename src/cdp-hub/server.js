import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  ContainerVault,
  extractUrlContainerHint,
  fromVirtualContextId,
  normalizeContainerName
} from './container-vault.js';
import {
  DEFAULT_HUB_PORT,
  HUB_VERSION,
  getOrCreateHubToken
} from './token.js';
import {
  WS_STATE,
  connectWebSocket,
  extractAuthToken,
  isAllowedOrigin,
  upgradeToWebSocket
} from './ws.js';

/**
 * Determine whether a tab URL is attachable by Chrome extensions / DevTools without
 * hanging Puppeteer's `#targetsIdsForInit` initialization barrier (Fable M1).
 */
export function isAttachableTabUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return true;
  const lower = url.trim().toLowerCase();
  if (
    lower.startsWith('chrome://') ||
    lower.startsWith('chrome-extension://') ||
    lower.startsWith('devtools://') ||
    lower.startsWith('edge://') ||
    lower.startsWith(' view-source:') ||
    lower.startsWith('https://chromewebstore.google.com') ||
    lower.startsWith('https://chrome.google.com/webstore')
  ) {
    return false;
  }
  return true;
}

/**
 * Read Chrome's `DevToolsActivePort` file if present on the system.
 */
export function readDevToolsActivePort(customUserDataDir) {
  const candidates = [];
  if (customUserDataDir) {
    candidates.push(path.join(customUserDataDir, 'DevToolsActivePort'));
  }
  if (process.env.CHROMETETHER_USER_DATA_DIR) {
    candidates.push(path.join(process.env.CHROMETETHER_USER_DATA_DIR, 'DevToolsActivePort'));
  }

  const home = os.homedir();
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(path.join(localAppData, 'Google', 'Chrome', 'User Data', 'DevToolsActivePort'));
  } else if (process.platform === 'darwin') {
    candidates.push(
      path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'DevToolsActivePort')
    );
  } else {
    candidates.push(path.join(home, '.config', 'google-chrome', 'DevToolsActivePort'));
  }

  for (const filePath of candidates) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const lines = fs
        .readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean);
      if (lines.length >= 2) {
        const port = Number.parseInt(lines[0], 10);
        const wsPath = lines[1];
        if (Number.isInteger(port) && port > 0 && wsPath.startsWith('/')) {
          return {
            port,
            wsPath,
            wsUrl: `ws://127.0.0.1:${port}${wsPath}`,
            filePath
          };
        }
      }
    } catch {
      // ignore unreadable file
    }
  }
  return null;
}

export class CdpHubServer {
  constructor({
    port = DEFAULT_HUB_PORT,
    host = '127.0.0.1',
    token = getOrCreateHubToken(),
    requireAuth = true,
    vault = new ContainerVault(),
    keepAliveIntervalMs = 20000,
    upstreamWsUrl = process.env.CHROMETETHER_UPSTREAM_WS_URL || null,
    autoConnectDirectCdp = false
  } = {}) {
    this.port = port;
    this.host = host;
    this.token = token;
    this.requireAuth = requireAuth;
    this.vault = vault;
    this.keepAliveIntervalMs = keepAliveIntervalMs;
    this.upstreamWsUrl = upstreamWsUrl;
    this.autoConnectDirectCdp = autoConnectDirectCdp;

    this.httpServer = null;
    this.keepAliveTimer = null;

    // Connected MCP clients (/cdp)
    this.mcpClients = new Map();
    this._clientSeq = 0;

    // Connected Chrome Extension (/ext)
    this.extSocket = null;
    this._extReqSeq = 0;
    this._extPending = new Map();

    // Phase 0 Direct-CDP upstream browser WebSocket (DevToolsActivePort)
    this.directWs = null;
    this._directReqSeq = 0;
    this._directPending = new Map();
    this._directConnectPromise = null;

    // Canonical tab table: key is numeric/string tabId
    this.tabs = new Map();
    this._syntheticTabSeq = 1000;

    // Pending container context reservations (Fixes Fable B2)
    this.pendingContextQueue = [];
    this._anonContainerSeq = 0;
  }

  get mode() {
    if (this.extSocket && this.extSocket.readyState === WS_STATE.OPEN) {
      return 'extension';
    }
    if (this.directWs && this.directWs.readyState === WS_STATE.OPEN) {
      return 'direct-cdp';
    }
    return 'standby';
  }

  async start() {
    if (this.httpServer) return this.address();

    this.httpServer = http.createServer((req, res) => {
      this._handleHttpRequest(req, res).catch(err => {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: err.message }));
      });
    });

    this.httpServer.on('upgrade', (req, socket, head) => {
      this._handleUpgrade(req, socket, head);
    });

    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.port, this.host, () => {
        this.httpServer.removeListener('error', reject);
        resolve();
      });
    });

    const addr = this.httpServer.address();
    if (addr && typeof addr === 'object') {
      this.port = addr.port;
    }

    if (this.keepAliveIntervalMs > 0) {
      this.keepAliveTimer = setInterval(() => {
        this._sendKeepAlive();
      }, this.keepAliveIntervalMs);
      if (this.keepAliveTimer.unref) {
        this.keepAliveTimer.unref();
      }
    }

    if (this.upstreamWsUrl || this.autoConnectDirectCdp) {
      this.ensureDirectUpstream().catch(() => {
        // Lazy retry on client command
      });
    }

    return this.address();
  }

  async stop() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }

    for (const client of this.mcpClients.values()) {
      try {
        client.ws.close(1000, 'Hub shutting down');
      } catch {
        // ignore
      }
    }
    this.mcpClients.clear();

    if (this.extSocket) {
      try {
        this.extSocket.close(1000, 'Hub shutting down');
      } catch {
        // ignore
      }
      this.extSocket = null;
    }

    if (this.directWs) {
      try {
        this.directWs.close(1000, 'Hub shutting down');
      } catch {
        // ignore
      }
      this.directWs = null;
    }

    if (this.httpServer) {
      const srv = this.httpServer;
      this.httpServer = null;
      await new Promise(resolve => srv.close(() => resolve()));
    }
  }

  address() {
    return {
      host: this.host,
      port: this.port,
      wsEndpoint: `ws://${this.host}:${this.port}/cdp`,
      httpUrl: `http://${this.host}:${this.port}`
    };
  }

  _sendKeepAlive() {
    // Keep MV3 Service Worker alive with sub-25s WebSocket activity (Fixes Fable H3)
    if (this.extSocket && this.extSocket.readyState === WS_STATE.OPEN) {
      this.extSocket.ping('keepalive');
      this.extSocket.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    }
    for (const client of this.mcpClients.values()) {
      if (client.ws.readyState === WS_STATE.OPEN) {
        client.ws.ping('keepalive');
      }
    }
  }

  _isAuthorizedRequest(req, parsedUrl) {
    if (!isAllowedOrigin(req.headers.origin)) {
      return false;
    }
    if (!this.requireAuth) {
      return true;
    }
    const origin = String(req.headers.origin || '').toLowerCase();
    if (origin.startsWith('chrome-extension://')) {
      return true;
    }
    const provided = extractAuthToken(req, parsedUrl);
    return Boolean(provided && provided === this.token);
  }

  async _readJsonBody(req) {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : {};
  }

  async _handleHttpRequest(req, res) {
    if (!isAllowedOrigin(req.headers.origin)) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Forbidden Origin' }));
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${this.host}:${this.port}`);
    res.setHeader('Content-Type', 'application/json');

    // Public health endpoint (returns version and mode so launcher can verify liveness)
    if (req.method === 'GET' && parsedUrl.pathname === '/health') {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          ok: true,
          version: HUB_VERSION,
          mode: this.mode,
          port: this.port,
          extensionConnected: Boolean(this.extSocket && this.extSocket.readyState === WS_STATE.OPEN),
          directCdpConnected: Boolean(this.directWs && this.directWs.readyState === WS_STATE.OPEN),
          mcpClientsCount: this.mcpClients.size,
          tabsCount: this.tabs.size,
          containers: this.vault.listContainers()
        })
      );
      return;
    }

    if (!this._isAuthorizedRequest(req, parsedUrl)) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'Unauthorized: missing or invalid ChromeTether Hub token' }));
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/json/version') {
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          Browser: 'Chrome/149.0.0.0',
          'Protocol-Version': '1.3',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
          'V8-Version': '13.0.0',
          'WebKit-Version': '537.36 (@chrometether)',
          webSocketDebuggerUrl: `ws://${this.host}:${this.port}/cdp`
        })
      );
      return;
    }

    if (req.method === 'GET' && (parsedUrl.pathname === '/json' || parsedUrl.pathname === '/json/list')) {
      const list = Array.from(this.tabs.values())
        .filter(t => t.attachable)
        .map(t => ({
          id: t.pageTargetId,
          type: 'page',
          title: t.title,
          url: t.url,
          browserContextId: t.browserContextId,
          containerName: t.containerName,
          webSocketDebuggerUrl: `ws://${this.host}:${this.port}/cdp`
        }));
      res.statusCode = 200;
      res.end(JSON.stringify(list));
      return;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/containers') {
      const containers = this.vault.listContainers().map(c => ({
        ...c,
        tabs: Array.from(this.tabs.values())
          .filter(t => t.containerName === c.name)
          .map(t => ({ tabId: t.tabId, pageTargetId: t.pageTargetId, url: t.url, title: t.title }))
      }));
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          ok: true,
          containers,
          pendingReservations: [...this.pendingContextQueue]
        })
      );
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/containers') {
      const body = await this._readJsonBody(req);
      const entry = this.vault.ensureContainer(body.name, { color: body.color });
      if (body.reserveNextContext !== false) {
        this.reserveNextContext(entry.name);
      }
      const list = this.vault.listContainers();
      const info = list.find(c => c.name === entry.name) || entry;
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, container: info }));
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/containers/open-tab') {
      const body = await this._readJsonBody(req);
      const containerEntry = this.vault.ensureContainer(body.container || body.name, {
        color: body.color
      });
      const url = body.url || 'about:blank';
      const background = Boolean(body.background);
      const tab = await this.createContainerTab({
        containerName: containerEntry.name,
        url,
        background
      });
      res.statusCode = 200;
      res.end(
        JSON.stringify({
          ok: true,
          container: containerEntry.name,
          contextId: containerEntry.contextId,
          tab: {
            tabId: tab.tabId,
            pageTargetId: tab.pageTargetId,
            url: tab.url,
            title: tab.title,
            browserContextId: tab.browserContextId
          }
        })
      );
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/containers/clear') {
      const body = await this._readJsonBody(req);
      const cleared = this.vault.clearContainer(body.name || body.container);
      if (cleared) {
        await this._syncContainerDnrRules(body.name || body.container);
      }
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, cleared }));
      return;
    }

    if (req.method === 'POST' && parsedUrl.pathname === '/shutdown') {
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, shuttingDown: true }));
      setImmediate(() => {
        this.stop().then(() => {
          if (isMain) process.exit(0);
        });
      });
      return;
    }

    if (req.method === 'DELETE' && parsedUrl.pathname.startsWith('/containers/')) {
      const name = decodeURIComponent(parsedUrl.pathname.slice('/containers/'.length));
      const deleted = this.vault.deleteContainer(name);
      res.statusCode = 200;
      res.end(JSON.stringify({ ok: true, deleted }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  _handleUpgrade(req, socket, head) {
    if (!isAllowedOrigin(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const parsedUrl = new URL(req.url || '/', `http://${this.host}:${this.port}`);
    if (!this._isAuthorizedRequest(req, parsedUrl)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    if (parsedUrl.pathname === '/ext') {
      const ws = upgradeToWebSocket(req, socket, head);
      if (ws) this._onExtensionConnected(ws);
      return;
    }

    if (parsedUrl.pathname === '/cdp' || parsedUrl.pathname.startsWith('/devtools/')) {
      const ws = upgradeToWebSocket(req, socket, head);
      if (ws) this._onMcpClientConnected(ws);
      return;
    }

    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
  }

  /**
   * Queue a container name so the next `Target.createBrowserContext {}` from `chrome-devtools-mcp`
   * binds deterministically to this named persistent container (Fixes Fable B2).
   */
  reserveNextContext(containerName) {
    const clean = normalizeContainerName(containerName);
    this.vault.ensureContainer(clean);
    if (!this.pendingContextQueue.includes(clean)) {
      this.pendingContextQueue.push(clean);
    }
    return clean;
  }

  _ensureTabRecord({
    tabId,
    url = 'about:blank',
    title = '',
    windowId = 1,
    containerName = null,
    upstreamTargetId = null
  }) {
    const key = String(tabId);
    let tab = this.tabs.get(key);
    const container = containerName ? this.vault.ensureContainer(containerName) : null;
    const browserContextId = container ? container.contextId : undefined;
    const attachable = isAttachableTabUrl(url);

    if (!tab) {
      tab = {
        tabId,
        key,
        tabTargetId: `tab-${key}`,
        pageTargetId: upstreamTargetId || `page-${key}`,
        upstreamTargetId: upstreamTargetId || null,
        upstreamSessionId: null,
        url: url || 'about:blank',
        title: title || url || 'about:blank',
        windowId: windowId || 1,
        containerName: container ? container.name : null,
        browserContextId,
        attachable,
        detachedFailClosed: false,
        executionContexts: new Map(),
        frameTree: null,
        domainRefCounts: {
          Runtime: new Set(),
          Network: new Set(),
          Page: new Set(),
          Log: new Set(),
          Audits: new Set(),
          Performance: new Set()
        }
      };
      // Seed default main-world execution context so Runtime.enable always has a context ready
      tab.executionContexts.set(1, {
        id: 1,
        origin: tab.url || 'about:blank',
        name: '',
        uniqueId: `ctx-main-${key}`,
        auxData: { isDefault: true, type: 'default', frameId: `main-frame-${key}` }
      });
      this.tabs.set(key, tab);
    } else {
      tab.url = url ?? tab.url;
      tab.title = title || tab.title || tab.url;
      if (windowId !== undefined) tab.windowId = windowId;
      if (containerName !== undefined && containerName !== null) {
        tab.containerName = container ? container.name : null;
        tab.browserContextId = browserContextId;
      }
      tab.attachable = isAttachableTabUrl(tab.url);
      const mainCtx = tab.executionContexts.get(1);
      if (mainCtx) {
        mainCtx.origin = tab.url || 'about:blank';
      }
    }
    return tab;
  }

  // ============================================================================
  // Phase 1: Chrome Extension (/ext) Upstream Handling
  // ============================================================================

  _onExtensionConnected(ws) {
    if (this.extSocket && this.extSocket !== ws) {
      try {
        this.extSocket.close(1000, 'Replaced by newer extension connection');
      } catch {
        // ignore
      }
    }
    this.extSocket = ws;

    ws.on('message', raw => {
      try {
        const msg = JSON.parse(String(raw));
        this._handleExtensionMessage(msg);
      } catch {
        // ignore malformed json
      }
    });

    ws.on('error', () => {
      // Handled by close event
    });

    ws.on('close', () => {
      if (this.extSocket === ws) {
        this.extSocket = null;
        for (const pending of this._extPending.values()) {
          pending.reject(new Error('Extension WebSocket disconnected'));
        }
        this._extPending.clear();
      }
    });

    // Send initial hello with Hub token and current container vault state
    ws.send(
      JSON.stringify({
        type: 'hub_hello',
        version: HUB_VERSION,
        token: this.token,
        containers: this.vault.listContainers()
      })
    );
  }

  _sendExtensionRequest(action, params = {}, timeoutMs = 10000) {
    if (!this.extSocket || this.extSocket.readyState !== WS_STATE.OPEN) {
      return Promise.reject(new Error('Extension is not connected'));
    }
    const reqId = ++this._extReqSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._extPending.delete(reqId);
        reject(new Error(`Extension request "${action}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this._extPending.set(reqId, {
        resolve: res => {
          clearTimeout(timer);
          resolve(res);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        }
      });

      this.extSocket.send(
        JSON.stringify({
          type: 'hub_request',
          reqId,
          action,
          params
        })
      );
    });
  }

  _handleExtensionMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'pong' || msg.type === 'ping') {
      if (msg.type === 'ping' && this.extSocket?.readyState === WS_STATE.OPEN) {
        this.extSocket.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
      }
      return;
    }

    if (msg.type === 'hub_response' && msg.reqId) {
      const pending = this._extPending.get(msg.reqId);
      if (pending) {
        this._extPending.delete(msg.reqId);
        if (msg.error) {
          pending.reject(new Error(msg.error));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.type === 'ext_sync_containers' && Array.isArray(msg.containers)) {
      let vaultChanged = false;
      for (const c of msg.containers) {
        if (!c?.name) continue;
        const entry = this.vault.ensureContainer(c.name, { color: c.color });
        if (Array.isArray(c.cookies)) {
          for (const cookie of c.cookies) {
            if (!cookie?.name || !cookie?.domain) continue;
            const exists = entry.cookies.some(
              existing =>
                existing.name === cookie.name &&
                existing.domain === cookie.domain &&
                existing.path === (cookie.path || '/')
            );
            if (!exists) {
              entry.cookies.push(cookie);
              vaultChanged = true;
            }
          }
        }
        if (c.localStorage && typeof c.localStorage === 'object') {
          for (const [origin, bucket] of Object.entries(c.localStorage)) {
            if (bucket && typeof bucket === 'object') {
              entry.localStorage[origin] = {
                ...(entry.localStorage[origin] || {}),
                ...bucket
              };
              vaultChanged = true;
            }
          }
        }
      }
      if (vaultChanged && this.vault.autoSave) {
        this.vault.save();
      }
      return;
    }

    if (msg.type === 'ext_tabs_snapshot' && Array.isArray(msg.tabs)) {
      const seenKeys = new Set();
      for (const t of msg.tabs) {
        const wasKnown = this.tabs.has(String(t.tabId));
        const tab = this._ensureTabRecord({
          tabId: t.tabId,
          url: t.url,
          title: t.title,
          windowId: t.windowId,
          containerName: t.containerName || null
        });
        seenKeys.add(tab.key);
        if (!wasKnown && tab.attachable) {
          this._broadcastNewTabToMcpClients(tab);
        }
      }
      for (const [key, existing] of this.tabs.entries()) {
        if (!seenKeys.has(key) && !existing.upstreamTargetId) {
          this._handleTabClosed(key);
        }
      }
      return;
    }

    if (msg.type === 'ext_tab_updated' && msg.tab) {
      const t = msg.tab;
      const wasKnown = this.tabs.has(String(t.tabId));
      const tab = this._ensureTabRecord({
        tabId: t.tabId,
        url: t.url,
        title: t.title,
        windowId: t.windowId,
        containerName: t.containerName
      });
      if (!wasKnown && tab.attachable) {
        this._broadcastNewTabToMcpClients(tab);
      } else if (tab.attachable) {
        this._broadcastTargetInfoChanged(tab);
      }
      return;
    }

    if (msg.type === 'ext_tab_removed' && msg.tabId !== undefined) {
      this._handleTabClosed(String(msg.tabId));
      return;
    }

    if (msg.type === 'ext_set_cookie_captured') {
      const { containerName, tabId, url, setCookieHeaders } = msg;
      const targetContainer = containerName || this.tabs.get(String(tabId))?.containerName;
      if (targetContainer && setCookieHeaders) {
        const changed = this.vault.applySetCookieHeaders(targetContainer, setCookieHeaders, url);
        if (changed) {
          this._syncContainerDnrRules(targetContainer).catch(() => {});
        }
      }
      return;
    }

    if (msg.type === 'ext_debugger_detached') {
      const tab = this.tabs.get(String(msg.tabId));
      if (tab && tab.containerName) {
        tab.detachedFailClosed = true;
        this._syncTabDnrRules(tab, { failClosedBlocked: true }).catch(() => {});
      }
      return;
    }

    if (msg.type === 'ext_cdp_event') {
      const tab = this.tabs.get(String(msg.tabId));
      if (tab) {
        this._handleUpstreamTabCdpEvent(tab, msg.method, msg.params || {});
      }
      return;
    }

    if (msg.type === 'ext_popup_action') {
      this._handlePopupAction(msg).catch(() => {});
    }
  }

  async _handlePopupAction(msg) {
    if (msg.action === 'open_container_tab') {
      const entry = this.vault.ensureContainer(msg.containerName, { color: msg.color });
      await this.createContainerTab({
        containerName: entry.name,
        url: msg.url || 'about:blank',
        background: false
      });
    } else if (msg.action === 'convert_current_tab' && msg.tabId) {
      // Safe conversion per Fable 3.2: assign container -> clear -> about:blank -> attach & script -> reload URL
      const entry = this.vault.ensureContainer(msg.containerName, { color: msg.color });
      const tab = this._ensureTabRecord({
        tabId: msg.tabId,
        url: msg.url || 'about:blank',
        containerName: entry.name
      });
      await this._syncTabDnrRules(tab);
      if (this.extSocket?.readyState === WS_STATE.OPEN) {
        await this._sendExtensionRequest('convert_tab_to_container', {
          tabId: Number(msg.tabId),
          containerName: entry.name,
          color: entry.color,
          badge: entry.badge,
          initScript: this.vault.buildInitScript(entry.name),
          dnrRules: this.vault.buildDnrSessionRulesForTab(entry.name, Number(msg.tabId)),
          originalUrl: msg.url || 'about:blank'
        });
      }
    } else if (msg.action === 'clear_container' && msg.containerName) {
      this.vault.clearContainer(msg.containerName);
      await this._syncContainerDnrRules(msg.containerName);
    }
  }

  async _syncContainerDnrRules(containerName) {
    for (const tab of this.tabs.values()) {
      if (tab.containerName === containerName) {
        await this._syncTabDnrRules(tab);
      }
    }
  }

  async _syncTabDnrRules(tab, { failClosedBlocked = false } = {}) {
    if (!tab.containerName) return;
    if (!this.extSocket || this.extSocket.readyState !== WS_STATE.OPEN) return;
    const numericTabId = Number(tab.tabId);
    if (!Number.isInteger(numericTabId) || numericTabId <= 0) return;

    const rules = this.vault.buildDnrSessionRulesForTab(tab.containerName, numericTabId, {
      failClosedBlocked
    });
    try {
      await this._sendExtensionRequest('update_tab_dnr_rules', {
        tabId: numericTabId,
        containerName: tab.containerName,
        rules
      });
    } catch {
      // ignore if extension is reconnecting
    }
  }

  // ============================================================================
  // Phase 0: Direct-CDP (`DevToolsActivePort`) Multiplexer Upstream
  // ============================================================================

  async ensureDirectUpstream() {
    if (this.directWs && this.directWs.readyState === WS_STATE.OPEN) {
      return this.directWs;
    }
    if (this._directConnectPromise) {
      return this._directConnectPromise;
    }

    this._directConnectPromise = (async () => {
      try {
        let wsUrl = this.upstreamWsUrl;
        if (!wsUrl && this.autoConnectDirectCdp) {
          const active = readDevToolsActivePort();
          if (active) wsUrl = active.wsUrl;
        }
        if (!wsUrl) return null;

        const ws = await connectWebSocket(wsUrl, { timeoutMs: 5000 });
        this.directWs = ws;

        ws.on('message', raw => {
          try {
            const msg = JSON.parse(String(raw));
            this._handleDirectUpstreamMessage(msg);
          } catch {
            // ignore
          }
        });

        ws.on('close', () => {
          if (this.directWs === ws) {
            this.directWs = null;
            for (const pending of this._directPending.values()) {
              pending.reject(new Error('Upstream Chrome CDP WebSocket closed'));
            }
            this._directPending.clear();
          }
        });

        // Discover existing targets on the single approved Chrome connection
        await this._sendDirectCommand('Target.setDiscoverTargets', { discover: true });
        return ws;
      } catch {
        return null;
      } finally {
        this._directConnectPromise = null;
      }
    })();

    return this._directConnectPromise;
  }

  _sendDirectCommand(method, params = {}, sessionId = undefined, timeoutMs = 10000) {
    if (!this.directWs || this.directWs.readyState !== WS_STATE.OPEN) {
      return Promise.reject(new Error('Direct CDP upstream is not connected'));
    }
    const id = ++this._directReqSeq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._directPending.delete(id);
        reject(new Error(`Direct CDP command "${method}" timed out`));
      }, timeoutMs);

      this._directPending.set(id, {
        resolve: res => {
          clearTimeout(timer);
          resolve(res);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        }
      });

      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      this.directWs.send(JSON.stringify(payload));
    });
  }

  _handleDirectUpstreamMessage(msg) {
    if (msg.id !== undefined) {
      const pending = this._directPending.get(msg.id);
      if (pending) {
        this._directPending.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message || 'CDP upstream error'));
        } else {
          pending.resolve(msg.result || {});
        }
      }
      return;
    }

    if (msg.method === 'Target.targetCreated' && msg.params?.targetInfo) {
      const info = msg.params.targetInfo;
      if (info.type === 'page') {
        const wasKnown = this.tabs.has(info.targetId);
        const tab = this._ensureTabRecord({
          tabId: info.targetId,
          upstreamTargetId: info.targetId,
          url: info.url,
          title: info.title
        });
        if (!wasKnown && tab.attachable) {
          this._broadcastNewTabToMcpClients(tab);
        }
      }
      return;
    }

    if (msg.method === 'Target.targetInfoChanged' && msg.params?.targetInfo) {
      const info = msg.params.targetInfo;
      if (info.type === 'page') {
        const tab = this.tabs.get(info.targetId);
        if (tab) {
          tab.url = info.url ?? tab.url;
          tab.title = info.title ?? tab.title;
          tab.attachable = isAttachableTabUrl(tab.url);
          this._broadcastTargetInfoChanged(tab);
        }
      }
      return;
    }

    if (msg.method === 'Target.targetDestroyed' && msg.params?.targetId) {
      this._handleTabClosed(msg.params.targetId);
      return;
    }

    // Event on an attached upstream target session
    if (msg.sessionId && msg.method) {
      for (const tab of this.tabs.values()) {
        if (tab.upstreamSessionId === msg.sessionId) {
          this._handleUpstreamTabCdpEvent(tab, msg.method, msg.params || {});
          break;
        }
      }
    }
  }

  // ============================================================================
  // Shared Container Tab Creation & Upstream Command Forwarding
  // ============================================================================

  async createContainerTab({ containerName = null, url = 'about:blank', background = false } = {}) {
    const hint = extractUrlContainerHint(url);
    const effectiveContainerName = containerName || hint.containerName;
    const targetUrl = hint.cleanUrl || 'about:blank';
    const container = effectiveContainerName
      ? this.vault.ensureContainer(effectiveContainerName)
      : null;

    if (this.extSocket && this.extSocket.readyState === WS_STATE.OPEN) {
      const initScript = container ? this.vault.buildInitScript(container.name) : null;
      const res = await this._sendExtensionRequest('create_tab', {
        url: targetUrl,
        background,
        containerName: container ? container.name : null,
        color: container ? container.color : null,
        badge: container ? container.badge : null,
        initScript
      });
      const tab = this._ensureTabRecord({
        tabId: res.tabId,
        url: res.url || targetUrl,
        title: res.title || targetUrl,
        windowId: res.windowId || 1,
        containerName: container ? container.name : null
      });
      if (container) {
        await this._syncTabDnrRules(tab);
      }
      this._broadcastNewTabToMcpClients(tab);
      return tab;
    }

    // Phase 0 Direct-CDP or Standby mode
    await this.ensureDirectUpstream();
    if (this.directWs && this.directWs.readyState === WS_STATE.OPEN) {
      // Always create target WITHOUT browserContextId so Chrome opens a Tab in the SAME window!
      const created = await this._sendDirectCommand('Target.createTarget', {
        url: 'about:blank',
        background
      });
      const targetId = created.targetId;
      const tab = this._ensureTabRecord({
        tabId: targetId,
        upstreamTargetId: targetId,
        url: targetUrl,
        title: targetUrl,
        containerName: container ? container.name : null
      });

      const attached = await this._sendDirectCommand('Target.attachToTarget', {
        targetId,
        flatten: true
      });
      tab.upstreamSessionId = attached.sessionId;

      if (container) {
        await this._configureContainerOnUpstreamSession(tab);
      }
      if (targetUrl && targetUrl !== 'about:blank') {
        await this._sendDirectCommand('Page.navigate', { url: targetUrl }, tab.upstreamSessionId);
      }
      this._broadcastNewTabToMcpClients(tab);
      return tab;
    }

    // Pure virtual/standby tab (used when running offline conformance tests)
    const tabId = ++this._syntheticTabSeq;
    const tab = this._ensureTabRecord({
      tabId,
      url: targetUrl,
      title: targetUrl,
      containerName: container ? container.name : null
    });
    this._broadcastNewTabToMcpClients(tab);
    return tab;
  }

  async _configureContainerOnUpstreamSession(tab) {
    if (!tab.containerName) return;
    const initScript = this.vault.buildInitScript(tab.containerName);
    await this._forwardTabCdpCommand(tab, 'Network.enable', {}).catch(() => {});
    await this._forwardTabCdpCommand(tab, 'Network.setCacheDisabled', {
      cacheDisabled: true
    }).catch(() => {});
    await this._forwardTabCdpCommand(tab, 'Network.setBypassServiceWorker', {
      bypass: true
    }).catch(() => {});
    await this._forwardTabCdpCommand(tab, 'Runtime.addBinding', {
      name: '__chrometether_vault_sync'
    }).catch(() => {});
    await this._forwardTabCdpCommand(tab, 'Page.enable', {}).catch(() => {});
    await this._forwardTabCdpCommand(tab, 'Page.addScriptToEvaluateOnNewDocument', {
      source: initScript
    }).catch(() => {});
  }

  async _forwardTabCdpCommand(tab, method, params = {}) {
    if (this.extSocket && this.extSocket.readyState === WS_STATE.OPEN && !tab.upstreamTargetId) {
      return this._sendExtensionRequest('cdp_command', {
        tabId: Number(tab.tabId),
        method,
        params
      });
    }

    if (this.directWs && this.directWs.readyState === WS_STATE.OPEN && tab.upstreamTargetId) {
      if (!tab.upstreamSessionId) {
        const attached = await this._sendDirectCommand('Target.attachToTarget', {
          targetId: tab.upstreamTargetId,
          flatten: true
        });
        tab.upstreamSessionId = attached.sessionId;
      }
      return this._sendDirectCommand(method, params, tab.upstreamSessionId);
    }

    // Emulated responses in standby / virtual mode
    if (method === 'Page.getFrameTree') {
      return {
        frameTree: tab.frameTree || {
          frame: {
            id: `main-frame-${tab.key}`,
            loaderId: `loader-${tab.key}`,
            url: tab.url || 'about:blank',
            domainAndRegistry: '',
            securityOrigin: tab.url || 'about:blank',
            mimeType: 'text/html'
          },
          childFrames: []
        }
      };
    }
    if (method === 'Page.navigate') {
      tab.url = params.url || tab.url;
      tab.title = tab.url;
      return { frameId: `main-frame-${tab.key}`, loaderId: `loader-${tab.key}` };
    }
    if (method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn') {
      return {
        result: { type: 'string', value: 'ok' }
      };
    }
    if (method === 'DOM.getDocument') {
      return {
        root: {
          nodeId: 1,
          backendNodeId: 1,
          nodeType: 9,
          nodeName: '#document',
          localName: '',
          nodeValue: '',
          childNodeCount: 1,
          documentURL: tab.url || 'about:blank',
          baseURL: tab.url || 'about:blank'
        }
      };
    }
    return {};
  }

  _handleUpstreamTabCdpEvent(tab, method, params) {
    // Cache Runtime execution contexts for secondary session replay (Fixes Fable H1)
    if (method === 'Runtime.executionContextCreated' && params.context) {
      tab.executionContexts.set(params.context.id, params.context);
    } else if (method === 'Runtime.executionContextDestroyed' && params.executionContextId) {
      tab.executionContexts.delete(params.executionContextId);
    } else if (method === 'Runtime.executionContextsCleared') {
      tab.executionContexts.clear();
    }

    // Handle in-page ContainerVault sync binding calls
    if (method === 'Runtime.bindingCalled' && params.name === '__chrometether_vault_sync') {
      try {
        const data = JSON.parse(params.payload);
        const cName = data.container || tab.containerName;
        if (cName) {
          if (data.type === 'setCookie' && data.cookie) {
            this.vault.applySetCookieHeaders(cName, [data.cookie], data.url || tab.url);
            this._syncContainerDnrRules(cName).catch(() => {});
          } else if (data.type === 'storageSet') {
            this.vault.setStorageItem(cName, data.origin, data.key, data.value, {
              session: Boolean(data.session)
            });
          } else if (data.type === 'storageRemove') {
            this.vault.removeStorageItem(cName, data.origin, data.key, {
              session: Boolean(data.session)
            });
          } else if (data.type === 'storageClear') {
            this.vault.clearStorageOrigin(cName, data.origin, {
              session: Boolean(data.session)
            });
          }
        }
      } catch {
        // ignore
      }
      return;
    }

    // Capture raw Set-Cookie headers from Network.responseReceivedExtraInfo into Vault
    if (method === 'Network.responseReceivedExtraInfo' && tab.containerName && params.headers) {
      const rawSetCookie =
        params.headers['set-cookie'] ||
        params.headers['Set-Cookie'] ||
        params.headers['SET-COOKIE'];
      if (rawSetCookie) {
        const list = String(rawSetCookie)
          .split(/\r?\n/)
          .map(s => s.trim())
          .filter(Boolean);
        if (list.length > 0) {
          const changed = this.vault.applySetCookieHeaders(tab.containerName, list, tab.url);
          if (changed) {
            this._syncContainerDnrRules(tab.containerName).catch(() => {});
          }
        }
      }
    }

    // Broadcast event to all virtual page sessions attached to this tab across all MCP clients
    for (const client of this.mcpClients.values()) {
      for (const [vSessionId, sessionInfo] of client.sessions.entries()) {
        if (sessionInfo.tabKey === tab.key && sessionInfo.kind === 'page') {
          this._sendMcpEvent(client, method, params, vSessionId);
        }
      }
    }
  }

  // ============================================================================
  // MCP Client (/cdp) Protocol Emulation & Multiplexing (Fable Section 3.1 & 3.2)
  // ============================================================================

  _onMcpClientConnected(ws) {
    const clientId = `mcp-${++this._clientSeq}`;
    const client = {
      id: clientId,
      ws,
      discoverTargets: false,
      autoAttach: false,
      sessionSeq: 0,
      sessions: new Map() // vSessionId -> { kind: 'tab' | 'page', tabKey }
    };
    this.mcpClients.set(clientId, client);

    ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      this._handleMcpClientCommand(client, msg).catch(err => {
        if (msg && msg.id !== undefined) {
          this._sendMcpError(client, msg.id, err.message, msg.sessionId);
        }
      });
    });

    ws.on('error', () => {
      // Handled by close event
    });

    ws.on('close', () => {
      this._cleanupMcpClient(client);
      this.mcpClients.delete(clientId);
    });
  }

  _cleanupMcpClient(client) {
    for (const [vSessionId, sInfo] of client.sessions.entries()) {
      const tab = this.tabs.get(sInfo.tabKey);
      if (!tab) continue;
      for (const set of Object.values(tab.domainRefCounts)) {
        set.delete(vSessionId);
      }
    }
    client.sessions.clear();
  }

  _sendMcpResponse(client, id, result = {}, sessionId = undefined) {
    if (client.ws.readyState !== WS_STATE.OPEN) return;
    const payload = { id, result };
    if (sessionId) payload.sessionId = sessionId;
    client.ws.send(JSON.stringify(payload));
  }

  _sendMcpError(client, id, message, sessionId = undefined, code = -32000) {
    if (client.ws.readyState !== WS_STATE.OPEN) return;
    const payload = {
      id,
      error: { code, message: String(message || 'CDP error') }
    };
    if (sessionId) payload.sessionId = sessionId;
    client.ws.send(JSON.stringify(payload));
  }

  _sendMcpEvent(client, method, params = {}, sessionId = undefined) {
    if (client.ws.readyState !== WS_STATE.OPEN) return;
    const payload = { method, params };
    if (sessionId) payload.sessionId = sessionId;
    client.ws.send(JSON.stringify(payload));
  }

  _buildTargetInfo(tab, type = 'page') {
    const info = {
      targetId: type === 'tab' ? tab.tabTargetId : tab.pageTargetId,
      type,
      title: tab.title || tab.url || 'about:blank',
      url: tab.url || 'about:blank',
      attached: true,
      canAccessOpener: false
    };
    if (tab.browserContextId) {
      info.browserContextId = tab.browserContextId;
    }
    return info;
  }

  _ensureClientTabAndPageSessions(client, tab) {
    let tabSessionId = null;
    let pageSessionId = null;
    for (const [sId, sInfo] of client.sessions.entries()) {
      if (sInfo.tabKey === tab.key && sInfo.kind === 'tab' && !tabSessionId) {
        tabSessionId = sId;
      }
      if (sInfo.tabKey === tab.key && sInfo.kind === 'page' && !pageSessionId) {
        pageSessionId = sId;
      }
    }
    if (!tabSessionId) {
      tabSessionId = `tsess-${client.id}-${tab.key}-${++client.sessionSeq}`;
      client.sessions.set(tabSessionId, { kind: 'tab', tabKey: tab.key });
    }
    if (!pageSessionId) {
      pageSessionId = `psess-${client.id}-${tab.key}-${++client.sessionSeq}`;
      client.sessions.set(pageSessionId, { kind: 'page', tabKey: tab.key });
    }
    return { tabSessionId, pageSessionId };
  }

  _broadcastNewTabToMcpClients(tab) {
    if (!tab.attachable) return;
    for (const client of this.mcpClients.values()) {
      if (client.discoverTargets) {
        this._sendMcpEvent(client, 'Target.targetCreated', {
          targetInfo: this._buildTargetInfo(tab, 'page')
        });
      }
      if (client.autoAttach) {
        const { tabSessionId } = this._ensureClientTabAndPageSessions(client, tab);
        this._sendMcpEvent(client, 'Target.attachedToTarget', {
          sessionId: tabSessionId,
          targetInfo: this._buildTargetInfo(tab, 'tab'),
          waitingForDebugger: false
        });
      }
    }
  }

  _broadcastTargetInfoChanged(tab) {
    if (!tab.attachable) return;
    for (const client of this.mcpClients.values()) {
      if (client.discoverTargets || client.autoAttach) {
        this._sendMcpEvent(client, 'Target.targetInfoChanged', {
          targetInfo: this._buildTargetInfo(tab, 'page')
        });
      }
    }
  }

  _handleTabClosed(tabKey) {
    const tab = this.tabs.get(String(tabKey));
    if (!tab) return;
    this.tabs.delete(String(tabKey));

    for (const client of this.mcpClients.values()) {
      for (const [vSessionId, sInfo] of client.sessions.entries()) {
        if (sInfo.tabKey === tab.key) {
          this._sendMcpEvent(client, 'Target.detachedFromTarget', {
            sessionId: vSessionId,
            targetId: sInfo.kind === 'tab' ? tab.tabTargetId : tab.pageTargetId
          });
          client.sessions.delete(vSessionId);
        }
      }
      if (client.discoverTargets || client.autoAttach) {
        this._sendMcpEvent(client, 'Target.targetDestroyed', {
          targetId: tab.pageTargetId
        });
        this._sendMcpEvent(client, 'Target.targetDestroyed', {
          targetId: tab.tabTargetId
        });
      }
    }
  }

  async _handleMcpClientCommand(client, msg) {
    const { id, method, params = {}, sessionId } = msg;

    // 1. Session-scoped commands (either `tab` session or `page` session)
    if (sessionId) {
      const sInfo = client.sessions.get(sessionId);
      if (!sInfo) {
        this._sendMcpError(client, id, `Session ${sessionId} not found`, sessionId);
        return;
      }
      const tab = this.tabs.get(sInfo.tabKey);
      if (!tab) {
        this._sendMcpError(client, id, `Target for session ${sessionId} no longer exists`, sessionId);
        return;
      }

      if (sInfo.kind === 'tab') {
        // Step 5 of Fable 3.1: Puppeteer sends `Target.setAutoAttach` and `Runtime.runIfWaitingForDebugger` on the tab session
        if (method === 'Target.setAutoAttach') {
          const { pageSessionId } = this._ensureClientTabAndPageSessions(client, tab);
          this._sendMcpEvent(
            client,
            'Target.attachedToTarget',
            {
              sessionId: pageSessionId,
              targetInfo: this._buildTargetInfo(tab, 'page'),
              waitingForDebugger: false
            },
            sessionId
          );
          this._sendMcpResponse(client, id, {}, sessionId);
          return;
        }
        if (method === 'Runtime.runIfWaitingForDebugger') {
          this._sendMcpResponse(client, id, {}, sessionId);
          return;
        }
        this._sendMcpResponse(client, id, {}, sessionId);
        return;
      }

      // Page-session commands
      await this._handlePageSessionCommand(client, tab, sessionId, id, method, params);
      return;
    }

    // 2. Browser-level commands (no sessionId)
    if (method === 'Browser.getVersion') {
      this._sendMcpResponse(client, id, {
        protocolVersion: '1.3',
        product: 'Chrome/149.0.0.0',
        revision: '@chrometether',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
        jsVersion: '13.0.0'
      });
      return;
    }

    if (method === 'Target.getBrowserContexts') {
      // Deterministic order so isolated-context-1, isolated-context-2 map deterministically (Fable B2)
      const browserContextIds = this.vault.listContainers().map(c => c.contextId);
      this._sendMcpResponse(client, id, { browserContextIds });
      return;
    }

    if (method === 'Target.createBrowserContext') {
      let containerName = params.containerName || null;
      if (!containerName && this.pendingContextQueue.length > 0) {
        containerName = this.pendingContextQueue.shift();
      }
      if (!containerName) {
        containerName = `ctx-${++this._anonContainerSeq}`;
      }
      const entry = this.vault.ensureContainer(containerName, { color: params.color });
      this._sendMcpResponse(client, id, { browserContextId: entry.contextId });
      return;
    }

    if (method === 'Target.disposeBrowserContext') {
      this._sendMcpResponse(client, id, {});
      return;
    }

    if (method === 'Target.setDiscoverTargets') {
      client.discoverTargets = Boolean(params.discover);
      if (client.discoverTargets) {
        // Ensure at least one default tab exists if none have been discovered yet
        if (this.tabs.size === 0) {
          await this.ensureDirectUpstream();
          if (this.tabs.size === 0 && (!this.extSocket || this.extSocket.readyState !== WS_STATE.OPEN)) {
            this._ensureTabRecord({
              tabId: 1,
              url: 'about:blank',
              title: 'New Tab'
            });
          }
        }
        // Step 3 of Fable 3.1: Emit Target.targetCreated for every attachable target BEFORE replying
        for (const tab of this.tabs.values()) {
          if (!tab.attachable) continue;
          this._sendMcpEvent(client, 'Target.targetCreated', {
            targetInfo: this._buildTargetInfo(tab, 'page')
          });
        }
      }
      this._sendMcpResponse(client, id, {});
      return;
    }

    if (method === 'Target.setAutoAttach') {
      client.autoAttach = Boolean(params.autoAttach);
      if (client.autoAttach) {
        // Step 4 of Fable 3.1: Emit Target.attachedToTarget for `type: 'tab'` per attachable tab
        for (const tab of this.tabs.values()) {
          if (!tab.attachable) continue;
          const { tabSessionId } = this._ensureClientTabAndPageSessions(client, tab);
          this._sendMcpEvent(client, 'Target.attachedToTarget', {
            sessionId: tabSessionId,
            targetInfo: this._buildTargetInfo(tab, 'tab'),
            waitingForDebugger: false
          });
        }
      }
      this._sendMcpResponse(client, id, {});
      return;
    }

    if (method === 'Target.getTargets') {
      const targetInfos = [];
      for (const tab of this.tabs.values()) {
        if (!tab.attachable) continue;
        targetInfos.push(this._buildTargetInfo(tab, 'page'));
      }
      this._sendMcpResponse(client, id, { targetInfos });
      return;
    }

    if (method === 'Target.attachToTarget') {
      // Step 8 of Fable 3.1: Secondary CDP session per page (`McpPage.#initDevToolsUniverseNoThrow` & `emulate`)
      const targetId = params.targetId;
      const tab = Array.from(this.tabs.values()).find(
        t => t.pageTargetId === targetId || t.tabTargetId === targetId || t.key === String(targetId)
      );
      if (!tab) {
        this._sendMcpError(client, id, `Target ${targetId} not found`);
        return;
      }
      const kind = targetId === tab.tabTargetId ? 'tab' : 'page';
      const newSessionId = `${kind === 'tab' ? 'tsess' : 'psess'}-${client.id}-${tab.key}-${++client.sessionSeq}`;
      client.sessions.set(newSessionId, { kind, tabKey: tab.key });

      this._sendMcpEvent(client, 'Target.attachedToTarget', {
        sessionId: newSessionId,
        targetInfo: this._buildTargetInfo(tab, kind),
        waitingForDebugger: false
      });
      this._sendMcpResponse(client, id, { sessionId: newSessionId });
      return;
    }

    if (method === 'Target.detachFromTarget') {
      const targetSessionId = params.sessionId;
      if (targetSessionId && client.sessions.has(targetSessionId)) {
        const sInfo = client.sessions.get(targetSessionId);
        const tab = this.tabs.get(sInfo.tabKey);
        if (tab) {
          for (const set of Object.values(tab.domainRefCounts)) {
            set.delete(targetSessionId);
          }
        }
        client.sessions.delete(targetSessionId);
      }
      this._sendMcpResponse(client, id, {});
      return;
    }

    if (method === 'Target.createTarget') {
      // Step 9 of Fable 3.1: Same-window tab creation (with container context or URL hash hint)
      let containerName = null;
      if (params.browserContextId) {
        const fromCtx = this.vault.getContainerByContextId(params.browserContextId);
        containerName = fromCtx ? fromCtx.name : fromVirtualContextId(params.browserContextId);
      }
      const tab = await this.createContainerTab({
        containerName,
        url: params.url || 'about:blank',
        background: Boolean(params.background)
      });
      this._sendMcpResponse(client, id, { targetId: tab.pageTargetId });
      return;
    }

    if (method === 'Target.closeTarget') {
      const targetId = params.targetId;
      const tab = Array.from(this.tabs.values()).find(
        t => t.pageTargetId === targetId || t.tabTargetId === targetId || t.key === String(targetId)
      );
      if (tab) {
        if (this.extSocket?.readyState === WS_STATE.OPEN && !tab.upstreamTargetId) {
          await this._sendExtensionRequest('close_tab', { tabId: Number(tab.tabId) }).catch(() => {});
        } else if (this.directWs?.readyState === WS_STATE.OPEN && tab.upstreamTargetId) {
          await this._sendDirectCommand('Target.closeTarget', {
            targetId: tab.upstreamTargetId
          }).catch(() => {});
        }
        this._handleTabClosed(tab.key);
      }
      this._sendMcpResponse(client, id, { success: true });
      return;
    }

    if (method === 'Target.activateTarget') {
      const targetId = params.targetId;
      const tab = Array.from(this.tabs.values()).find(
        t => t.pageTargetId === targetId || t.tabTargetId === targetId
      );
      if (tab && this.extSocket?.readyState === WS_STATE.OPEN && !tab.upstreamTargetId) {
        await this._sendExtensionRequest('activate_tab', { tabId: Number(tab.tabId) }).catch(() => {});
      } else if (tab && this.directWs?.readyState === WS_STATE.OPEN && tab.upstreamTargetId) {
        await this._sendDirectCommand('Target.activateTarget', {
          targetId: tab.upstreamTargetId
        }).catch(() => {});
      }
      this._sendMcpResponse(client, id, {});
      return;
    }

    if (method === 'Browser.getWindowForTarget') {
      this._sendMcpResponse(client, id, {
        windowId: 1,
        bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: 'normal' }
      });
      return;
    }

    if (method === 'Browser.getWindowBounds') {
      this._sendMcpResponse(client, id, {
        bounds: { left: 0, top: 0, width: 1280, height: 800, windowState: 'normal' }
      });
      return;
    }

    if (method === 'Browser.setWindowBounds') {
      this._sendMcpResponse(client, id, {});
      return;
    }

    this._sendMcpResponse(client, id, {});
  }

  async _handlePageSessionCommand(client, tab, sessionId, id, method, params) {
    // Domain enable/disable ref-counting & state replay (Fixes Fable H1)
    const [domain, action] = String(method).split('.');
    if (action === 'enable' && tab.domainRefCounts[domain]) {
      const refSet = tab.domainRefCounts[domain];
      const wasEmpty = refSet.size === 0;
      refSet.add(sessionId);

      if (wasEmpty) {
        await this._forwardTabCdpCommand(tab, method, params).catch(() => {});
      }
      this._sendMcpResponse(client, id, {}, sessionId);

      // Replay cached Runtime.executionContextCreated events to this session!
      if (domain === 'Runtime') {
        if (tab.executionContexts.size === 0) {
          tab.executionContexts.set(1, {
            id: 1,
            origin: tab.url || 'about:blank',
            name: '',
            uniqueId: `ctx-main-${tab.key}`,
            auxData: { isDefault: true, type: 'default', frameId: `main-frame-${tab.key}` }
          });
        }
        for (const ctx of tab.executionContexts.values()) {
          this._sendMcpEvent(
            client,
            'Runtime.executionContextCreated',
            { context: ctx },
            sessionId
          );
        }
      }
      return;
    }

    if (action === 'disable' && tab.domainRefCounts[domain]) {
      const refSet = tab.domainRefCounts[domain];
      refSet.delete(sessionId);
      if (refSet.size === 0) {
        await this._forwardTabCdpCommand(tab, method, params).catch(() => {});
      }
      this._sendMcpResponse(client, id, {}, sessionId);
      return;
    }

    if (method === 'Target.setAutoAttach' || method === 'Runtime.runIfWaitingForDebugger') {
      this._sendMcpResponse(client, id, {}, sessionId);
      return;
    }

    if (method === 'Page.navigate') {
      const hint = extractUrlContainerHint(params.url);
      let targetUrl = hint.cleanUrl || params.url;
      if (hint.containerName && tab.containerName !== hint.containerName) {
        const entry = this.vault.ensureContainer(hint.containerName);
        tab.containerName = entry.name;
        tab.browserContextId = entry.contextId;
        await this._configureContainerOnUpstreamSession(tab);
        await this._syncTabDnrRules(tab);
        if (this.extSocket?.readyState === WS_STATE.OPEN && !tab.upstreamTargetId) {
          await this._sendExtensionRequest('assign_tab_container', {
            tabId: Number(tab.tabId),
            containerName: entry.name,
            color: entry.color,
            badge: entry.badge,
            initScript: this.vault.buildInitScript(entry.name),
            dnrRules: this.vault.buildDnrSessionRulesForTab(entry.name, Number(tab.tabId))
          }).catch(() => {});
        }
      }

      const navRes = await this._forwardTabCdpCommand(tab, 'Page.navigate', {
        ...params,
        url: targetUrl
      });
      tab.url = targetUrl;
      tab.title = targetUrl;
      const mainCtx = tab.executionContexts.get(1);
      if (mainCtx) mainCtx.origin = targetUrl;
      this._broadcastTargetInfoChanged(tab);

      this._sendMcpResponse(
        client,
        id,
        navRes && navRes.frameId
          ? navRes
          : { frameId: `main-frame-${tab.key}`, loaderId: `loader-${tab.key}` },
        sessionId
      );

      // Emit lifecycle events so Puppeteer's Page.navigate resolves promptly in standby/virtual mode
      if (!tab.upstreamTargetId && (!this.extSocket || this.extSocket.readyState !== WS_STATE.OPEN)) {
        const frameId = `main-frame-${tab.key}`;
        const loaderId = `loader-${tab.key}`;
        this._sendMcpEvent(
          client,
          'Page.frameNavigated',
          {
            frame: {
              id: frameId,
              loaderId,
              url: targetUrl,
              domainAndRegistry: '',
              securityOrigin: targetUrl,
              mimeType: 'text/html'
            }
          },
          sessionId
        );
        for (const name of ['init', 'DOMContentLoaded', 'load', 'networkIdle']) {
          this._sendMcpEvent(
            client,
            'Page.lifecycleEvent',
            { frameId, loaderId, name, timestamp: Date.now() / 1000 },
            sessionId
          );
        }
      }
      return;
    }

    if (method === 'Page.close') {
      this._handleTabClosed(tab.key);
      this._sendMcpResponse(client, id, {}, sessionId);
      return;
    }

    const res = await this._forwardTabCdpCommand(tab, method, params);
    this._sendMcpResponse(client, id, res || {}, sessionId);
  }
}

// Allow running `node src/cdp-hub/server.js` directly as a background daemon
const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

if (isMain) {
  let cliPort;
  let cliToken;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--port=')) {
      cliPort = Number.parseInt(arg.slice('--port='.length), 10);
    } else if (arg.startsWith('--token=')) {
      cliToken = arg.slice('--token='.length).trim();
    }
  }
  const hub = new CdpHubServer({
    ...(Number.isInteger(cliPort) && cliPort > 0 ? { port: cliPort } : {}),
    ...(cliToken ? { token: cliToken } : {}),
    autoConnectDirectCdp: true
  });
  hub.start().catch(err => {
    process.stderr.write(`ChromeTether CDP Hub failed to start: ${err.message}\n`);
    process.exit(1);
  });
}
