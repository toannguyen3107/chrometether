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

// tabId (number) -> { containerName, color, badge, groupId, groupingInProgress }
const tabContainers = new Map();

// groupId (number) -> containerName (string)
const groupContainers = new Map();

// Tombstone set of deleted container names so Hub reconnect never resurrects deleted containers
const deletedContainerNames = new Set();

// Guard set to prevent re-entrant delete loops while closing group/container tabs
const removingContainers = new Set();

// Guard counter and set to prevent premature ext_tab_updated / onCreated races during programmatic tab creation
let creatingTabCount = 0;
const initializingTabs = new Set();

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

  const isHttps = parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'wss:';
  if (name.startsWith('__Secure-') && (!secure || !isHttps)) {
    return null;
  }
  if (name.startsWith('__Host-') && (!secure || !isHttps || !hostOnly || path !== '/')) {
    return null;
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
  deletedContainerNames.delete(name);
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

function mergeHubContainerData(rawName, { color, createdAt, cookies, localStorage } = {}) {
  const entry = ensureContainerInLocalVault(rawName, color);
  if (createdAt && (!entry.createdAt || createdAt < entry.createdAt)) {
    entry.createdAt = createdAt;
  }
  const now = Date.now();
  if (Array.isArray(cookies)) {
    for (const c of cookies) {
      if (!c?.name || !c?.domain) continue;
      if (c.expires !== null && c.expires !== undefined && c.expires <= now) continue;
      const idx = entry.cookies.findIndex(
        existing =>
          existing.name === c.name &&
          existing.domain === c.domain &&
          existing.path === (c.path || '/') &&
          Boolean(existing.hostOnly) === Boolean(c.hostOnly)
      );
      if (idx === -1) {
        entry.cookies.push({
          name: String(c.name),
          value: String(c.value ?? ''),
          domain: String(c.domain).toLowerCase().replace(/^\.+/, ''),
          hostOnly: Boolean(c.hostOnly),
          path: c.path || '/',
          secure: Boolean(c.secure),
          httpOnly: Boolean(c.httpOnly),
          sameSite: c.sameSite || 'Lax',
          expires: c.expires ?? null,
          createdAt: c.createdAt || now
        });
      } else {
        entry.cookies[idx] = {
          ...entry.cookies[idx],
          value: String(c.value ?? ''),
          secure: Boolean(c.secure),
          httpOnly: Boolean(c.httpOnly),
          sameSite: c.sameSite || 'Lax',
          expires: c.expires ?? null
        };
      }
    }
  }
  if (localStorage && typeof localStorage === 'object') {
    for (const [origin, bucket] of Object.entries(localStorage)) {
      if (bucket && typeof bucket === 'object') {
        entry.localStorage[origin] = {
          ...(entry.localStorage[origin] || {}),
          ...bucket
        };
      }
    }
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
      const prev = entry.cookies[idx];
      parsed.createdAt = prev.createdAt || now;
      entry.cookies[idx] = parsed;
      if (
        prev.value !== parsed.value ||
        Boolean(prev.secure) !== Boolean(parsed.secure) ||
        Boolean(prev.httpOnly) !== Boolean(parsed.httpOnly) ||
        prev.sameSite !== parsed.sameSite
      ) {
        changed = true;
      }
    } else {
      entry.cookies.push(parsed);
      if (entry.cookies.length > 300) entry.cookies.shift();
      changed = true;
    }
  }
  return changed;
}

const DNR_ALL_RESOURCE_TYPES = [
  'main_frame',
  'sub_frame',
  'stylesheet',
  'script',
  'image',
  'font',
  'object',
  'xmlhttprequest',
  'ping',
  'csp_report',
  'media',
  'websocket',
  'webtransport',
  'webbundle',
  'other'
];

function getTabDnrBaseRuleId(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId) || numericTabId <= 0) return 0;
  return (((numericTabId - 1) % 19999999) + 1) * 100;
}

function domainMatchesCookie(host, cookieDomain, hostOnly = false) {
  const h = String(host || '').toLowerCase();
  const d = String(cookieDomain || '').toLowerCase().replace(/^\.+/, '');
  if (!h || !d) return false;
  if (h === d) return true;
  if (hostOnly) return false;
  return h.endsWith(`.${d}`);
}

function buildDnrRulesForLocalContainerTab(containerName, tabId, { failClosedBlocked = false } = {}) {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId) || numericTabId <= 0) return [];
  const baseRuleId = getTabDnrBaseRuleId(numericTabId);

  if (failClosedBlocked) {
    return [
      {
        id: baseRuleId,
        priority: 1000,
        action: { type: 'block' },
        condition: { tabIds: [numericTabId], urlFilter: '*', resourceTypes: [...DNR_ALL_RESOURCE_TYPES] }
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
      condition: { tabIds: [numericTabId], resourceTypes: [...DNR_ALL_RESOURCE_TYPES] }
    },
    {
      id: baseRuleId + 2,
      priority: 150,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'cookie', operation: 'remove' }]
      },
      condition: { tabIds: [numericTabId], resourceTypes: [...DNR_ALL_RESOURCE_TYPES] }
    }
  ];

  const entry = localVault.get(normalizeName(containerName));
  if (!entry) return rules;

  const now = Date.now();
  entry.cookies = entry.cookies.filter(c => c.expires === null || c.expires > now);

  const uniqueDomains = [...new Set(entry.cookies.map(c => c.domain).filter(Boolean))];

  let offset = 3;
  for (const domain of uniqueDomains) {
    if (offset >= 98) break;
    const domainCookies = entry.cookies.filter(c =>
      domainMatchesCookie(domain, c.domain, c.hostOnly)
    );
    if (domainCookies.length === 0) continue;

    domainCookies.sort(
      (a, b) => b.path.length - a.path.length || (a.createdAt || 0) - (b.createdAt || 0)
    );
    const specificity = Math.min(40, domain.split('.').length);
    const hasSecure = domainCookies.some(c => c.secure);
    const httpCookies = domainCookies.filter(c => !c.secure);

    if (hasSecure) {
      rules.push({
        id: baseRuleId + offset++,
        priority: 250 + specificity,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            {
              header: 'cookie',
              operation: 'set',
              value: domainCookies.map(c => `${c.name}=${c.value}`).join('; ')
            }
          ]
        },
        condition: {
          tabIds: [numericTabId],
          requestDomains: [domain],
          urlFilter: '|https*',
          resourceTypes: [...DNR_ALL_RESOURCE_TYPES]
        }
      });

      if (httpCookies.length > 0 && offset < 99) {
        rules.push({
          id: baseRuleId + offset++,
          priority: 200 + specificity,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [
              {
                header: 'cookie',
                operation: 'set',
                value: httpCookies.map(c => `${c.name}=${c.value}`).join('; ')
              }
            ]
          },
          condition: {
            tabIds: [numericTabId],
            requestDomains: [domain],
            resourceTypes: [...DNR_ALL_RESOURCE_TYPES]
          }
        });
      }
    } else {
      rules.push({
        id: baseRuleId + offset++,
        priority: 200 + specificity,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            {
              header: 'cookie',
              operation: 'set',
              value: domainCookies.map(c => `${c.name}=${c.value}`).join('; ')
            }
          ]
        },
        condition: {
          tabIds: [numericTabId],
          requestDomains: [domain],
          resourceTypes: [...DNR_ALL_RESOURCE_TYPES]
        }
      });
    }
  }

  return rules;
}

