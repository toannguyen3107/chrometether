// ChromeTether MV3 Background Service Worker
// Full Standalone + AI Hub Bridge Architecture:
// 1. Works 100% STANDALONE in Chrome (no Hub required to create containers, open container tabs,
//    isolate cookies via DNR tabIds, or virtualize localStorage/sessionStorage/document.cookie).
// 2. Persists all containers, cookies, localStorage, and tab assignments in chrome.storage.local.
// 3. Automatically two-way syncs with the Local CDP Hub (ws://127.0.0.1:19222/ext) whenever an AI Agent runs.

const HUB_HEALTH_URL = 'http://127.0.0.1:19222/health';
const HUB_WS_URL = 'ws://127.0.0.1:19222/ext';
const KEEPALIVE_INTERVAL_MS = 20000;

const COLOR_BADGES = {
  blue: '🔵',
  orange: '🟠',
  green: '🟢',
  purple: '🟣',
  pink: '🩷',
  cyan: '🩵',
  yellow: '🟡',
  red: '🔴',
  grey: '⚪'
};

let ws = null;
let isConnecting = false;
let reconnectTimer = null;
let keepAliveTimer = null;
let hubToken = null;

// Persistent container vault in the extension:
// containerName -> { name, color, badge, createdAt, cookies: [], localStorage: {}, sessionStorage: {} }
const localVault = new Map();

// tabId (number) -> { containerName, color, badge }
const tabContainers = new Map();

// Set of tabIds with active chrome.debugger attachment
const attachedTabs = new Set();

function normalizeName(raw) {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return cleaned || 'acc-1';
}

function domainMatches(requestHost, cookieDomain, hostOnly = false) {
  const host = String(requestHost || '').toLowerCase().replace(/^\.+/, '');
  const dom = String(cookieDomain || '').toLowerCase().replace(/^\.+/, '');
  if (!host || !dom) return false;
  if (host === dom) return true;
  if (hostOnly) return false;
  return host.endsWith(`.${dom}`);
}

function computeDefaultCookiePath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname === '/') {
    return '/';
  }
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

function parseSetCookieHeaderLocal(setCookieStr, requestUrl) {
  if (typeof setCookieStr !== 'string' || !setCookieStr.trim()) return null;
  let parsedUrl;
  try {
    parsedUrl = new URL(requestUrl);
  } catch {
    return null;
  }

  const parts = setCookieStr.split(';').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const firstEq = parts[0].indexOf('=');
  if (firstEq <= 0) return null;

  const name = parts[0].slice(0, firstEq).trim();
  const value = parts[0].slice(firstEq + 1).trim();
  if (!name) return null;

  const reqHost = parsedUrl.hostname.toLowerCase();
  let domain = reqHost;
  let hostOnly = true;
  let path = computeDefaultCookiePath(parsedUrl.pathname);
  let secure = false;
  let httpOnly = false;
  let sameSite = 'Lax';
  let expires = null;
  let hasMaxAge = false;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const eqIdx = part.indexOf('=');
    const attrName = (eqIdx === -1 ? part : part.slice(0, eqIdx)).trim().toLowerCase();
    const attrVal = eqIdx === -1 ? '' : part.slice(eqIdx + 1).trim();

    if (attrName === 'domain' && attrVal) {
      const cleanDom = attrVal.toLowerCase().replace(/^\.+/, '');
      if (domainMatches(reqHost, cleanDom, false)) {
        domain = cleanDom;
        hostOnly = false;
      } else {
        return null;
      }
    } else if (attrName === 'path' && attrVal) {
      path = attrVal.startsWith('/') ? attrVal : computeDefaultCookiePath(parsedUrl.pathname);
    } else if (attrName === 'secure') {
      secure = true;
    } else if (attrName === 'httponly') {
      httpOnly = true;
    } else if (attrName === 'samesite' && attrVal) {
      const lower = attrVal.toLowerCase();
      sameSite = lower === 'strict' ? 'Strict' : lower === 'none' ? 'None' : 'Lax';
    } else if (attrName === 'max-age' && attrVal !== '') {
      const sec = Number.parseInt(attrVal, 10);
      if (!Number.isNaN(sec)) {
        hasMaxAge = true;
        expires = sec <= 0 ? 0 : Date.now() + sec * 1000;
      }
    } else if (attrName === 'expires' && attrVal && !hasMaxAge) {
      const ts = Date.parse(attrVal);
      if (!Number.isNaN(ts)) expires = ts;
    }
  }

  return {
    name,
    value,
    domain,
    hostOnly,
    path,
    secure,
    httpOnly,
    sameSite,
    expires,
    createdAt: Date.now()
  };
}

