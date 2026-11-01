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

export const DNR_ALL_RESOURCE_TYPES = [
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

/**
 * Compute a positive 32-bit signed integer base rule ID for Chrome DNR.
 * Real Chrome tabIds can exceed 21,474,836 (e.g. 486,741,406), so multiplying
 * directly by 100 overflows INT32_MAX (2,147,483,647) and causes DNR to reject rules.
 */
export function getTabDnrSlotId(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId) || numericTabId <= 0) return 0;
  return ((numericTabId - 1) % 19999999) + 1;
}

export function getTabDnrBaseRuleId(tabId) {
  const slotId = getTabDnrSlotId(tabId);
  return slotId > 0 ? slotId * 100 : 0;
}

export function toCdpCookie(c) {
  const name = String(c.name || '');
  const value = String(c.value || '');
  const cleanDomain = String(c.domain || '').replace(/^\.+/, '');
  return {
    name,
    value,
    domain: c.hostOnly ? cleanDomain : `.${cleanDomain}`,
    path: c.path || '/',
    expires: c.expires === null || c.expires === undefined ? -1 : Math.floor(c.expires / 1000),
    size: Buffer.byteLength(name + value, 'utf8'),
    httpOnly: Boolean(c.httpOnly),
    secure: Boolean(c.secure),
    session: c.expires === null || c.expires === undefined,
    sameSite: c.sameSite || 'Lax',
    priority: 'Medium',
    sameParty: false,
    sourceScheme: c.secure ? 'Secure' : 'NonSecure',
    sourcePort: c.secure ? 443 : 80
  };
}

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

  exportContainersSnapshot() {
    return this.listContainers().map(info => {
      const entry = this.containers.get(info.name);
      return {
        ...info,
        cookies: entry ? [...entry.cookies] : [],
        localStorage: entry ? { ...entry.localStorage } : {}
      };
    });
  }

  mergeContainerData(rawName, { color, createdAt, cookies, localStorage } = {}) {
    const entry = this.ensureContainer(rawName, { color });
    let changed = false;
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
          changed = true;
        } else if (entry.cookies[idx].value !== String(c.value ?? '')) {
          entry.cookies[idx] = {
            ...entry.cookies[idx],
            value: String(c.value ?? ''),
            secure: Boolean(c.secure),
            httpOnly: Boolean(c.httpOnly),
            sameSite: c.sameSite || 'Lax',
            expires: c.expires ?? null
          };
          changed = true;
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
          changed = true;
        }
      }
    }
    if (changed && this.autoSave) {
      this.save();
    }
    return changed;
  }

  getCdpCookies(rawName, urls = null) {
    const entry = this.getContainer(rawName);
    if (!entry) return [];
    const now = Date.now();
    entry.cookies = entry.cookies.filter(c => c.expires === null || c.expires > now);

    if (Array.isArray(urls) && urls.length > 0) {
      const seen = new Set();
      const result = [];
      for (const u of urls) {
        for (const c of this.getCookiesForUrl(rawName, u, { includeHttpOnly: true })) {
          const key = `${c.name}\0${c.domain}\0${c.path}\0${Boolean(c.hostOnly)}`;
          if (!seen.has(key)) {
            seen.add(key);
            result.push(toCdpCookie(c));
          }
        }
      }
      return result;
    }

    return entry.cookies.map(toCdpCookie);
  }

  setCdpCookie(rawName, param = {}) {
    if (!param || typeof param.name !== 'string' || !param.name.trim()) {
      return false;
    }
    const name = param.name.trim();
    const value = String(param.value ?? '');
    let parsedUrl = null;
    if (param.url) {
      try {
        parsedUrl = new URL(param.url);
      } catch {
        parsedUrl = null;
      }
    }
    const reqHost = parsedUrl ? parsedUrl.hostname.toLowerCase() : '';
    let domain = '';
    let hostOnly = true;
    if (param.domain) {
      domain = String(param.domain).toLowerCase().replace(/^\.+/, '');
      hostOnly = false;
      if (reqHost && !domainMatches(reqHost, domain, false)) {
        return false;
      }
    } else if (reqHost) {
      domain = reqHost;
      hostOnly = true;
    } else {
      return false;
    }

    const cookiePath = param.path && String(param.path).startsWith('/')
      ? String(param.path)
      : parsedUrl
        ? computeDefaultCookiePath(parsedUrl.pathname)
        : '/';
    const isHttps = parsedUrl
      ? parsedUrl.protocol === 'https:' || parsedUrl.protocol === 'wss:'
      : Boolean(param.secure);
    const secure = Boolean(param.secure) || (parsedUrl ? parsedUrl.protocol === 'https:' && name.startsWith('__') : false);
    if (name.startsWith('__Secure-') && (!secure || !isHttps)) {
      return false;
    }
    if (name.startsWith('__Host-') && (!secure || !isHttps || !hostOnly || cookiePath !== '/')) {
      return false;
    }

    let expires = null;
    if (typeof param.expires === 'number' && param.expires !== -1) {
      expires = param.expires > 1e11 ? Math.floor(param.expires) : Math.floor(param.expires * 1000);
    }

    const entry = this.ensureContainer(rawName);
    const now = Date.now();
    const existingIdx = entry.cookies.findIndex(
      c =>
        c.name === name &&
        c.domain === domain &&
        c.path === cookiePath &&
        Boolean(c.hostOnly) === Boolean(hostOnly)
    );

    if (expires !== null && expires <= now) {
      if (existingIdx !== -1) {
        entry.cookies.splice(existingIdx, 1);
        if (this.autoSave) this.save();
      }
      return true;
    }

    const record = {
      name,
      value,
      domain,
      hostOnly,
      path: cookiePath,
      secure: Boolean(param.secure),
      httpOnly: Boolean(param.httpOnly),
      sameSite: param.sameSite || 'Lax',
      expires,
      createdAt: existingIdx !== -1 ? entry.cookies[existingIdx].createdAt || now : now
    };
    if (existingIdx !== -1) {
      entry.cookies[existingIdx] = record;
    } else {
      entry.cookies.push(record);
      if (entry.cookies.length > MAX_COOKIES_PER_CONTAINER) {
        entry.cookies.shift();
      }
    }
    if (this.autoSave) this.save();
    return true;
  }

  deleteCdpCookies(rawName, { name, url, domain, path: cookiePath } = {}) {
    const entry = this.getContainer(rawName);
    if (!entry || !name) return false;
    let urlHost = '';
    if (url) {
      try {
        urlHost = new URL(url).hostname.toLowerCase();
      } catch {
        urlHost = '';
      }
    }
    const cleanDomain = domain ? String(domain).toLowerCase().replace(/^\.+/, '') : '';
    const before = entry.cookies.length;
    entry.cookies = entry.cookies.filter(c => {
      if (c.name !== name) return true;
      if (cleanDomain && c.domain !== cleanDomain) return true;
      if (!cleanDomain && urlHost && !domainMatches(urlHost, c.domain, c.hostOnly)) return true;
      if (cookiePath && c.path !== cookiePath) return true;
      return false;
    });
    const changed = entry.cookies.length !== before;
    if (changed && this.autoSave) this.save();
    return changed;
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

    const baseRuleId = getTabDnrBaseRuleId(numericTabId);
    const rules = [];

    if (failClosedBlocked) {
      rules.push({
        id: baseRuleId,
        priority: 1000,
        action: { type: 'block' },
        condition: {
          tabIds: [numericTabId],
          urlFilter: '*',
          resourceTypes: [...DNR_ALL_RESOURCE_TYPES]
        }
      });
      return rules;
    }

    // Rule 1: Always strip `Set-Cookie` from responses on this container tab so Chrome's
    // default cookie jar is never polluted (Fixes B1).
    // Note: Explicit `resourceTypes` including `main_frame` is required in Chromium DNR!
    rules.push({
      id: baseRuleId + 1,
      priority: 100,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [{ header: 'set-cookie', operation: 'remove' }]
      },
      condition: {
        tabIds: [numericTabId],
        resourceTypes: [...DNR_ALL_RESOURCE_TYPES]
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
        resourceTypes: [...DNR_ALL_RESOURCE_TYPES]
      }
    });

    const entry = this.getContainer(rawName);
    if (!entry) return rules;

    const now = Date.now();
    const validCookies = entry.cookies.filter(c => c.expires === null || c.expires > now);

    // Collect unique cookie domains and include parent-domain cookies for subdomains
    // so subdomain rules (e.g. www.expedia.com) include parent cookies (e.g. expedia.com)
    // and win via higher priority over the parent domain rule.
    const uniqueDomains = [...new Set(validCookies.map(c => c.domain).filter(Boolean))];

    let offset = 3;
    for (const domain of uniqueDomains) {
      if (offset >= 98) break;
      const domainCookies = validCookies.filter(c => domainMatches(domain, c.domain, c.hostOnly));
      if (domainCookies.length === 0) continue;

      domainCookies.sort((a, b) => b.path.length - a.path.length || (a.createdAt || 0) - (b.createdAt || 0));
      const specificity = Math.min(40, domain.split('.').length);
      const hasSecure = domainCookies.some(c => c.secure);
      const httpCookies = domainCookies.filter(c => !c.secure);

      if (hasSecure) {
        // Higher-priority HTTPS rule includes both Secure and non-Secure cookies.
        // Per official Chrome DNR evaluation order, a higher-priority 'set' rule prevents
        // any lower-priority 'set' rule from modifying the Cookie header on HTTPS requests.
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

        // Lower-priority fallback rule for plain HTTP requests includes ONLY non-Secure cookies
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
          const sev = new StorageEvent('storage', { key, oldValue: oldVal, newValue: val, url: location.href });
          Object.defineProperty(sev, '__chrometetherSynthetic', { value: true });
          window.dispatchEvent(sev);
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