function buildInitScriptForLocalContainer(containerName, customSessionStorage = null) {
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
    sessionStorage: customSessionStorage || entry.sessionStorage || {}
  });

  return `(() => {
  if (window.__chrometetherContainerInitialized) return;
  const defineProperty = Object.defineProperty;
  const hasOwn = Object.prototype.hasOwnProperty;
  const objectKeys = Object.keys;
  const jsonStringify = JSON.stringify;
  defineProperty(window, '__chrometetherContainerInitialized', { value: true, configurable: false });
  const rawSyncBinding = typeof window.__chrometether_vault_sync === 'function'
    ? window.__chrometether_vault_sync
    : null;
  let activeSyncBinding = rawSyncBinding;
  try { delete window.__chrometether_vault_sync; } catch {}
  const getSyncBinding = () => {
    if (typeof window.__chrometether_vault_sync === 'function') {
      activeSyncBinding = window.__chrometether_vault_sync;
      try { delete window.__chrometether_vault_sync; } catch {}
    }
    return activeSyncBinding;
  };
  const state = ${payload};
  try {
    defineProperty(window, '__chrometether_receive_state', {
      value: (incoming) => {
        if (!incoming || typeof incoming !== 'object') return;
        if (Array.isArray(incoming.cookies)) {
          state.cookies.length = 0;
          for (const c of incoming.cookies) state.cookies.push(c);
        }
        if (incoming.localStorage && typeof incoming.localStorage === 'object') {
          for (const k of objectKeys(state.localStorage)) {
            if (!hasOwn.call(incoming.localStorage, k)) delete state.localStorage[k];
          }
          for (const origin of objectKeys(incoming.localStorage)) {
            const srcBucket = incoming.localStorage[origin] || {};
            if (!state.localStorage[origin]) state.localStorage[origin] = {};
            const dstBucket = state.localStorage[origin];
            for (const bk of objectKeys(dstBucket)) {
              if (!hasOwn.call(srcBucket, bk)) delete dstBucket[bk];
            }
            for (const bk of objectKeys(srcBucket)) {
              dstBucket[bk] = srcBucket[bk];
            }
          }
        }
      },
      configurable: false,
      enumerable: false,
      writable: false
    });
  } catch {}
  const notify = (msg) => {
    try {
      const fn = getSyncBinding();
      if (fn) {
        fn(jsonStringify({ container: state.container, ...msg }));
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
  // Prevent site Service Workers from bypassing tab-scoped container isolation (Fable H4)
  // and isolate IndexedDB, CacheStorage, BroadcastChannel, SharedWorker, WebLocks, OPFS, and StorageEvents per container.
  const nsPrefix = '__ct_' + state.container + '__';
  const toNs = (name) => nsPrefix + String(name ?? '');
  const fromNs = (name) => {
    const s = String(name ?? '');
    return s.startsWith(nsPrefix) ? s.slice(nsPrefix.length) : null;
  };

  try {
    window.addEventListener('storage', (ev) => {
      if (ev && !ev.__chrometetherSynthetic) {
        ev.stopImmediatePropagation();
      }
    }, true);
  } catch {}

  try {
    if (typeof IDBFactory !== 'undefined' && IDBFactory.prototype) {
      const origOpen = IDBFactory.prototype.open;
      const origDelete = IDBFactory.prototype.deleteDatabase;
      const origDatabases = IDBFactory.prototype.databases;
      if (typeof origOpen === 'function') {
        IDBFactory.prototype.open = function(name, version) {
          return arguments.length > 1
            ? origOpen.call(this, toNs(name), version)
            : origOpen.call(this, toNs(name));
        };
      }
      if (typeof origDelete === 'function') {
        IDBFactory.prototype.deleteDatabase = function(name) {
          return origDelete.call(this, toNs(name));
        };
      }
      if (typeof origDatabases === 'function') {
        IDBFactory.prototype.databases = async function() {
          const list = await origDatabases.call(this);
          if (!Array.isArray(list)) return [];
          const out = [];
          for (const item of list) {
            const unprefixed = item && item.name ? fromNs(item.name) : null;
            if (unprefixed !== null) out.push({ ...item, name: unprefixed });
          }
          return out;
        };
      }
    }
    if (typeof IDBDatabase !== 'undefined' && IDBDatabase.prototype) {
      const nameDesc = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, 'name');
      if (nameDesc && typeof nameDesc.get === 'function') {
        Object.defineProperty(IDBDatabase.prototype, 'name', {
          ...nameDesc,
          get() {
            const raw = nameDesc.get.call(this);
            const stripped = fromNs(raw);
            return stripped !== null ? stripped : raw;
          }
        });
      }
    }
  } catch {}

  try {
    if (typeof CacheStorage !== 'undefined' && CacheStorage.prototype) {
      const origOpen = CacheStorage.prototype.open;
      const origHas = CacheStorage.prototype.has;
      const origDelete = CacheStorage.prototype.delete;
      const origKeys = CacheStorage.prototype.keys;
      const origMatch = CacheStorage.prototype.match;
      if (typeof origOpen === 'function') {
        CacheStorage.prototype.open = function(cacheName) {
          return origOpen.call(this, toNs(cacheName));
        };
      }
      if (typeof origHas === 'function') {
        CacheStorage.prototype.has = function(cacheName) {
          return origHas.call(this, toNs(cacheName));
        };
      }
      if (typeof origDelete === 'function') {
        CacheStorage.prototype.delete = function(cacheName) {
          return origDelete.call(this, toNs(cacheName));
        };
      }
      if (typeof origKeys === 'function') {
        CacheStorage.prototype.keys = async function() {
          const allKeys = await origKeys.call(this);
          if (!Array.isArray(allKeys)) return [];
          const out = [];
          for (const k of allKeys) {
            const unprefixed = fromNs(k);
            if (unprefixed !== null) out.push(unprefixed);
          }
          return out;
        };
      }
      if (typeof origMatch === 'function' && typeof origKeys === 'function' && typeof origOpen === 'function') {
        CacheStorage.prototype.match = async function(request, options) {
          if (options && options.cacheName) {
            return origMatch.call(this, request, { ...options, cacheName: toNs(options.cacheName) });
          }
          const allKeys = await origKeys.call(this);
          if (!Array.isArray(allKeys)) return undefined;
          for (const rawKey of allKeys) {
            if (fromNs(rawKey) !== null) {
              const cache = await origOpen.call(this, rawKey);
              const found = await cache.match(request, options);
              if (found) return found;
            }
          }
          return undefined;
        };
      }
    }
  } catch {}

  try {
    if (typeof BroadcastChannel === 'function') {
      const OrigBroadcastChannel = BroadcastChannel;
      const nameDesc = Object.getOwnPropertyDescriptor(OrigBroadcastChannel.prototype, 'name');
      class ContainerBroadcastChannel extends OrigBroadcastChannel {
        constructor(channelName) {
          super(toNs(channelName));
        }
        get name() {
          const raw = nameDesc && nameDesc.get ? nameDesc.get.call(this) : '';
          const stripped = fromNs(raw);
          return stripped !== null ? stripped : raw;
        }
      }
      Object.defineProperty(window, 'BroadcastChannel', {
        value: ContainerBroadcastChannel,
        configurable: true,
        writable: true
      });
    }
  } catch {}

  try {
    if (typeof SharedWorker === 'function') {
      const OrigSharedWorker = SharedWorker;
      class ContainerSharedWorker extends OrigSharedWorker {
        constructor(scriptURL, options) {
          if (typeof options === 'string') {
            super(scriptURL, toNs(options));
          } else if (options && typeof options === 'object') {
            super(scriptURL, { ...options, name: toNs(options.name || 'default') });
          } else {
            super(scriptURL, toNs('default'));
          }
        }
      }
      Object.defineProperty(window, 'SharedWorker', {
        value: ContainerSharedWorker,
        configurable: true,
        writable: true
      });
    }
  } catch {}

  try {
    if (typeof LockManager !== 'undefined' && LockManager.prototype) {
      const origRequest = LockManager.prototype.request;
      const origQuery = LockManager.prototype.query;
      if (typeof origRequest === 'function') {
        LockManager.prototype.request = function(name, ...rest) {
          return origRequest.call(this, toNs(name), ...rest);
        };
      }
      if (typeof origQuery === 'function') {
        LockManager.prototype.query = async function() {
          const snap = await origQuery.call(this);
          if (!snap || typeof snap !== 'object') return snap;
          const mapLocks = (arr) => Array.isArray(arr)
            ? arr.filter(l => l && fromNs(l.name) !== null).map(l => ({ ...l, name: fromNs(l.name) }))
            : [];
          return {
            held: mapLocks(snap.held),
            pending: mapLocks(snap.pending)
          };
        };
      }
    }
  } catch {}

  try {
    if (typeof StorageManager !== 'undefined' && StorageManager.prototype && typeof StorageManager.prototype.getDirectory === 'function') {
      const origGetDir = StorageManager.prototype.getDirectory;
      StorageManager.prototype.getDirectory = async function() {
        const root = await origGetDir.call(this);
        return root.getDirectoryHandle(nsPrefix.slice(0, -2), { create: true });
      };
    }
  } catch {}

  try {
    if (navigator.serviceWorker) {
      const swErr = () => Promise.reject(new DOMException('ServiceWorker disabled in ChromeTether Container Tab', 'SecurityError'));
      navigator.serviceWorker.register = swErr;
      navigator.serviceWorker.getRegistration = () => Promise.resolve(undefined);
      navigator.serviceWorker.getRegistrations = () => Promise.resolve([]);
      try {
        Object.defineProperty(navigator.serviceWorker, 'controller', { get: () => null, configurable: true });
        Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => new Promise(() => {}), configurable: true });
      } catch {}
    }
  } catch {}
})();`;
}