function ensureContainerInLocalVault(rawName, color = 'blue') {
  const name = normalizeName(rawName);
  let entry = localVault.get(name);
  if (!entry) {
    const chosenColor = COLOR_BADGES[color] ? color : 'blue';
    entry = {
      name,
      color: chosenColor,
      badge: COLOR_BADGES[chosenColor] || '🔵',
      createdAt: Date.now(),
      cookies: [],
      localStorage: {},
      sessionStorage: {}
    };
    localVault.set(name, entry);
  } else if (color && COLOR_BADGES[color] && entry.color !== color) {
    entry.color = color;
    entry.badge = COLOR_BADGES[color];
  }
  return entry;
}

function applySetCookiesToLocalVault(containerName, setCookieHeaders, requestUrl) {
  const entry = ensureContainerInLocalVault(containerName);
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  const now = Date.now();
  let changed = false;

  for (const raw of list) {
    const parsed = parseSetCookieHeaderLocal(raw, requestUrl);
    if (!parsed) continue;
    const idx = entry.cookies.findIndex(
      c =>
        c.name === parsed.name &&
        c.domain === parsed.domain &&
        c.path === parsed.path &&
        Boolean(c.hostOnly) === Boolean(parsed.hostOnly)
    );
    if (parsed.expires !== null && parsed.expires <= now) {
      if (idx !== -1) {
        entry.cookies.splice(idx, 1);
        changed = true;
      }
      continue;
    }
    if (idx !== -1) {
      parsed.createdAt = entry.cookies[idx].createdAt || now;
      entry.cookies[idx] = parsed;
    } else {
      entry.cookies.push(parsed);
    }
    changed = true;
  }
  return changed;
}

function buildDnrRulesForLocalContainerTab(containerName, tabId, { failClosedBlocked = false } = {}) {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId) || numericTabId <= 0) return [];
  const baseRuleId = numericTabId * 100;

  if (failClosedBlocked) {
    return [
      {
        id: baseRuleId,
        priority: 1000,
        action: { type: 'block' },
        condition: { tabIds: [numericTabId], urlFilter: '*' }
      }
    ];
  }

  const rules = [
    {
      id: baseRuleId + 1,
      priority: 100,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [{ header: 'set-cookie', operation: 'remove' }]
      },
      condition: { tabIds: [numericTabId] }
    },
    {
      id: baseRuleId + 2,
      priority: 150,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'cookie', operation: 'remove' }]
      },
      condition: { tabIds: [numericTabId] }
    }
  ];

  const entry = localVault.get(normalizeName(containerName));
  if (!entry) return rules;

  const now = Date.now();
  entry.cookies = entry.cookies.filter(c => c.expires === null || c.expires > now);

  const byDomain = new Map();
  for (const c of entry.cookies) {
    if (!byDomain.has(c.domain)) byDomain.set(c.domain, []);
    byDomain.get(c.domain).push(c);
  }

  let offset = 3;
  for (const [domain, domainCookies] of byDomain.entries()) {
    if (offset >= 99) break;
    domainCookies.sort(
      (a, b) => b.path.length - a.path.length || (a.createdAt || 0) - (b.createdAt || 0)
    );
    const cookieHeaderValue = domainCookies.map(c => `${c.name}=${c.value}`).join('; ');
    const allSecure = domainCookies.every(c => c.secure);
    const condition = {
      tabIds: [numericTabId],
      requestDomains: [domain]
    };
    if (allSecure) condition.urlFilter = '|https*';

    rules.push({
      id: baseRuleId + offset,
      priority: 200,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'cookie', operation: 'set', value: cookieHeaderValue }]
      },
      condition
    });
    offset += 1;
  }

  return rules;
}

