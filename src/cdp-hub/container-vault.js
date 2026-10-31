import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONTAINER_COLORS = [
  'blue',
  'orange',
  'green',
  'purple',
  'pink',
  'cyan',
  'yellow',
  'red',
  'grey'
];

export const COLOR_BADGES = {
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

const MAX_COOKIES_PER_CONTAINER = 500;
const MAX_STORAGE_KEYS_PER_ORIGIN = 1000;

export function getDefaultContainersFilePath() {
  if (process.env.CHROMETETHER_CONTAINERS_FILE) {
    return path.resolve(process.env.CHROMETETHER_CONTAINERS_FILE);
  }
  const home = process.env.CHROMETETHER_HOME || os.homedir();
  return path.join(home, '.chrometether', 'containers.json');
}

export function normalizeContainerName(name) {
  const cleaned = String(name ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!cleaned) {
    throw new Error('Container name must contain at least one alphanumeric character');
  }
  return cleaned.slice(0, 64);
}

export function toVirtualContextId(containerName) {
  return `tether-ctx-${normalizeContainerName(containerName)}`;
}

export function fromVirtualContextId(contextId) {
  if (typeof contextId === 'string' && contextId.startsWith('tether-ctx-')) {
    return contextId.slice('tether-ctx-'.length);
  }
  return null;
}

/**
 * Extract URL fragment hint `#tether-container=<name>` if present, returning
 * `{ containerName, cleanUrl }`.
 */
export function extractUrlContainerHint(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.includes('tether-container=')) {
    return { containerName: null, cleanUrl: rawUrl };
  }
  try {
    const parsed = new URL(rawUrl);
    const hash = parsed.hash ? parsed.hash.slice(1) : '';
    if (!hash) return { containerName: null, cleanUrl: rawUrl };

    const params = new URLSearchParams(hash);
    const hint = params.get('tether-container');
    if (!hint) return { containerName: null, cleanUrl: rawUrl };

    const containerName = normalizeContainerName(hint);
    params.delete('tether-container');
    const remainingHash = params.toString();
    parsed.hash = remainingHash ? `#${remainingHash}` : '';
    return { containerName, cleanUrl: parsed.toString() };
  } catch {
    return { containerName: null, cleanUrl: rawUrl };
  }
}

/**
 * RFC 6265 default-path algorithm.
 */
export function computeDefaultCookiePath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) {
    return '/';
  }
  if (pathname === '/') return '/';
  const lastSlash = pathname.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return pathname.slice(0, lastSlash);
}

/**
 * RFC 6265 domain-match check.
 */
export function domainMatches(requestHost, cookieDomain, hostOnly = false) {
  const host = String(requestHost || '').toLowerCase().replace(/^\.+/, '');
  const dom = String(cookieDomain || '').toLowerCase().replace(/^\.+/, '');
  if (!host || !dom) return false;
  if (host === dom) return true;
  if (hostOnly) return false;
  return host.endsWith(`.${dom}`);
}

/**
 * RFC 6265 path-match check.
 */
export function pathMatches(requestPath, cookiePath) {
  const reqP = String(requestPath || '/');
  const cookP = String(cookiePath || '/');
  if (reqP === cookP) return true;
  if (reqP.startsWith(cookP)) {
    if (cookP.endsWith('/')) return true;
    if (reqP[cookP.length] === '/') return true;
  }
  return false;
}

/**
 * Parse a single `Set-Cookie` header string against a request URL (RFC 6265).
 */