async function restoreSessionState() {
  try {
    const localData = await chrome.storage.local.get([
      'containersVault',
      'deletedContainerNames'
    ]);
    if (Array.isArray(localData?.deletedContainerNames)) {
      for (const name of localData.deletedContainerNames) {
        if (name) deletedContainerNames.add(normalizeName(name));
      }
    }
    if (Array.isArray(localData?.containersVault)) {
      for (const c of localData.containersVault) {
        if (!c?.name) continue;
        const name = normalizeName(c.name);
        if (deletedContainerNames.has(name)) continue;
        localVault.set(name, {
          name,
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
          const name = normalizeName(v.containerName);
          if (deletedContainerNames.has(name)) continue;
          const color = COLOR_BADGES[v.color] ? v.color : 'blue';
          const sessionStorage =
            v.sessionStorage && typeof v.sessionStorage === 'object' ? v.sessionStorage : undefined;
          tabContainers.set(tabId, {
            containerName: name,
            color,
            badge: v.badge || COLOR_BADGES[color] || '🔵',
            groupId: Number.isInteger(v.groupId) && v.groupId > 0 ? v.groupId : undefined,
            sessionStorage,
            initScript: buildInitScriptForLocalContainer(name, sessionStorage || null)
          });
        }
      }
    }
    await reconcileTabsAndGroupsWithChrome();
    for (const [tabId, info] of tabContainers.entries()) {
      if (info?.containerName) {
        const rules = buildDnrRulesForLocalContainerTab(info.containerName, tabId);
        await updateTabDnrSessionRules(tabId, rules);
      }
    }
  } catch {
    // ignore
  }
}

function withStepTimeout(promise, ms = 2500, fallback = null) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(resolve => {
      timer = setTimeout(() => resolve(fallback), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

const closedTabIds = new Set();
const tabsWithDnrRules = new Set();

function markTabClosed(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId) || numericTabId <= 0) return;
  if (closedTabIds.size > 500) {
    const oldest = closedTabIds.values().next().value;
    closedTabIds.delete(oldest);
  }
  closedTabIds.add(numericTabId);
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
    await withStepTimeout(
      chrome.storage.local.set({
        containersVault,
        deletedContainerNames: Array.from(deletedContainerNames)
      }),
      1500
    );

    const serializedTabs = {};
    for (const [tabId, info] of tabContainers.entries()) {
      serializedTabs[tabId] = {
        containerName: info.containerName,
        color: info.color,
        badge: info.badge,
        groupId: info.groupId,
        sessionStorage: info.sessionStorage
      };
    }
    await withStepTimeout(chrome.storage.session.set({ tabContainers: serializedTabs }), 1500);
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

function broadcastPopupState() {
  try {
    chrome.runtime
      .sendMessage({
        type: 'popup_state_updated',
        state: {
          connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
          containers: getContainerSummaries(),
          activeContainerTabsCount: tabContainers.size
        }
      })
      .catch(() => {});
  } catch {
    // ignore when popup is closed
  }
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

function syncLocalVaultToHub({ replace = false } = {}) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const containers = Array.from(localVault.values()).map(c => ({
    name: c.name,
    color: c.color,
    createdAt: c.createdAt,
    cookies: c.cookies,
    localStorage: c.localStorage
  }));
  const deleted = Array.from(deletedContainerNames);
  if (
    sendToHub({
      type: 'ext_sync_containers',
      containers,
      replace,
      deleted
    }) &&
    deleted.length > 0
  ) {
    deletedContainerNames.clear();
  }
}

async function reconcileTabsAndGroupsWithChrome() {
  try {
    const [allTabs, allGroups] = await Promise.all([
      chrome.tabs.query({}),
      chrome.tabGroups.query({})
    ]);
    const liveTabMap = new Map(allTabs.map(t => [t.id, t]));
    const liveGroupMap = new Map(allGroups.map(g => [g.id, g]));

    for (const gId of Array.from(groupContainers.keys())) {
      if (!liveGroupMap.has(gId)) {
        groupContainers.delete(gId);
      }
    }
    for (const g of allGroups) {
      if (g.title) {
        const cleanTitle = normalizeName(g.title);
        if (localVault.has(cleanTitle) && !deletedContainerNames.has(cleanTitle)) {
          groupContainers.set(g.id, cleanTitle);
        }
      }
    }

    let changed = false;
    for (const [tabId, info] of Array.from(tabContainers.entries())) {
      const liveTab = liveTabMap.get(tabId);
      if (!liveTab || deletedContainerNames.has(info.containerName)) {
        tabContainers.delete(tabId);
        attachedTabs.delete(tabId);
        attachingTabs.delete(tabId);
        await clearTabDnrSessionRules(tabId);
        changed = true;
      } else if (
        !info.groupingInProgress &&
        !initializingTabs.has(tabId) &&
        info.groupId > 0 &&
        (liveTab.groupId === undefined || liveTab.groupId === -1)
      ) {
        tabContainers.delete(tabId);
        await clearTabDnrSessionRules(tabId);
        changed = true;
      } else if (liveTab.groupId > 0) {
        info.groupId = liveTab.groupId;
        groupContainers.set(liveTab.groupId, info.containerName);
        if (!localVault.has(info.containerName) && !deletedContainerNames.has(info.containerName)) {
          ensureContainerInLocalVault(info.containerName, info.color);
          changed = true;
        }
      } else if (
        !info.groupingInProgress &&
        !initializingTabs.has(tabId) &&
        (!info.groupId || info.groupId === -1)
      ) {
        placeTabInContainerGroup(
          tabId,
          liveTab.windowId,
          info.containerName,
          info.color,
          info.badge
        ).catch(() => {});
      }
    }

    for (const liveTab of allTabs) {
      if (!tabContainers.has(liveTab.id) && liveTab.groupId > 0) {
        const cName = groupContainers.get(liveTab.groupId);
        if (cName && localVault.has(cName) && !deletedContainerNames.has(cName)) {
          const entry = localVault.get(cName);
          tabContainers.set(liveTab.id, {
            containerName: entry.name,
            color: entry.color,
            badge: entry.badge,
            groupId: liveTab.groupId,
            initScript: buildInitScriptForLocalContainer(entry.name)
          });
          changed = true;
        }
      }
    }

    const activeContainerNames = new Set();
    for (const info of tabContainers.values()) {
      if (info.containerName) activeContainerNames.add(info.containerName);
    }
    for (const cName of groupContainers.values()) {
      if (cName) activeContainerNames.add(cName);
    }
    const now = Date.now();
    for (const [cName, entry] of Array.from(localVault.entries())) {
      const hasData =
        (Array.isArray(entry.cookies) && entry.cookies.length > 0) ||
        Object.keys(entry.localStorage || {}).length > 0;
      if (!activeContainerNames.has(cName) && !hasData && now - (entry.createdAt || 0) > 60000) {
        localVault.delete(cName);
        changed = true;
      }
    }

    if (changed) {
      await persistVaultAndTabs();
      syncLocalVaultToHub({ replace: true });
    }
  } catch {
    // ignore
  }
}

async function deleteContainerLocal(
  rawName,
  { notifyHub = true, closeTabs = true } = {}
) {
  const name = normalizeName(rawName);
  if (removingContainers.has(name)) return;
  removingContainers.add(name);
  try {
    deletedContainerNames.add(name);
    localVault.delete(name);

    const tabIdsToProcess = new Set();
    for (const [tabId, info] of Array.from(tabContainers.entries())) {
      if (info.containerName === name) {
        tabIdsToProcess.add(tabId);
        tabContainers.delete(tabId);
        attachedTabs.delete(tabId);
        attachingTabs.delete(tabId);
        await clearTabDnrSessionRules(tabId);
      }
    }

    const matchingGroupIds = new Set();
    for (const [gId, cName] of Array.from(groupContainers.entries())) {
      if (cName === name) {
        matchingGroupIds.add(gId);
        groupContainers.delete(gId);
      }
    }
    try {
      const groups = await chrome.tabGroups.query({ title: name });
      for (const g of groups || []) {
        matchingGroupIds.add(g.id);
        groupContainers.delete(g.id);
      }
      if (matchingGroupIds.size > 0) {
        const allTabs = await chrome.tabs.query({});
        for (const t of allTabs) {
          if (matchingGroupIds.has(t.groupId)) {
            tabIdsToProcess.add(t.id);
            tabContainers.delete(t.id);
            attachedTabs.delete(t.id);
            attachingTabs.delete(t.id);
            await clearTabDnrSessionRules(t.id);
          }
        }
      }
    } catch {
      // ignore
    }

    const tabIds = Array.from(tabIdsToProcess);
    if (tabIds.length > 0) {
      if (closeTabs) {
        for (const tId of tabIds) markTabClosed(tId);
        await chrome.tabs.remove(tabIds).catch(() => {});
      } else {
        await chrome.tabs.ungroup(tabIds).catch(() => {});
      }
    }

    await persistVaultAndTabs();
    broadcastPopupState();

    if (notifyHub) {
      sendToHub({
        type: 'ext_popup_action',
        action: 'delete_container',
        containerName: name
      });
      syncLocalVaultToHub({ replace: true });
      await sendTabsSnapshot();
    }
  } finally {
    removingContainers.delete(name);
  }
}

let dnrUpdateChain = Promise.resolve();

async function updateTabDnrSessionRules(tabId, newRules = []) {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId) || numericTabId <= 0) return;

  const info = tabContainers.get(numericTabId);
  const rulesJson = newRules.length > 0 ? JSON.stringify(newRules) : null;
  if (newRules.length === 0) {
    if (!tabsWithDnrRules.has(numericTabId) && (!info || !info.appliedDnrRulesJson)) {
      return;
    }
  } else if (info && info.appliedDnrRulesJson === rulesJson && tabsWithDnrRules.has(numericTabId)) {
    return;
  }

  const minId = getTabDnrBaseRuleId(numericTabId);
  const maxId = minId + 99;
  const newRuleIds = new Set(newRules.map(r => r.id));

  const next = dnrUpdateChain.catch(() => {}).then(() =>
    withStepTimeout(
      (async () => {
        try {
          const existing = await chrome.declarativeNetRequest.getSessionRules();
          const removeRuleIds = existing
            .filter(
              r =>
                (r.id >= minId && r.id <= maxId) ||
                newRuleIds.has(r.id) ||
                (Array.isArray(r.condition?.tabIds) && r.condition.tabIds.includes(numericTabId))
            )
            .map(r => r.id);

          if (removeRuleIds.length === 0 && newRules.length === 0) {
            tabsWithDnrRules.delete(numericTabId);
            if (info) info.appliedDnrRulesJson = null;
            return;
          }

          await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds,
            addRules: newRules
          });
          if (newRules.length > 0) {
            tabsWithDnrRules.add(numericTabId);
          } else {
            tabsWithDnrRules.delete(numericTabId);
          }
          if (info) {
            info.appliedDnrRulesJson = rulesJson;
          }
        } catch (err) {
          console.warn('DNR updateSessionRules error for tab', numericTabId, err);
        }
      })(),
      2500
    )
  );
  dnrUpdateChain = next;
  return next;
}