function buildInitScriptForLocalContainer(containerName) {
  const entry = ensureContainerInLocalVault(containerName);
  const now = Date.now();
  const jsCookies = entry.cookies
    .filter(c => !c.httpOnly && (c.expires === null || c.expires > now))
    .map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      hostOnly: Boolean(c.hostOnly),
      path: c.path || '/',
      secure: Boolean(c.secure),
      sameSite: c.sameSite || 'Lax',
      expires: c.expires
    }));

  const payload = JSON.stringify({
    container: entry.name,
    cookies: jsCookies,
    localStorage: entry.localStorage || {},
    sessionStorage: entry.sessionStorage || {}
  });

  return `(() => {
  if (window.__chrometetherContainerInitialized) return;
  Object.defineProperty(window, '__chrometetherContainerInitialized', { value: true, configurable: false });
  const state = ${payload};
  const notify = (msg) => {
    try {
      if (typeof window.__chrometether_vault_sync === 'function') {
        window.__chrometether_vault_sync(JSON.stringify({ container: state.container, ...msg }));
      }
    } catch {}
  };
  const domainMatches = (host, dom, hostOnly) => {
    const h = String(host || '').toLowerCase();
    const d = String(dom || '').toLowerCase().replace(/^\\.+/, '');
    if (!h || !d) return false;
    if (h === d) return true;
    return hostOnly ? false : h.endsWith('.' + d);
  };
  const pathMatches = (reqP, cookP) => {
    const r = String(reqP || '/');
    const c = String(cookP || '/');
    if (r === c) return true;
    return r.startsWith(c) && (c.endsWith('/') || r[c.length] === '/');
  };
  const getMatching = () => {
    const nowTs = Date.now();
    const isSecure = location.protocol === 'https:';
    const host = location.hostname.toLowerCase();
    const path = location.pathname || '/';
    return state.cookies.filter(c => {
      if (c.expires !== null && c.expires !== undefined && c.expires <= nowTs) return false;
      if (c.secure && !isSecure) return false;
      return domainMatches(host, c.domain, c.hostOnly) && pathMatches(path, c.path);
    });
  };
  const applyCookie = (rawStr) => {
    const str = String(rawStr || '').trim();
    if (!str) return;
    const parts = str.split(';').map(p => p.trim()).filter(Boolean);
    if (!parts.length) return;
    const eq = parts[0].indexOf('=');
    if (eq <= 0) return;
    const name = parts[0].slice(0, eq).trim();
    const value = parts[0].slice(eq + 1).trim();
    let domain = location.hostname.toLowerCase();
    let hostOnly = true;
    let path = '/';
    let secure = false;
    let expires = null;
    for (let i = 1; i < parts.length; i++) {
      const p = parts[i];
      const idx = p.indexOf('=');
      const k = (idx === -1 ? p : p.slice(0, idx)).trim().toLowerCase();
      const v = idx === -1 ? '' : p.slice(idx + 1).trim();
      if (k === 'domain' && v) { domain = v.toLowerCase().replace(/^\\.+/, ''); hostOnly = false; }
      else if (k === 'path' && v.startsWith('/')) path = v;
      else if (k === 'secure') secure = true;
      else if (k === 'max-age' && v !== '') {
        const sec = parseInt(v, 10);
        if (!Number.isNaN(sec)) expires = sec <= 0 ? 0 : Date.now() + sec * 1000;
      } else if (k === 'expires' && v && expires === null) {
        const ts = Date.parse(v);
        if (!Number.isNaN(ts)) expires = ts;
      } else if (k === 'httponly') return;
    }
    const idx = state.cookies.findIndex(c => c.name === name && c.domain === domain && c.path === path);
    if (expires !== null && expires <= Date.now()) {
      if (idx !== -1) state.cookies.splice(idx, 1);
    } else {
      const item = { name, value, domain, hostOnly, path, secure, sameSite: 'Lax', expires };
      if (idx !== -1) state.cookies[idx] = item;
      else state.cookies.push(item);
    }
    notify({ type: 'setCookie', cookie: str, url: location.href });
  };
  try {
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      enumerable: true,
      get() { return getMatching().map(c => c.name + '=' + c.value).join('; '); },
      set(val) { applyCookie(val); }
    });
  } catch {}
  const makeStorage = (bucketMap, isSession) => {
    const getBucket = () => {
      const origin = location.origin || 'null';
      if (!bucketMap[origin]) bucketMap[origin] = {};
      return bucketMap[origin];
    };
    const api = {
      getItem(k) { const b = getBucket(); return Object.prototype.hasOwnProperty.call(b, String(k)) ? b[String(k)] : null; },
      setItem(k, v) {
        const key = String(k), val = String(v), b = getBucket();
        b[key] = val;
        notify({ type: 'storageSet', session: isSession, origin: location.origin, key, value: val });
      },
      removeItem(k) { const key = String(k), b = getBucket(); delete b[key]; notify({ type: 'storageRemove', session: isSession, origin: location.origin, key }); },
      clear() { const origin = location.origin || 'null'; bucketMap[origin] = {}; notify({ type: 'storageClear', session: isSession, origin }); },
      key(i) { return Object.keys(getBucket())[i] ?? null; }
    };
    return new Proxy(api, {
      get(t, p) {
        if (p === 'length') return Object.keys(getBucket()).length;
        if (p in t) return t[p].bind(t);
        const b = getBucket();
        return Object.prototype.hasOwnProperty.call(b, p) ? b[p] : undefined;
      },
      set(t, p, v) { t.setItem(p, v); return true; },
      deleteProperty(t, p) { t.removeItem(p); return true; },
      ownKeys() { return Object.keys(getBucket()); },
      getOwnPropertyDescriptor(t, p) {
        const b = getBucket();
        return Object.prototype.hasOwnProperty.call(b, p) ? { enumerable: true, configurable: true, value: b[p], writable: true } : undefined;
      }
    });
  };
  try {
    Object.defineProperty(window, 'localStorage', { value: makeStorage(state.localStorage, false), configurable: true });
    Object.defineProperty(window, 'sessionStorage', { value: makeStorage(state.sessionStorage, true), configurable: true });
  } catch {}
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = () => Promise.reject(new DOMException('ServiceWorker disabled in ChromeTether Container Tab', 'SecurityError'));
    }
  } catch {}
})();`;
}