export function parseSetCookieHeader(setCookieStr, requestUrl) {
  if (typeof setCookieStr !== 'string' || !setCookieStr.trim()) {
    return null;
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(requestUrl);
  } catch {
    return null;
  }

  const parts = setCookieStr.split(';').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const firstEq = parts[0].indexOf('=');
  if (firstEq <= 0) return null;

  const name = parts[0].slice(0, firstEq).trim();
  const value = parts[0].slice(firstEq + 1).trim();
  if (!name) return null;

  const reqHost = parsedUrl.hostname.toLowerCase();
  let domain = reqHost;
  let hostOnly = true;
  let cookiePath = computeDefaultCookiePath(parsedUrl.pathname);
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
        // Reject Set-Cookie for mismatched domain per RFC 6265
        return null;
      }
    } else if (attrName === 'path' && attrVal) {
      cookiePath = attrVal.startsWith('/') ? attrVal : computeDefaultCookiePath(parsedUrl.pathname);
    } else if (attrName === 'secure') {
      secure = true;
    } else if (attrName === 'httponly') {
      httpOnly = true;
    } else if (attrName === 'samesite' && attrVal) {
      const lower = attrVal.toLowerCase();
      if (lower === 'strict') sameSite = 'Strict';
      else if (lower === 'none') sameSite = 'None';
      else sameSite = 'Lax';
    } else if (attrName === 'max-age' && attrVal !== '') {
      const sec = Number.parseInt(attrVal, 10);
      if (!Number.isNaN(sec)) {
        hasMaxAge = true;
        expires = sec <= 0 ? 0 : Date.now() + sec * 1000;
      }
    } else if (attrName === 'expires' && attrVal && !hasMaxAge) {
      const ts = Date.parse(attrVal);
      if (!Number.isNaN(ts)) {
        expires = ts;
      }
    }
  }

  // __Secure- and __Host- cookie prefix rules (RFC 6265bis)
  const isHttps = parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'wss:';
  if (name.startsWith('__Secure-') && (!secure || !isHttps)) {
    return null;
  }
  if (name.startsWith('__Host-')) {
    if (!secure || !isHttps || !hostOnly || cookiePath !== '/') {
      return null;
    }
  }

  return {
    name,
    value,
    domain,
    hostOnly,
    path: cookiePath,
    secure,
    httpOnly,
    sameSite,
    expires,
    createdAt: Date.now()
  };
}

export class ContainerVault {
  constructor({ filePath = getDefaultContainersFilePath(), autoSave = true } = {}) {
    this.filePath = filePath;
    this.autoSave = autoSave;
    this.containers = new Map();
    this._colorCursor = 0;
    this.load();
  }

  _nextColor() {
    const color = CONTAINER_COLORS[this._colorCursor % CONTAINER_COLORS.length];
    this._colorCursor += 1;
    return color;
  }

  /**
   * Ensure a container exists and return its descriptor.
   */
  ensureContainer(rawName, { color } = {}) {
    const name = normalizeContainerName(rawName);
    let entry = this.containers.get(name);
    if (!entry) {
      const chosenColor =
        color && CONTAINER_COLORS.includes(color) ? color : this._nextColor();
      entry = {
        name,
        contextId: toVirtualContextId(name),
        color: chosenColor,
        badge: COLOR_BADGES[chosenColor] || '🔵',
        createdAt: Date.now(),
        cookies: [],
        localStorage: {},
        sessionStorage: {}
      };
      this.containers.set(name, entry);
      if (this.autoSave) this.save();
    } else if (color && CONTAINER_COLORS.includes(color) && entry.color !== color) {
      entry.color = color;
      entry.badge = COLOR_BADGES[color] || '🔵';
      if (this.autoSave) this.save();
    }
    return entry;
  }

  getContainer(rawName) {
    try {
      const name = normalizeContainerName(rawName);
      return this.containers.get(name) || null;
    } catch {
      return null;
    }
  }

  getContainerByContextId(contextId) {
    const name = fromVirtualContextId(contextId);
    if (name && this.containers.has(name)) {
      return this.containers.get(name);
    }
    for (const entry of this.containers.values()) {
      if (entry.contextId === contextId) return entry;
    }
    return null;
  }

  /**
   * Return all containers in deterministic creation order (so `isolated-context-1`,
   * `isolated-context-2` in `chrome-devtools-mcp` map deterministically).
   */
  listContainers() {
    const sorted = Array.from(this.containers.values()).sort(
      (a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name)
    );
    return sorted.map((entry, idx) => ({
      name: entry.name,
      contextId: entry.contextId,
      mcpIsolatedContextName: `isolated-context-${idx + 1}`,
      color: entry.color,
      badge: entry.badge || COLOR_BADGES[entry.color] || '🔵',
      title: `${entry.badge || COLOR_BADGES[entry.color] || '🔵'} ${entry.name}`,
      createdAt: entry.createdAt,
      cookieCount: entry.cookies.length,
      originsCount: Object.keys(entry.localStorage || {}).length
    }));
  }