async function clearTabDnrSessionRules(tabId) {
  await updateTabDnrSessionRules(tabId, []);
}

const refreshingInitScripts = new Map();

async function refreshTabInitScript(tabId, info, scriptSource = null) {
  const numericTabId = Number(tabId);
  if (!attachedTabs.has(numericTabId) || !info) return;
  if (scriptSource) {
    info.initScript = scriptSource;
  }
  if (
    info.initScript &&
    info.appliedInitScript === info.initScript &&
    info.initScriptId
  ) {
    return;
  }
  const prev = refreshingInitScripts.get(numericTabId) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      if (!attachedTabs.has(numericTabId)) return;
      const latestInfo = tabContainers.get(numericTabId) || info;
      const latestSource =
        latestInfo.initScript ||
        (latestInfo.containerName
          ? buildInitScriptForLocalContainer(latestInfo.containerName)
          : '');
      if (!latestSource) return;
      if (latestInfo.appliedInitScript === latestSource && latestInfo.initScriptId) {
        return;
      }
      const target = { tabId: numericTabId };
      if (latestInfo.initScriptId) {
        await chrome.debugger
          .sendCommand(target, 'Page.removeScriptToEvaluateOnNewDocument', {
            identifier: latestInfo.initScriptId
          })
          .catch(() => {});
        latestInfo.initScriptId = null;
      }
      try {
        const res = await chrome.debugger.sendCommand(
          target,
          'Page.addScriptToEvaluateOnNewDocument',
          {
            source: latestSource
          }
        );
        if (res?.identifier) {
          latestInfo.initScriptId = res.identifier;
          latestInfo.appliedInitScript = latestSource;
        }
      } catch {
        // ignore
      }
    });
  refreshingInitScripts.set(numericTabId, next);
  try {
    await next;
  } finally {
    if (refreshingInitScripts.get(numericTabId) === next) {
      refreshingInitScripts.delete(numericTabId);
    }
  }
}