async function restoreSessionState() {
  try {
    const localData = await chrome.storage.local.get(['containersVault']);
    if (Array.isArray(localData?.containersVault)) {
      for (const c of localData.containersVault) {
        if (!c?.name) continue;
        localVault.set(c.name, {
          name: c.name,
          color: c.color || 'blue',
          badge: COLOR_BADGES[c.color] || '🔵',
          createdAt: c.createdAt || Date.now(),
          cookies: Array.isArray(c.cookies) ? c.cookies : [],
          localStorage: c.localStorage && typeof c.localStorage === 'object' ? c.localStorage : {},
          sessionStorage: {}
        });
      }
    }
    const sessData = await chrome.storage.session.get(['tabContainers']);
    if (sessData?.tabContainers && typeof sessData.tabContainers === 'object') {
      for (const [k, v] of Object.entries(sessData.tabContainers)) {
        const tabId = Number(k);
        if (Number.isInteger(tabId) && v?.containerName) {
          tabContainers.set(tabId, v);
          ensureContainerInLocalVault(v.containerName, v.color);
        }
      }
    }
  } catch {
    // ignore
  }
}

async function persistVaultAndTabs() {
  try {
    const containersVault = Array.from(localVault.values()).map(c => ({
      name: c.name,
      color: c.color,
      badge: c.badge,
      createdAt: c.createdAt,
      cookies: c.cookies,
      localStorage: c.localStorage
    }));
    await chrome.storage.local.set({ containersVault });

    const serializedTabs = {};
    for (const [tabId, info] of tabContainers.entries()) {
      serializedTabs[tabId] = info;
    }
    await chrome.storage.session.set({ tabContainers: serializedTabs });
  } catch {
    // ignore
  }
}

function getContainerSummaries() {
  const sorted = Array.from(localVault.values()).sort(
    (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.name.localeCompare(b.name)
  );
  return sorted.map(c => {
    let activeTabs = 0;
    for (const info of tabContainers.values()) {
      if (info.containerName === c.name) activeTabs += 1;
    }
    return {
      name: c.name,
      color: c.color,
      badge: c.badge || COLOR_BADGES[c.color] || '🔵',
      createdAt: c.createdAt,
      cookieCount: c.cookies.length,
      originsCount: Object.keys(c.localStorage || {}).length,
      activeTabs
    };
  });
}

function sendToHub(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function syncLocalVaultToHub() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const containers = Array.from(localVault.values()).map(c => ({
    name: c.name,
    color: c.color,
    createdAt: c.createdAt,
    cookies: c.cookies,
    localStorage: c.localStorage
  }));
  sendToHub({ type: 'ext_sync_containers', containers });
}

async function updateTabDnrSessionRules(tabId, newRules = []) {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId) || numericTabId <= 0) return;

  const minId = numericTabId * 100;
  const maxId = minId + 99;

  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const removeRuleIds = existing
      .filter(r => r.id >= minId && r.id <= maxId)
      .map(r => r.id);

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds,
      addRules: newRules
    });
  } catch (err) {
    console.warn('DNR updateSessionRules error for tab', numericTabId, err);
  }
}