  clearContainer(rawName) {
    const entry = this.getContainer(rawName);
    if (!entry) return false;
    entry.cookies = [];
    entry.localStorage = {};
    entry.sessionStorage = {};
    if (this.autoSave) this.save();
    return true;
  }

  deleteContainer(rawName) {
    try {
      const name = normalizeContainerName(rawName);
      const existed = this.containers.delete(name);
      if (existed && this.autoSave) this.save();
      return existed;
    } catch {
      return false;
    }
  }

  /**
   * Store one or more `Set-Cookie` headers into a container's cookie jar.
   */
  applySetCookieHeaders(rawName, setCookieHeaders, requestUrl) {
    const entry = this.ensureContainer(rawName);
    const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
    let changed = false;
    const now = Date.now();

    for (const rawHeader of list) {
      const parsed = parseSetCookieHeader(rawHeader, requestUrl);
      if (!parsed) continue;

      const existingIdx = entry.cookies.findIndex(
        c =>
          c.name === parsed.name &&
          c.domain === parsed.domain &&
          c.path === parsed.path &&
          Boolean(c.hostOnly) === Boolean(parsed.hostOnly)
      );

      if (parsed.expires !== null && parsed.expires <= now) {
        if (existingIdx !== -1) {
          entry.cookies.splice(existingIdx, 1);
          changed = true;
        }
        continue;
      }

      if (existingIdx !== -1) {
        parsed.createdAt = entry.cookies[existingIdx].createdAt || now;
        entry.cookies[existingIdx] = parsed;
      } else {
        entry.cookies.push(parsed);
        if (entry.cookies.length > MAX_COOKIES_PER_CONTAINER) {
          entry.cookies.shift();
        }
      }
      changed = true;
    }

    if (changed && this.autoSave) {
      this.save();
    }
    return changed;
  }

  /**
   * Retrieve matching cookies for a request URL per RFC 6265 Section 5.4.
   */
  getCookiesForUrl(rawName, urlString, { includeHttpOnly = true } = {}) {
    const entry = this.getContainer(rawName);
    if (!entry) return [];

    let parsedUrl;
    try {
      parsedUrl = new URL(urlString);
    } catch {
      return [];
    }

    const now = Date.now();
    const isSecure = parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'wss:';
    const reqHost = parsedUrl.hostname.toLowerCase();
    const reqPath = parsedUrl.pathname || '/';

    // Prune expired cookies in place
    entry.cookies = entry.cookies.filter(c => c.expires === null || c.expires > now);

    const matched = entry.cookies.filter(c => {
      if (!includeHttpOnly && c.httpOnly) return false;
      if (c.secure && !isSecure) return false;
      if (!domainMatches(reqHost, c.domain, c.hostOnly)) return false;
      if (!pathMatches(reqPath, c.path)) return false;
      return true;
    });

    matched.sort((a, b) => {
      if (b.path.length !== a.path.length) {
        return b.path.length - a.path.length;
      }
      return (a.createdAt || 0) - (b.createdAt || 0);
    });

    return matched;
  }