async function syncAllTabsForContainer(containerName, excludeTabId = null) {
  const name = normalizeName(containerName);
  const entry = ensureContainerInLocalVault(name);
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
  const liveSyncExpr = `typeof window.__chrometether_receive_state === 'function' && window.__chrometether_receive_state(${JSON.stringify(
    {
      cookies: jsCookies,
      localStorage: entry.localStorage || {}
    }
  )})`;
  for (const [tabId, info] of tabContainers.entries()) {
    if (info.containerName === name) {
      const initScript = buildInitScriptForLocalContainer(name, info.sessionStorage || null);
      info.initScript = initScript;
      const rules = buildDnrRulesForLocalContainerTab(name, tabId);
      await updateTabDnrSessionRules(tabId, rules);
      await refreshTabInitScript(tabId, info, initScript);
      if (attachedTabs.has(Number(tabId)) && Number(tabId) !== Number(excludeTabId)) {
        chrome.debugger
          .sendCommand(
            { tabId: Number(tabId) },
            'Runtime.evaluate',
            { expression: liveSyncExpr, silent: true }
          )
          .catch(() => {});
      }
    }
  }
}

async function engageFailClosedDnrBlock(tabId) {
  const rules = buildDnrRulesForLocalContainerTab('', tabId, { failClosedBlocked: true });
  await updateTabDnrSessionRules(tabId, rules);
}

const attachingTabs = new Map();

async function ensureDebuggerAttached(tabId) {
  const numericTabId = Number(tabId);
  if (attachedTabs.has(numericTabId)) return true;
  if (attachingTabs.has(numericTabId)) {
    return attachingTabs.get(numericTabId);
  }
  const promise = (async () => {
    let timer;
    try {
      await Promise.race([
        chrome.debugger.attach({ tabId: numericTabId }, '1.3'),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Debugger attach timed out')), 2500);
        })
      ]);
      attachedTabs.add(numericTabId);
      return true;
    } catch (err) {
      const msg = String(err?.message || '').toLowerCase();
      if (msg.includes('already attached')) {
        attachedTabs.add(numericTabId);
        return true;
      }
      return false;
    } finally {
      clearTimeout(timer);
      attachingTabs.delete(numericTabId);
    }
  })();
  attachingTabs.set(numericTabId, promise);
  return promise;
}

async function configureContainerDebuggerOnTab(tabId, containerInfo) {
  const numericTabId = Number(tabId);
  const ok = await ensureDebuggerAttached(numericTabId);
  if (!ok) {
    await engageFailClosedDnrBlock(numericTabId);
    return false;
  }

  const target = { tabId: numericTabId };
  return withStepTimeout(
    (async () => {
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
        await chrome.debugger
          .sendCommand(target, 'Page.setLifecycleEventsEnabled', { enabled: true })
          .catch(() => {});
        const scriptSource =
          containerInfo.initScript || buildInitScriptForLocalContainer(containerInfo.containerName);
        await refreshTabInitScript(numericTabId, containerInfo, scriptSource);
        return true;
      } catch {
        return false;
      }
    })(),
    3000,
    false
  );
}

const groupingLocks = new Map();