async function clearTabDnrSessionRules(tabId) {
  await updateTabDnrSessionRules(tabId, []);
}

async function syncAllTabsForContainer(containerName) {
  const name = normalizeName(containerName);
  const initScript = buildInitScriptForLocalContainer(name);
  for (const [tabId, info] of tabContainers.entries()) {
    if (info.containerName === name) {
      info.initScript = initScript;
      const rules = buildDnrRulesForLocalContainerTab(name, tabId);
      await updateTabDnrSessionRules(tabId, rules);
    }
  }
}

async function engageFailClosedDnrBlock(tabId) {
  const rules = buildDnrRulesForLocalContainerTab('', tabId, { failClosedBlocked: true });
  await updateTabDnrSessionRules(tabId, rules);
}

async function ensureDebuggerAttached(tabId) {
  const numericTabId = Number(tabId);
  if (attachedTabs.has(numericTabId)) return true;
  try {
    await chrome.debugger.attach({ tabId: numericTabId }, '1.3');
    attachedTabs.add(numericTabId);
    return true;
  } catch (err) {
    if (String(err?.message || '').includes('Already attached')) {
      attachedTabs.add(numericTabId);
      return true;
    }
    return false;
  }
}

async function configureContainerDebuggerOnTab(tabId, containerInfo) {
  const numericTabId = Number(tabId);
  const ok = await ensureDebuggerAttached(numericTabId);
  if (!ok) {
    await engageFailClosedDnrBlock(numericTabId);
    return false;
  }

  const target = { tabId: numericTabId };
  try {
    await chrome.debugger.sendCommand(target, 'Network.enable', {});
    await chrome.debugger.sendCommand(target, 'Network.setCacheDisabled', {
      cacheDisabled: true
    });
    await chrome.debugger.sendCommand(target, 'Network.setBypassServiceWorker', {
      bypass: true
    });
    await chrome.debugger.sendCommand(target, 'Runtime.enable', {});
    await chrome.debugger.sendCommand(target, 'Runtime.addBinding', {
      name: '__chrometether_vault_sync'
    });
    await chrome.debugger.sendCommand(target, 'Page.enable', {});
    const scriptSource =
      containerInfo.initScript || buildInitScriptForLocalContainer(containerInfo.containerName);
    await chrome.debugger.sendCommand(target, 'Page.addScriptToEvaluateOnNewDocument', {
      source: scriptSource
    });
    await chrome.debugger
      .sendCommand(target, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      })
      .catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function placeTabInContainerGroup(
  tabId,
  windowId,
  containerName,
  color = 'blue',
  badge = '🔵'
) {
  try {
    const title = `${badge} ${containerName}`;
    const existingGroups = await chrome.tabGroups.query({ windowId, title });
    if (existingGroups && existingGroups.length > 0) {
      await chrome.tabs.group({ groupId: existingGroups[0].id, tabIds: [tabId] });
      return existingGroups[0].id;
    }
    const groupId = await chrome.tabs.group({
      createProperties: windowId ? { windowId } : undefined,
      tabIds: [tabId]
    });
    await chrome.tabGroups.update(groupId, {
      title,
      color: color || 'blue',
      collapsed: false
    });
    return groupId;
  } catch {
    return null;
  }
}

async function createContainerTabLocal({
  url = 'about:blank',
  background = false,
  containerName,
  color = 'blue',
  badge,
  initScript
}) {
  const created = await chrome.tabs.create({
    url: 'about:blank',
    active: !background
  });
  const tabId = created.id;

  if (containerName) {
    const entry = ensureContainerInLocalVault(containerName, color);
    const info = {
      containerName: entry.name,
      color: entry.color,
      badge: badge || entry.badge,
      initScript: initScript || buildInitScriptForLocalContainer(entry.name)
    };
    tabContainers.set(tabId, info);
    await persistVaultAndTabs();

    const dnrRules = buildDnrRulesForLocalContainerTab(entry.name, tabId);
    await updateTabDnrSessionRules(tabId, dnrRules);
    await placeTabInContainerGroup(
      tabId,
      created.windowId,
      entry.name,
      info.color,
      info.badge
    );
    await configureContainerDebuggerOnTab(tabId, info);
    syncLocalVaultToHub();
  }

  if (url && url !== 'about:blank') {
    await chrome.tabs.update(tabId, { url });
  }

  return {
    tabId,
    windowId: created.windowId,
    url,
    title: created.title || url
  };
}

async function convertTabToContainerLocal({
  tabId,
  containerName,
  color = 'blue',
  badge,
  initScript,
  dnrRules,
  originalUrl
}) {
  const numericTabId = Number(tabId);
  const tab = await chrome.tabs.get(numericTabId);
  const entry = ensureContainerInLocalVault(containerName, color);
  const info = {
    containerName: entry.name,
    color: entry.color,
    badge: badge || entry.badge,
    initScript: initScript || buildInitScriptForLocalContainer(entry.name)
  };
  tabContainers.set(numericTabId, info);
  await persistVaultAndTabs();

  await chrome.tabs.update(numericTabId, { url: 'about:blank' });
  const rulesToApply = Array.isArray(dnrRules)
    ? dnrRules
    : buildDnrRulesForLocalContainerTab(entry.name, numericTabId);
  await updateTabDnrSessionRules(numericTabId, rulesToApply);
  await placeTabInContainerGroup(
    numericTabId,
    tab.windowId,
    entry.name,
    info.color,
    info.badge
  );
  await configureContainerDebuggerOnTab(numericTabId, info);
  if (originalUrl && originalUrl !== 'about:blank') {
    await chrome.tabs.update(numericTabId, { url: originalUrl });
  }
  syncLocalVaultToHub();
  return { ok: true, tabId: numericTabId };
}

async function sendTabsSnapshot() {
  try {
    const tabs = await chrome.tabs.query({});
    const payload = tabs.map(t => ({
      tabId: t.id,
      windowId: t.windowId,
      url: t.url || t.pendingUrl || 'about:blank',
      title: t.title || '',
      containerName: tabContainers.get(t.id)?.containerName || null
    }));
    sendToHub({ type: 'ext_tabs_snapshot', tabs: payload });
  } catch {
    // ignore
  }
}

async function handleHubRequest(msg) {
  const { reqId, action, params = {} } = msg;
  try {
    let result = {};

    if (action === 'create_tab') {
      result = await createContainerTabLocal(params);
    } else if (action === 'convert_tab_to_container') {
      result = await convertTabToContainerLocal(params);
    } else if (action === 'assign_tab_container') {
      const { tabId, containerName, color, badge, initScript, dnrRules } = params;
      const numericTabId = Number(tabId);
      const tab = await chrome.tabs.get(numericTabId);
      const entry = ensureContainerInLocalVault(containerName, color);
      const info = {
        containerName: entry.name,
        color: entry.color,
        badge: badge || entry.badge,
        initScript: initScript || buildInitScriptForLocalContainer(entry.name)
      };
      tabContainers.set(numericTabId, info);
      await persistVaultAndTabs();
      const rules = Array.isArray(dnrRules)
        ? dnrRules
        : buildDnrRulesForLocalContainerTab(entry.name, numericTabId);
      await updateTabDnrSessionRules(numericTabId, rules);
      await placeTabInContainerGroup(
        numericTabId,
        tab.windowId,
        entry.name,
        info.color,
        info.badge
      );
      await configureContainerDebuggerOnTab(numericTabId, info);
      result = { ok: true };
    } else if (action === 'update_tab_dnr_rules') {
      const { tabId, rules } = params;
      await updateTabDnrSessionRules(Number(tabId), Array.isArray(rules) ? rules : []);
      result = { ok: true };
    } else if (action === 'close_tab') {
      const numericTabId = Number(params.tabId);
      await clearTabDnrSessionRules(numericTabId);
      tabContainers.delete(numericTabId);
      await persistVaultAndTabs();
      await chrome.tabs.remove(numericTabId);
      result = { ok: true };
    } else if (action === 'activate_tab') {
      const numericTabId = Number(params.tabId);
      const tab = await chrome.tabs.update(numericTabId, { active: true });
      if (tab?.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
      result = { ok: true };
    } else if (action === 'cdp_command') {
      const numericTabId = Number(params.tabId);
      await ensureDebuggerAttached(numericTabId);
      result =
        (await chrome.debugger.sendCommand(
          { tabId: numericTabId },
          params.method,
          params.params || {}
        )) || {};
    }

    sendToHub({ type: 'hub_response', reqId, result });
  } catch (err) {
    sendToHub({
      type: 'hub_response',
      reqId,
      error: err?.message || String(err)
    });
  }
}

// Observe raw Set-Cookie headers on container tabs (works both Standalone and with Hub!)
chrome.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.tabId <= 0 || !tabContainers.has(details.tabId)) return;
    const containerInfo = tabContainers.get(details.tabId);
    if (!containerInfo || !Array.isArray(details.responseHeaders)) return;

    const setCookies = details.responseHeaders
      .filter(h => h.name && h.name.toLowerCase() === 'set-cookie' && h.value)
      .map(h => h.value);

    if (setCookies.length > 0) {
      const changed = applySetCookiesToLocalVault(
        containerInfo.containerName,
        setCookies,
        details.url
      );
      if (changed) {
        persistVaultAndTabs();
        syncAllTabsForContainer(containerInfo.containerName);
      }
      sendToHub({
        type: 'ext_set_cookie_captured',
        tabId: details.tabId,
        containerName: containerInfo.containerName,
        url: details.url,
        setCookieHeaders: setCookies
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders']
);

chrome.tabs.onCreated.addListener(async tab => {
  if (tab.openerTabId && tabContainers.has(tab.openerTabId) && !tabContainers.has(tab.id)) {
    const parentInfo = tabContainers.get(tab.openerTabId);
    tabContainers.set(tab.id, { ...parentInfo });
    await persistVaultAndTabs();
    const rules = buildDnrRulesForLocalContainerTab(parentInfo.containerName, tab.id);
    await updateTabDnrSessionRules(tab.id, rules);
    await placeTabInContainerGroup(
      tab.id,
      tab.windowId,
      parentInfo.containerName,
      parentInfo.color,
      parentInfo.badge
    );
    await configureContainerDebuggerOnTab(tab.id, parentInfo);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
    sendToHub({
      type: 'ext_tab_updated',
      tab: {
        tabId,
        windowId: tab.windowId,
        url: tab.url || 'about:blank',
        title: tab.title || '',
        containerName: tabContainers.get(tabId)?.containerName || null
      }
    });
  }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  attachedTabs.delete(tabId);
  if (tabContainers.has(tabId)) {
    tabContainers.delete(tabId);
    await persistVaultAndTabs();
    await clearTabDnrSessionRules(tabId);
  }
  sendToHub({ type: 'ext_tab_removed', tabId });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;

  // Handle in-page document.cookie & localStorage sync binding locally even when Hub is offline!
  if (method === 'Runtime.bindingCalled' && params?.name === '__chrometether_vault_sync') {
    try {
      const data = JSON.parse(params.payload);
      const cName = data.container || tabContainers.get(source.tabId)?.containerName;
      if (cName) {
        const entry = ensureContainerInLocalVault(cName);
        if (data.type === 'setCookie' && data.cookie) {
          applySetCookiesToLocalVault(cName, [data.cookie], data.url);
          syncAllTabsForContainer(cName);
        } else if (data.type === 'storageSet' && data.origin) {
          const store = data.session ? entry.sessionStorage : entry.localStorage;
          if (!store[data.origin]) store[data.origin] = {};
          store[data.origin][String(data.key)] = String(data.value);
        } else if (data.type === 'storageRemove' && data.origin) {
          const store = data.session ? entry.sessionStorage : entry.localStorage;
          if (store[data.origin]) delete store[data.origin][String(data.key)];
        } else if (data.type === 'storageClear' && data.origin) {
          const store = data.session ? entry.sessionStorage : entry.localStorage;
          delete store[data.origin];
        }
        persistVaultAndTabs();
      }
    } catch {
      // ignore
    }
  }

  sendToHub({
    type: 'ext_cdp_event',
    tabId: source.tabId,
    method,
    params: params || {}
  });
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  if (!source.tabId) return;
  const tabId = source.tabId;
  attachedTabs.delete(tabId);

  if (tabContainers.has(tabId)) {
    const info = tabContainers.get(tabId);
    if (reason !== 'target_closed') {
      const reattached = await configureContainerDebuggerOnTab(tabId, info);
      if (!reattached) {
        await engageFailClosedDnrBlock(tabId);
        sendToHub({ type: 'ext_debugger_detached', tabId, reason });
      }
    }
  }
});

async function connectHub() {
  if (isConnecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  isConnecting = true;
  try {
    const healthResp = await fetch(HUB_HEALTH_URL, {
      method: 'GET',
      cache: 'no-store'
    });
    if (!healthResp.ok) {
      isConnecting = false;
      scheduleReconnect(4000);
      return;
    }
  } catch {
    isConnecting = false;
    scheduleReconnect(4000);
    return;
  }

  try {
    ws = hubToken
      ? new WebSocket(HUB_WS_URL, [`chrometether-token.${hubToken}`])
      : new WebSocket(HUB_WS_URL);
  } catch {
    isConnecting = false;
    scheduleReconnect(4000);
    return;
  }

  ws.onopen = async () => {
    isConnecting = false;
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => {
      sendToHub({ type: 'ping', ts: Date.now() });
    }, KEEPALIVE_INTERVAL_MS);

    await restoreSessionState();
    syncLocalVaultToHub();
    await sendTabsSnapshot();
  };

  ws.onmessage = event => {
    try {
      const msg = JSON.parse(String(event.data));
      if (msg.type === 'hub_hello') {
        if (msg.token) hubToken = msg.token;
        if (Array.isArray(msg.containers)) {
          for (const c of msg.containers) {
            if (c?.name) ensureContainerInLocalVault(c.name, c.color);
          }
          persistVaultAndTabs();
        }
        syncLocalVaultToHub();
        return;
      }
      if (msg.type === 'ping') {
        sendToHub({ type: 'pong', ts: Date.now() });
        return;
      }
      if (msg.type === 'hub_request') {
        handleHubRequest(msg);
      }
    } catch {
      // ignore
    }
  };

  ws.onclose = () => {
    isConnecting = false;
    ws = null;
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    scheduleReconnect(4000);
  };

  ws.onerror = () => {
    isConnecting = false;
    try {
      ws?.close();
    } catch {
      // ignore
    }
  };
}

function scheduleReconnect(delayMs = 4000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectHub();
  }, delayMs);
}

// Handle messages from Extension Popup UI — always executes locally first so it works 100% offline/standalone,
// and also syncs to Hub if Hub is connected!
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'popup_get_state') {
    connectHub();
    sendResponse({
      connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
      containers: getContainerSummaries(),
      activeContainerTabsCount: tabContainers.size
    });
    return true;
  }

  if (msg?.type === 'popup_action') {
    const payload = msg.payload || {};
    (async () => {
      if (payload.action === 'create_container_only') {
        ensureContainerInLocalVault(payload.containerName || 'acc-1', payload.color || 'blue');
        await persistVaultAndTabs();
        syncLocalVaultToHub();
      } else if (payload.action === 'open_container_tab') {
        await createContainerTabLocal({
          containerName: payload.containerName || 'acc-1',
          color: payload.color || 'blue',
          url: payload.url || 'about:blank',
          background: false
        });
      } else if (payload.action === 'convert_current_tab' && payload.tabId) {
        await convertTabToContainerLocal({
          tabId: payload.tabId,
          containerName: payload.containerName || 'acc-1',
          color: payload.color || 'blue',
          originalUrl: payload.url || 'about:blank'
        });
      } else if (payload.action === 'clear_container' && payload.containerName) {
        const entry = localVault.get(normalizeName(payload.containerName));
        if (entry) {
          entry.cookies = [];
          entry.localStorage = {};
          entry.sessionStorage = {};
          await persistVaultAndTabs();
          await syncAllTabsForContainer(entry.name);
        }
        sendToHub({ type: 'ext_popup_action', ...payload });
      } else if (payload.action === 'delete_container' && payload.containerName) {
        const name = normalizeName(payload.containerName);
        localVault.delete(name);
        for (const [tabId, info] of tabContainers.entries()) {
          if (info.containerName === name) {
            tabContainers.delete(tabId);
            await clearTabDnrSessionRules(tabId);
          }
        }
        await persistVaultAndTabs();
      }
      sendResponse({
        ok: true,
        connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
        containers: getContainerSummaries()
      });
    })();
    return true;
  }
  return false;
});

chrome.alarms.create('chrometether-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'chrometether-keepalive') {
    connectHub();
  }
});

restoreSessionState().then(() => connectHub());