  getCookieHeaderForUrl(rawName, urlString) {
    const cookies = this.getCookiesForUrl(rawName, urlString, { includeHttpOnly: true });
    if (cookies.length === 0) return '';
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  setStorageItem(rawName, origin, key, value, { session = false } = {}) {
    const entry = this.ensureContainer(rawName);
    const store = session ? entry.sessionStorage : entry.localStorage;
    if (!store[origin]) {
      store[origin] = {};
    }
    const bucket = store[origin];
    if (
      !(key in bucket) &&
      Object.keys(bucket).length >= MAX_STORAGE_KEYS_PER_ORIGIN
    ) {
      return false;
    }
    bucket[String(key)] = String(value);
    if (!session && this.autoSave) {
      this.save();
    }
    return true;
  }

  removeStorageItem(rawName, origin, key, { session = false } = {}) {
    const entry = this.getContainer(rawName);
    if (!entry) return false;
    const store = session ? entry.sessionStorage : entry.localStorage;
    if (!store[origin] || !(key in store[origin])) return false;
    delete store[origin][key];
    if (!session && this.autoSave) {
      this.save();
    }
    return true;
  }

  clearStorageOrigin(rawName, origin, { session = false } = {}) {
    const entry = this.getContainer(rawName);
    if (!entry) return false;
    const store = session ? entry.sessionStorage : entry.localStorage;
    delete store[origin];
    if (!session && this.autoSave) {
      this.save();
    }
    return true;
  }

  getStorageSnapshot(rawName, origin, { session = false } = {}) {
    const entry = this.getContainer(rawName);
    if (!entry) return {};
    const store = session ? entry.sessionStorage : entry.localStorage;
    return { ...(store[origin] || {}) };
  }

  /**
   * Build Manifest V3 `declarativeNetRequest` (DNR) session rules for a specific tabId
   * belonging to `containerName` (Addresses Fable Review B1, B3, H2, H3):
   * - Strips `Set-Cookie` on responses for `tabIds: [tabId]` BEFORE Chrome commits to default jar (B1).
   * - Sets `Cookie` header on requests for `tabIds: [tabId]` per domain AFTER Chrome attaches default jar cookies (B3).
   * - Supports fail-closed `block` rule when `chrome.debugger` detaches unexpectedly (H2/H3).
   */
  buildDnrSessionRulesForTab(rawName, tabId, { failClosedBlocked = false } = {}) {
    const numericTabId = Number(tabId);
    if (!Number.isInteger(numericTabId) || numericTabId <= 0) {
      return [];
    }

    const baseRuleId = numericTabId * 100;
    const rules = [];

    if (failClosedBlocked) {
      rules.push({
        id: baseRuleId,
        priority: 1000,
        action: { type: 'block' },
        condition: {
          tabIds: [numericTabId],
          urlFilter: '*',
          excludedResourceTypes: []
        }
      });
      return rules;
    }

    // Rule 1: Always strip `Set-Cookie` from responses on this container tab so Chrome's
    // default cookie jar is never polluted (Fixes B1).
    // Note: `excludedResourceTypes: []` is mandatory in Chrome DNR so `main_frame` is included!
    rules.push({
      id: baseRuleId + 1,
      priority: 100,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [{ header: 'set-cookie', operation: 'remove' }]
      },
      condition: {
        tabIds: [numericTabId],
        excludedResourceTypes: []
      }
    });

    // Rule 2: Remove any default-jar `Cookie` header on requests from this container tab
    // by default (lower priority than domain-specific container Cookie rules).
    rules.push({
      id: baseRuleId + 2,
      priority: 150,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'cookie', operation: 'remove' }]
      },
      condition: {
        tabIds: [numericTabId],
        excludedResourceTypes: []
      }
    });

    const entry = this.getContainer(rawName);
    if (!entry) return rules;

    const now = Date.now();
    const validCookies = entry.cookies.filter(c => c.expires === null || c.expires > now);

    // Group cookies by domain
    const byDomain = new Map();
    for (const c of validCookies) {
      const dom = c.domain;
      if (!byDomain.has(dom)) {
        byDomain.set(dom, []);
      }
      byDomain.get(dom).push(c);
    }

    let offset = 3;
    for (const [domain, domainCookies] of byDomain.entries()) {
      if (offset >= 99) break;
      domainCookies.sort((a, b) => b.path.length - a.path.length || (a.createdAt || 0) - (b.createdAt || 0));
      const cookieHeaderValue = domainCookies.map(c => `${c.name}=${c.value}`).join('; ');
      const allSecure = domainCookies.every(c => c.secure);
      const strictOrLax = domainCookies.every(c => c.sameSite === 'Strict' || c.sameSite === 'Lax');

      const condition = {
        tabIds: [numericTabId],
        requestDomains: [domain],
        excludedResourceTypes: []
      };
      if (allSecure) {
        condition.urlFilter = '|https*';
      }
      if (strictOrLax) {
        condition.domainType = 'firstParty';
      }

      rules.push({
        id: baseRuleId + offset,
        priority: 200,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            {
              header: 'cookie',
              operation: 'set',
              value: cookieHeaderValue
            }
          ]
        },
        condition
      });
      offset += 1;
    }

    return rules;
  }

  /**
   * Generate synchronous page initialization script for `Page.addScriptToEvaluateOnNewDocument`.
   * Virtualizes `document.cookie` (non-HttpOnly), `window.cookieStore`, `localStorage`,
   * `sessionStorage`, and blocks shared `serviceWorker.register` inside container tabs.
   */
  buildInitScript(rawName, { sessionStorage = null } = {}) {
    const entry = this.ensureContainer(rawName);
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

    const initialPayload = JSON.stringify({
      container: entry.name,
      cookies: jsCookies,
      localStorage: entry.localStorage || {},
      sessionStorage: sessionStorage || entry.sessionStorage || {}
    });

    return `(() => {
  if (window.__chrometetherContainerInitialized) return;
  Object.defineProperty(window, '__chrometetherContainerInitialized', { value: true, configurable: false });

  // Capture primordial intrinsics and remove the global CDP binding so untrusted page scripts
  // cannot invoke window.__chrometether_vault_sync directly or tamper with prototypes.
  const JSONStringify = JSON.stringify;
  const ObjectKeys = Object.keys;
  const ObjectHasOwn = Object.prototype.hasOwnProperty;
  const rawSyncBinding = typeof window.__chrometether_vault_sync === 'function'
    ? window.__chrometether_vault_sync
    : null;
  let activeSyncBinding = rawSyncBinding;
  try {
    delete window.__chrometether_vault_sync;
  } catch {}
  const getSyncBinding = () => {
    if (typeof window.__chrometether_vault_sync === 'function') {
      activeSyncBinding = window.__chrometether_vault_sync;
      try {
        delete window.__chrometether_vault_sync;
      } catch {}
    }
    return activeSyncBinding;
  };

  const state = ${initialPayload};
  try {
    Object.defineProperty(window, '__chrometether_receive_state', {
      value: (incoming) => {
        if (!incoming || typeof incoming !== 'object') return;
        if (Array.isArray(incoming.cookies)) {
          state.cookies.length = 0;
          for (const c of incoming.cookies) state.cookies.push(c);
        }
        if (incoming.localStorage && typeof incoming.localStorage === 'object') {
          for (const k of ObjectKeys(state.localStorage)) {
            if (!ObjectHasOwn.call(incoming.localStorage, k)) delete state.localStorage[k];
          }
          for (const origin of ObjectKeys(incoming.localStorage)) {
            const srcBucket = incoming.localStorage[origin] || {};
            if (!state.localStorage[origin]) state.localStorage[origin] = {};
            const dstBucket = state.localStorage[origin];
            for (const bk of ObjectKeys(dstBucket)) {
              if (!ObjectHasOwn.call(srcBucket, bk)) delete dstBucket[bk];
            }
            for (const bk of ObjectKeys(srcBucket)) {
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
  const notifyHub = (payload) => {
    try {
      const fn = getSyncBinding();
      if (fn) {
        fn(JSONStringify({ ...payload }));
      }
    } catch {}
  };

  const domainMatches = (host, dom, hostOnly) => {
    const h = String(host || '').toLowerCase();
    const d = String(dom || '').toLowerCase().replace(/^\\.+/, '');
    if (!h || !d) return false;
    if (h === d) return true;
    if (hostOnly) return false;
    return h.endsWith('.' + d);
  };

  const pathMatches = (reqP, cookP) => {
    const r = String(reqP || '/');
    const c = String(cookP || '/');
    if (r === c) return true;
    if (r.startsWith(c)) {
      return c.endsWith('/') || r[c.length] === '/';
    }
    return false;
  };

  const getMatchingCookies = () => {
    const nowTs = Date.now();
    const isSecure = location.protocol === 'https:';
    const host = location.hostname.toLowerCase();
    const path = location.pathname || '/';
    return state.cookies.filter(c => {
      if (c.expires !== null && c.expires !== undefined && c.expires <= nowTs) return false;
      if (c.secure && !isSecure) return false;
      if (!domainMatches(host, c.domain, c.hostOnly)) return false;
      if (!pathMatches(path, c.path)) return false;
      return true;
    });
  };

  const applyCookieString = (rawCookieStr) => {
    const str = String(rawCookieStr || '').trim();
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
      if (k === 'domain' && v) {
        domain = v.toLowerCase().replace(/^\\.+/, '');
        hostOnly = false;
      } else if (k === 'path' && v.startsWith('/')) {
        path = v;
      } else if (k === 'secure') {
        secure = true;
      } else if (k === 'max-age' && v !== '') {
        const sec = parseInt(v, 10);
        if (!Number.isNaN(sec)) expires = sec <= 0 ? 0 : Date.now() + sec * 1000;
      } else if (k === 'expires' && v && expires === null) {
        const ts = Date.parse(v);
        if (!Number.isNaN(ts)) expires = ts;
      } else if (k === 'httponly') {
        // document.cookie cannot set HttpOnly cookies
        return;
      }
    }
    const existingIdx = state.cookies.findIndex(c => c.name === name && c.domain === domain && c.path === path);
    if (expires !== null && expires <= Date.now()) {
      if (existingIdx !== -1) state.cookies.splice(existingIdx, 1);
    } else {
      const entry = { name, value, domain, hostOnly, path, secure, sameSite: 'Lax', expires };
      if (existingIdx !== -1) state.cookies[existingIdx] = entry;
      else state.cookies.push(entry);
    }
    notifyHub({ type: 'setCookie', cookie: str, url: location.href });
  };

  try {
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      enumerable: true,
      get() {
        return getMatchingCookies().map(c => c.name + '=' + c.value).join('; ');
      },
      set(val) {
        applyCookieString(val);
      }
    });
  } catch {}

  // Virtualize window.cookieStore
  try {
    const virtualCookieStore = {
      async get(nameOrOpts) {
        const name = typeof nameOrOpts === 'string' ? nameOrOpts : nameOrOpts?.name;
        const found = getMatchingCookies().find(c => !name || c.name === name);
        return found ? { name: found.name, value: found.value, domain: found.domain, path: found.path } : null;
      },
      async getAll(nameOrOpts) {
        const name = typeof nameOrOpts === 'string' ? nameOrOpts : nameOrOpts?.name;
        return getMatchingCookies()
          .filter(c => !name || c.name === name)
          .map(c => ({ name: c.name, value: c.value, domain: c.domain, path: c.path }));
      },
      async set(nameOrObj, value) {
        if (typeof nameOrObj === 'string') {
          applyCookieString(nameOrObj + '=' + (value ?? ''));
        } else if (nameOrObj && typeof nameOrObj === 'object') {
          applyCookieString(nameOrObj.name + '=' + (nameOrObj.value ?? ''));
        }
      },
      async delete(nameOrOpts) {
        const name = typeof nameOrOpts === 'string' ? nameOrOpts : nameOrOpts?.name;
        if (name) applyCookieString(name + '=; Max-Age=0');
      }
    };
    Object.defineProperty(window, 'cookieStore', {
      value: virtualCookieStore,
      configurable: true
    });
  } catch {}

  // Virtualize localStorage and sessionStorage
  const createVirtualStorage = (bucketMap, isSession) => {
    const getOriginBucket = () => {
      const origin = location.origin || 'null';
      if (!bucketMap[origin]) bucketMap[origin] = {};
      return bucketMap[origin];
    };
    const api = {
      getItem(k) {
        const b = getOriginBucket();
        return Object.prototype.hasOwnProperty.call(b, String(k)) ? b[String(k)] : null;
      },
      setItem(k, v) {
        const key = String(k);
        const val = String(v);
        const b = getOriginBucket();
        const oldVal = Object.prototype.hasOwnProperty.call(b, key) ? b[key] : null;
        b[key] = val;
        notifyHub({ type: 'storageSet', session: isSession, origin: location.origin, key, value: val });
        try {
          window.dispatchEvent(new StorageEvent('storage', { key, oldValue: oldVal, newValue: val, url: location.href }));
        } catch {}
      },
      removeItem(k) {
        const key = String(k);
        const b = getOriginBucket();
        delete b[key];
        notifyHub({ type: 'storageRemove', session: isSession, origin: location.origin, key });
      },
      clear() {
        const origin = location.origin || 'null';
        bucketMap[origin] = {};
        notifyHub({ type: 'storageClear', session: isSession, origin });
      },
      key(idx) {
        const keys = Object.keys(getOriginBucket());
        return keys[idx] ?? null;
      }
    };
    return new Proxy(api, {
      get(target, prop) {
        if (prop === 'length') return Object.keys(getOriginBucket()).length;
        if (prop in target) return target[prop].bind(target);
        const b = getOriginBucket();
        return Object.prototype.hasOwnProperty.call(b, prop) ? b[prop] : undefined;
      },
      set(target, prop, value) {
        target.setItem(prop, value);
        return true;
      },
      deleteProperty(target, prop) {
        target.removeItem(prop);
        return true;
      },
      ownKeys() {
        return Object.keys(getOriginBucket());
      },
      getOwnPropertyDescriptor(target, prop) {
        const b = getOriginBucket();
        if (Object.prototype.hasOwnProperty.call(b, prop)) {
          return { enumerable: true, configurable: true, value: b[prop], writable: true };
        }
        return undefined;
      }
    });
  };

  try {
    const vLocal = createVirtualStorage(state.localStorage, false);
    const vSession = createVirtualStorage(state.sessionStorage, true);
    Object.defineProperty(window, 'localStorage', { value: vLocal, configurable: true });
    Object.defineProperty(window, 'sessionStorage', { value: vSession, configurable: true });
  } catch {}

  // Prevent site Service Workers from bypassing tab-scoped container isolation (Fable H4)
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = () => Promise.reject(new DOMException('ServiceWorker disabled in ChromeTether Container Tab', 'SecurityError'));
    }
  } catch {}
})();`;
  }

  /**
   * Load containers from disk, pruning expired and session-only cookies.
   */
  load() {
    this.containers.clear();
    if (!this.filePath || !fs.existsSync(this.filePath)) {
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const now = Date.now();
      const list = Array.isArray(parsed?.containers) ? parsed.containers : [];
      for (const item of list) {
        if (!item?.name) continue;
        const name = normalizeContainerName(item.name);
        const color = CONTAINER_COLORS.includes(item.color) ? item.color : this._nextColor();
        const cookies = Array.isArray(item.cookies)
          ? item.cookies.filter(c => c && c.name && c.expires !== null && c.expires > now)
          : [];
        this.containers.set(name, {
          name,
          contextId: toVirtualContextId(name),
          color,
          badge: COLOR_BADGES[color] || '🔵',
          createdAt: Number(item.createdAt) || now,
          cookies,
          localStorage: item.localStorage && typeof item.localStorage === 'object' ? item.localStorage : {},
          sessionStorage: {}
        });
      }
    } catch {
      // Ignore corrupt vault file and start fresh
    }
  }

  /**
   * Persist containers atomically (`.tmp` + `rename`) with restricted `0o600` permissions (Fable H5/L2).
   */
  save() {
    if (!this.filePath) return;
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

    const now = Date.now();
    const serialized = {
      version: 2,
      updatedAt: now,
      containers: Array.from(this.containers.values()).map(entry => ({
        name: entry.name,
        contextId: entry.contextId,
        color: entry.color,
        createdAt: entry.createdAt,
        // Persist only non-expired persistent cookies (session cookies where expires === null are pruned on restart)
        cookies: entry.cookies.filter(c => c.expires !== null && c.expires > now),
        localStorage: entry.localStorage || {}
      }))
    };

    const tmpFile = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(serialized, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpFile, this.filePath);
  }
}