async function placeTabInContainerGroup(
  tabId,
  windowId,
  containerName,
  color = 'blue',
  _badge = ''
) {
  const cleanName = normalizeName(containerName || 'acc-1');
  const info = tabContainers.get(Number(tabId));
  if (info) info.groupingInProgress = true;
  const prevLock = groupingLocks.get(cleanName) || Promise.resolve();
  const nextLock = prevLock
    .catch(() => {})
    .then(() =>
      withStepTimeout(
        (async () => {
          try {
            if (closedTabIds.has(Number(tabId))) return null;
            // Chrome tabGroups already render a colored pill (blue, orange, green, etc.) — keep title crisp without emoji clutter
            const title = String(cleanName);
            const existingGroups = await chrome.tabGroups
              .query(windowId ? { windowId, title } : { title })
              .catch(() => []);
            if (existingGroups && existingGroups.length > 0) {
              const gId = existingGroups[0].id;
              try {
                await chrome.tabs.group({ groupId: gId, tabIds: [tabId] });
                groupContainers.set(gId, cleanName);
                if (info) info.groupId = gId;
                return gId;
              } catch {
                // Fall through to create a fresh group if existing groupId became stale
              }
            }
            let groupId;
            try {
              groupId = await chrome.tabs.group({
                createProperties: windowId ? { windowId } : undefined,
                tabIds: [tabId]
              });
            } catch {
              groupId = await chrome.tabs.group({ tabIds: [tabId] });
            }
            groupContainers.set(groupId, cleanName);
            if (info) info.groupId = groupId;
            await chrome.tabGroups
              .update(groupId, {
                title,
                color: color || 'blue',
                collapsed: false
              })
              .catch(() => {});
            return groupId;
          } catch {
            return null;
          } finally {
            if (info) info.groupingInProgress = false;
          }
        })(),
        2000,
        null
      )
    )
    .finally(() => {
      if (info) info.groupingInProgress = false;
    });
  groupingLocks.set(cleanName, nextLock);
  try {
    return await nextLock;
  } finally {
    if (groupingLocks.get(cleanName) === nextLock) {
      groupingLocks.delete(cleanName);
    }
  }
}

async function createContainerTabLocal({
  url = 'about:blank',
  background = false,
  containerName,
  color = 'blue',
  badge,
  initScript,
  dnrRules: initialDnrRules,
  cookies,
  localStorage,
  fromHub = false
}) {
  creatingTabCount++;
  let created;
  try {
    created = await chrome.tabs.create({
      url: 'about:blank',
      active: !background
    });
    closedTabIds.delete(created.id);
    initializingTabs.add(created.id);
  } finally {
    creatingTabCount = Math.max(0, creatingTabCount - 1);
  }
  const tabId = created.id;

  try {
    if (containerName) {
      const entry = mergeHubContainerData(containerName, {
        color,
        cookies,
        localStorage
      });
      const info = {
        containerName: entry.name,
        color: entry.color,
        badge: badge || entry.badge,
        groupingInProgress: true,
        initScript: initScript || buildInitScriptForLocalContainer(entry.name)
      };
      tabContainers.set(tabId, info);
      await persistVaultAndTabs();

      const dnrRules =
        Array.isArray(initialDnrRules) && initialDnrRules.length > 0
          ? initialDnrRules
          : buildDnrRulesForLocalContainerTab(entry.name, tabId);
      await updateTabDnrSessionRules(tabId, dnrRules);
      await configureContainerDebuggerOnTab(tabId, info);
      await placeTabInContainerGroup(
        tabId,
        created.windowId,
        entry.name,
        info.color,
        info.badge
      );
      await persistVaultAndTabs();
      broadcastPopupState();
      if (!fromHub) {
        syncLocalVaultToHub();
      }
    } else if (fromHub) {
      const ok = await ensureDebuggerAttached(tabId);
      if (ok) {
        const target = { tabId };
        await withStepTimeout(
          Promise.all([
            chrome.debugger.sendCommand(target, 'Network.enable', {}).catch(() => {}),
            chrome.debugger.sendCommand(target, 'Runtime.enable', {}).catch(() => {}),
            chrome.debugger.sendCommand(target, 'Page.enable', {}).catch(() => {}),
            chrome.debugger
              .sendCommand(target, 'Page.setLifecycleEventsEnabled', { enabled: true })
              .catch(() => {})
          ]),
          2500
        );
      }
    }

    if (url && url !== 'about:blank') {
      await withStepTimeout(chrome.tabs.update(tabId, { url }), 3000);
    }
  } finally {
    initializingTabs.delete(tabId);
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
  originalUrl,
  fromHub = false
}) {
  const numericTabId = Number(tabId);
  initializingTabs.add(numericTabId);
  try {
    const tab = await chrome.tabs.get(numericTabId);
    const entry = ensureContainerInLocalVault(containerName, color);
    const info = {
      containerName: entry.name,
      color: entry.color,
      badge: badge || entry.badge,
      groupingInProgress: true,
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
    await persistVaultAndTabs();
    broadcastPopupState();
    if (!fromHub) {
      syncLocalVaultToHub();
    }
  } finally {
    initializingTabs.delete(numericTabId);
  }
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
      result = await createContainerTabLocal({ ...params, fromHub: true });
    } else if (action === 'convert_tab_to_container') {
      result = await convertTabToContainerLocal({ ...params, fromHub: true });
    } else if (action === 'assign_tab_container') {
      const { tabId, containerName, color, badge, initScript, dnrRules } = params;
      const numericTabId = Number(tabId);
      initializingTabs.add(numericTabId);
      try {
        const tab = await chrome.tabs.get(numericTabId);
        const entry = ensureContainerInLocalVault(containerName, color);
        const info = {
          containerName: entry.name,
          color: entry.color,
          badge: badge || entry.badge,
          groupingInProgress: true,
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
        await persistVaultAndTabs();
        broadcastPopupState();
      } finally {
        initializingTabs.delete(numericTabId);
      }
      result = { ok: true };
    } else if (action === 'ensure_container') {
      ensureContainerInLocalVault(params.containerName || 'acc-1', params.color || 'blue');
      await persistVaultAndTabs();
      broadcastPopupState();
      result = { ok: true };
    } else if (action === 'clear_container') {
      const name = normalizeName(params.containerName);
      const entry = localVault.get(name);
      if (entry) {
        entry.cookies = [];
        entry.localStorage = {};
        entry.sessionStorage = {};
        await persistVaultAndTabs();
        await syncAllTabsForContainer(entry.name);
        broadcastPopupState();
      }
      result = { ok: true };
    } else if (action === 'delete_container') {
      await deleteContainerLocal(params.containerName, {
        notifyHub: false,
        closeTabs: params.closeTabs !== false
      });
      result = { ok: true };
    } else if (action === 'reload_extension') {
      sendToHub({ type: 'hub_response', reqId, result: { ok: true } });
      setTimeout(() => chrome.runtime.reload(), 50);
      return;
    } else if (action === 'update_tab_dnr_rules') {
      const { tabId, containerName: cName, rules, initScript, cookies, localStorage } = params;
      const numericTabId = Number(tabId);
      if (cName && (Array.isArray(cookies) || (localStorage && typeof localStorage === 'object'))) {
        mergeHubContainerData(cName, { cookies, localStorage });
      }
      if (Array.isArray(rules)) {
        await updateTabDnrSessionRules(numericTabId, rules);
      }
      if (initScript && tabContainers.has(numericTabId)) {
        const info = tabContainers.get(numericTabId);
        await refreshTabInitScript(numericTabId, info, initScript);
      }
      result = { ok: true };
    } else if (action === 'close_tab') {
      const numericTabId = Number(params.tabId);
      markTabClosed(numericTabId);
      initializingTabs.delete(numericTabId);
      const info = tabContainers.get(numericTabId);
      await clearTabDnrSessionRules(numericTabId);
      tabContainers.delete(numericTabId);
      attachedTabs.delete(numericTabId);
      attachingTabs.delete(numericTabId);
      await chrome.tabs.remove(numericTabId).catch(() => {});
      if (info?.containerName) {
        const hasRemaining = Array.from(tabContainers.values()).some(
          v => v.containerName === info.containerName
        );
        if (!hasRemaining) {
          await deleteContainerLocal(info.containerName, {
            notifyHub: true,
            closeTabs: false
          });
        } else {
          await persistVaultAndTabs();
          broadcastPopupState();
        }
      } else {
        await persistVaultAndTabs();
        broadcastPopupState();
      }
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
      const ok = await ensureDebuggerAttached(numericTabId);
      if (!ok) {
        throw new Error(`Failed to attach debugger to tab ${numericTabId}`);
      }
      if (
        (params.method === 'Page.reload' || params.method === 'Page.navigate') &&
        refreshingInitScripts.has(numericTabId)
      ) {
        await refreshingInitScripts.get(numericTabId).catch(() => {});
      }
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
      const sentToHub = sendToHub({
        type: 'ext_set_cookie_captured',
        tabId: details.tabId,
        containerName: containerInfo.containerName,
        url: details.url,
        setCookieHeaders: setCookies
      });
      if (changed) {
        persistVaultAndTabs();
        if (!sentToHub) {
          syncAllTabsForContainer(containerInfo.containerName);
        }
        broadcastPopupState();
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders']
);

chrome.tabs.onCreated.addListener(async tab => {
  if (creatingTabCount > 0 || initializingTabs.has(tab.id) || tabContainers.has(tab.id)) return;
  let targetContainerName = null;
  let targetColor = 'blue';
  let targetBadge = '🔵';

  if (tab.openerTabId && tabContainers.has(tab.openerTabId)) {
    const parentInfo = tabContainers.get(tab.openerTabId);
    targetContainerName = parentInfo.containerName;
    targetColor = parentInfo.color;
    targetBadge = parentInfo.badge;
  } else if (tab.groupId > 0 && groupContainers.has(tab.groupId)) {
    targetContainerName = groupContainers.get(tab.groupId);
    const entry = localVault.get(targetContainerName);
    if (entry) {
      targetColor = entry.color;
      targetBadge = entry.badge;
    }
  }

  if (targetContainerName) {
    const entry = ensureContainerInLocalVault(targetContainerName, targetColor);
    const info = {
      containerName: entry.name,
      color: entry.color,
      badge: targetBadge || entry.badge,
      groupId: tab.groupId > 0 ? tab.groupId : undefined,
      groupingInProgress: true,
      initScript: buildInitScriptForLocalContainer(entry.name)
    };
    tabContainers.set(tab.id, info);
    await persistVaultAndTabs();
    const rules = buildDnrRulesForLocalContainerTab(entry.name, tab.id);
    await updateTabDnrSessionRules(tab.id, rules);
    await placeTabInContainerGroup(
      tab.id,
      tab.windowId,
      entry.name,
      info.color,
      info.badge
    );
    await configureContainerDebuggerOnTab(tab.id, info);
    await persistVaultAndTabs();
    broadcastPopupState();
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (closedTabIds.has(tabId)) return;
  if (changeInfo.groupId !== undefined) {
    if (changeInfo.groupId === -1 && tabContainers.has(tabId)) {
      const info = tabContainers.get(tabId);
      if (
        info &&
        info.groupId > 0 &&
        !info.groupingInProgress &&
        !initializingTabs.has(tabId) &&
        !removingContainers.has(info.containerName)
      ) {
        // Wait briefly because Chrome fires onUpdated({ groupId: -1 }) right before onRemoved when a grouped tab closes
        await new Promise(r => setTimeout(r, 150));
        if (
          closedTabIds.has(tabId) ||
          !tabContainers.has(tabId) ||
          removingContainers.has(info.containerName)
        ) {
          return;
        }
        const stillAlive = await withStepTimeout(chrome.tabs.get(tabId), 1000, null);
        if (!stillAlive || closedTabIds.has(tabId)) {
          return;
        }
        if (stillAlive.groupId !== -1) {
          info.groupId = stillAlive.groupId;
          return;
        }
        const oldContainerName = info.containerName;
        tabContainers.delete(tabId);
        await clearTabDnrSessionRules(tabId);
        const hasRemaining = Array.from(tabContainers.values()).some(
          v => v.containerName === oldContainerName
        );
        if (!hasRemaining) {
          await deleteContainerLocal(oldContainerName, {
            notifyHub: true,
            closeTabs: false
          });
        } else {
          await persistVaultAndTabs();
          broadcastPopupState();
        }
      }
    } else if (changeInfo.groupId > 0) {
      if (tabContainers.has(tabId)) {
        const info = tabContainers.get(tabId);
        info.groupId = changeInfo.groupId;
        groupContainers.set(changeInfo.groupId, info.containerName);
      } else if (groupContainers.has(changeInfo.groupId)) {
        const cName = groupContainers.get(changeInfo.groupId);
        if (cName && !removingContainers.has(cName)) {
          const entry = ensureContainerInLocalVault(cName);
          const info = {
            containerName: entry.name,
            color: entry.color,
            badge: entry.badge,
            groupId: changeInfo.groupId,
            initScript: buildInitScriptForLocalContainer(entry.name)
          };
          tabContainers.set(tabId, info);
          const rules = buildDnrRulesForLocalContainerTab(entry.name, tabId);
          await updateTabDnrSessionRules(tabId, rules);
          await configureContainerDebuggerOnTab(tabId, info);
          await persistVaultAndTabs();
          broadcastPopupState();
        }
      }
    }
  }

  if (closedTabIds.has(tabId)) return;
  if (creatingTabCount > 0 && !tabContainers.has(tabId)) return;
  if (initializingTabs.has(tabId)) return;

  if (
    changeInfo.url ||
    changeInfo.title ||
    changeInfo.status === 'complete' ||
    changeInfo.groupId !== undefined
  ) {
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
  markTabClosed(tabId);
  initializingTabs.delete(tabId);
  attachedTabs.delete(tabId);
  attachingTabs.delete(tabId);
  const info = tabContainers.get(tabId);
  if (info) {
    const cName = info.containerName;
    tabContainers.delete(tabId);
    await clearTabDnrSessionRules(tabId);
    sendToHub({ type: 'ext_tab_removed', tabId });

    if (cName && !removingContainers.has(cName)) {
      const hasRemaining = Array.from(tabContainers.values()).some(
        v => v.containerName === cName
      );
      if (!hasRemaining) {
        await deleteContainerLocal(cName, { notifyHub: true, closeTabs: false });
        return;
      }
    }
    await persistVaultAndTabs();
    broadcastPopupState();
    return;
  }
  sendToHub({ type: 'ext_tab_removed', tabId });
});

if (chrome.tabGroups?.onRemoved) {
  chrome.tabGroups.onRemoved.addListener(async group => {
    const cName =
      groupContainers.get(group.id) ||
      (group.title && localVault.has(normalizeName(group.title))
        ? normalizeName(group.title)
        : null);
    groupContainers.delete(group.id);
    if (!cName || removingContainers.has(cName)) return;

    // Wait briefly so any accompanying chrome.tabs.onRemoved events settle
    await new Promise(r => setTimeout(r, 150));
    if (removingContainers.has(cName)) return;

    try {
      const allTabs = await chrome.tabs.query({});
      const liveTabMap = new Map(allTabs.map(t => [t.id, t]));
      for (const [tId, info] of Array.from(tabContainers.entries())) {
        if (info.containerName === cName) {
          const live = liveTabMap.get(tId);
          if (!live || live.groupId === -1 || live.groupId === group.id) {
            tabContainers.delete(tId);
            await clearTabDnrSessionRules(tId);
            if (live) {
              sendToHub({
                type: 'ext_tab_updated',
                tab: {
                  tabId: tId,
                  windowId: live.windowId,
                  url: live.url || 'about:blank',
                  title: live.title || '',
                  containerName: null
                }
              });
            }
          }
        }
      }
    } catch {
      // ignore
    }

    const hasRemaining = Array.from(tabContainers.values()).some(
      v => v.containerName === cName
    );
    if (!hasRemaining) {
      await deleteContainerLocal(cName, { notifyHub: true, closeTabs: false });
    } else {
      await persistVaultAndTabs();
      broadcastPopupState();
    }
  });
}

if (chrome.tabGroups?.onUpdated) {
  chrome.tabGroups.onUpdated.addListener(async group => {
    const trackedName = groupContainers.get(group.id);
    if (!trackedName) return;
    const entry = localVault.get(trackedName);
    if (!entry) return;
    if (group.color && COLOR_BADGES[group.color] && entry.color !== group.color) {
      entry.color = group.color;
      entry.badge = COLOR_BADGES[group.color];
      for (const info of tabContainers.values()) {
        if (info.containerName === trackedName) {
          info.color = group.color;
          info.badge = entry.badge;
        }
      }
      await persistVaultAndTabs();
      syncLocalVaultToHub();
      broadcastPopupState();
    }
  });
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source.tabId) return;

  // Handle in-page document.cookie & localStorage sync binding locally even when Hub is offline!
  // SECURITY: Never trust `data.container` from page script payload — strictly enforce the container
  // bound to `source.tabId` so a compromised page in `acc-1` cannot poison `acc-2`.
  if (method === 'Runtime.bindingCalled' && params?.name === '__chrometether_vault_sync') {
    try {
      const data = JSON.parse(params.payload);
      const cName = tabContainers.get(source.tabId)?.containerName;
      if (cName) {
        const entry = ensureContainerInLocalVault(cName);
        if (data.type === 'setCookie' && data.cookie) {
          applySetCookiesToLocalVault(cName, [data.cookie], data.url);
          syncAllTabsForContainer(cName, source.tabId);
        } else if (data.type === 'storageSet' && data.origin) {
          const tabInfo = tabContainers.get(source.tabId);
          if (data.session && tabInfo) {
            if (!tabInfo.sessionStorage) tabInfo.sessionStorage = {};
            if (!tabInfo.sessionStorage[data.origin]) tabInfo.sessionStorage[data.origin] = {};
            tabInfo.sessionStorage[data.origin][String(data.key)] = String(data.value);
          }
          const store = data.session ? entry.sessionStorage : entry.localStorage;
          if (!store[data.origin]) store[data.origin] = {};
          store[data.origin][String(data.key)] = String(data.value);
          syncAllTabsForContainer(cName, source.tabId);
        } else if (data.type === 'storageRemove' && data.origin) {
          const tabInfo = tabContainers.get(source.tabId);
          if (data.session && tabInfo?.sessionStorage?.[data.origin]) {
            delete tabInfo.sessionStorage[data.origin][String(data.key)];
          }
          const store = data.session ? entry.sessionStorage : entry.localStorage;
          if (store[data.origin]) delete store[data.origin][String(data.key)];
          syncAllTabsForContainer(cName, source.tabId);
        } else if (data.type === 'storageClear' && data.origin) {
          const tabInfo = tabContainers.get(source.tabId);
          if (data.session && tabInfo?.sessionStorage) {
            delete tabInfo.sessionStorage[data.origin];
          }
          const store = data.session ? entry.sessionStorage : entry.localStorage;
          delete store[data.origin];
          syncAllTabsForContainer(cName, source.tabId);
        }
        persistVaultAndTabs();
        broadcastPopupState();
      }
    } catch {
      // ignore
    }
  }

  if (source.sessionId || String(method).startsWith('Target.')) {
    return;
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
  attachingTabs.delete(tabId);
  if (tabContainers.has(tabId)) {
    tabContainers.get(tabId).initScriptId = null;
  }

  let reattached = false;
  if (tabContainers.has(tabId)) {
    const info = tabContainers.get(tabId);
    if (reason !== 'target_closed') {
      reattached = await configureContainerDebuggerOnTab(tabId, info);
      if (!reattached) {
        await engageFailClosedDnrBlock(tabId);
      }
    }
  }
  sendToHub({ type: 'ext_debugger_detached', tabId, reason, reattached });
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

    await sessionRestorePromise;
    syncLocalVaultToHub({ replace: false });
    await sendTabsSnapshot();
    broadcastPopupState();
  };

  ws.onmessage = event => {
    try {
      const msg = JSON.parse(String(event.data));
      if (msg.type === 'hub_hello') {
        if (msg.token) hubToken = msg.token;
        sessionRestorePromise.then(() => {
          if (Array.isArray(msg.containers)) {
            for (const c of msg.containers) {
              if (!c?.name) continue;
              const clean = normalizeName(c.name);
              if (deletedContainerNames.has(clean)) continue;
              mergeHubContainerData(clean, c);
            }
            persistVaultAndTabs();
          }
          syncLocalVaultToHub({ replace: false });
          broadcastPopupState();
        });
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
    broadcastPopupState();
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

function scheduleReconnect(delayMs = 1000) {
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
    reconcileTabsAndGroupsWithChrome().then(() => {
      sendResponse({
        bgVersion: '2.2.0',
        connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
        containers: getContainerSummaries(),
        activeContainerTabsCount: tabContainers.size
      });
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
        broadcastPopupState();
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
        broadcastPopupState();
      } else if (payload.action === 'delete_container' && payload.containerName) {
        await deleteContainerLocal(payload.containerName, {
          notifyHub: true,
          closeTabs: true
        });
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

const sessionRestorePromise = restoreSessionState();
sessionRestorePromise.then(() => connectHub());
