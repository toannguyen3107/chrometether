import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_PAGES = 500;
const MAX_ENDPOINTS = 1000;
const MAX_REQUESTS_PER_CALL = 200;
const MAX_ORIGINS = 10;
const MAX_INPUT_LENGTH = 4096;

function parseWebUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_INPUT_LENGTH) {
    throw new Error('Expected a web URL shorter than 4096 characters');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP(S) URLs without embedded credentials are supported');
  }
  return url;
}

function pathTemplate(pathname) {
  return pathname.split('/').map(segment => {
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      decoded = segment;
    }
    if (/^\d+$/.test(decoded) ||
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded) ||
        /^[0-9a-f]{24,}$/i.test(decoded) ||
        /^[A-Za-z0-9_-]{32,}$/.test(decoded)) {
      return '{id}';
    }
    return segment;
  }).join('/') || '/';
}

function addUnique(target, items, limit = 50) {
  for (const item of items) {
    if (!target.includes(item) && target.length < limit) target.push(item);
  }
  target.sort();
}

function queryNames(url) {
  return [...new Set(url.searchParams.keys())].filter(name => name.length <= 100).sort();
}

function requestKind(url, method, resourceType) {
  const type = String(resourceType || '').toLowerCase();
  if (['fetch', 'xhr'].includes(type) || /^\/(api|graphql|v\d+)(\/|$)/i.test(url.pathname)) return 'api';
  if (method !== 'GET' && method !== 'HEAD') return 'api';
  if (type === 'document') return 'navigation';
  if (['script', 'stylesheet', 'image', 'font', 'media'].includes(type) || /\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ico)$/i.test(url.pathname)) return 'asset';
  return 'other';
}

function validateOrigin(origin) {
  const url = parseWebUrl(origin);
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Allowed origins must be origins, such as https://example.com');
  }
  return url.origin;
}

export class AppMapStore {
  constructor(filePath = process.env.CHROMETETHER_MAP_FILE || path.join(os.homedir(), '.chrometether', 'app-map.json')) {
    this.filePath = filePath;
  }

  read() {
    if (!fs.existsSync(this.filePath)) throw new Error('No application map. Call start_app_map first.');
    const map = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (map.version !== 1 || !Array.isArray(map.allowedOrigins) || !Array.isArray(map.pages) || !Array.isArray(map.endpoints)) {
      throw new Error('Unsupported application map file');
    }
    return map;
  }

  write(map) {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(directory, `.app-map-${process.pid}-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(map, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.filePath);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  start(targetUrl, allowedOrigins = []) {
    const target = parseWebUrl(targetUrl);
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length > MAX_ORIGINS) {
      throw new Error(`allowed_origins must contain at most ${MAX_ORIGINS} origins`);
    }
    const origins = [...new Set([target.origin, ...allowedOrigins.map(validateOrigin)])].sort();
    const now = new Date().toISOString();
    const map = { version: 1, allowedOrigins: origins, startedAt: now, updatedAt: now, pages: [], endpoints: [] };
    this.write(map);
    return this.summary(map);
  }

  assertAllowed(map, url) {
    if (!map.allowedOrigins.includes(url.origin)) {
      throw new Error(`Origin ${url.origin} is outside this application map`);
    }
  }

  recordPage(pageUrl, title = '') {
    const map = this.read();
    const url = parseWebUrl(pageUrl);
    this.assertAllowed(map, url);
    if (title == null) title = '';
    if (typeof title !== 'string') throw new Error('title must be a string');
    title = title.slice(0, 200);
    const pagePath = pathTemplate(url.pathname);
    const key = url.origin + pagePath;
    let page = map.pages.find(item => item.url === key);
    if (!page) {
      if (map.pages.length >= MAX_PAGES) throw new Error(`Application map reached its ${MAX_PAGES}-page limit`);
      page = { url: key, title, queryParameters: [], visits: 0 };
      map.pages.push(page);
    }
    if (title) page.title = title;
    page.visits++;
    addUnique(page.queryParameters, queryNames(url));
    map.updatedAt = new Date().toISOString();
    this.write(map);
    return { page, counts: this.counts(map) };
  }

  recordRequests(pageUrl, requests) {
    const map = this.read();
    const page = parseWebUrl(pageUrl);
    this.assertAllowed(map, page);
    if (!Array.isArray(requests) || requests.length > MAX_REQUESTS_PER_CALL) {
      throw new Error(`requests must be an array of at most ${MAX_REQUESTS_PER_CALL} items`);
    }
    let recorded = 0;
    let skipped = 0;
    const pageKey = page.origin + pathTemplate(page.pathname);
    for (const request of requests) {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        skipped++;
        continue;
      }
      let url;
      try {
        url = parseWebUrl(request.url);
      } catch {
        skipped++;
        continue;
      }
      if (!map.allowedOrigins.includes(url.origin)) {
        skipped++;
        continue;
      }
      const method = String(request.method || 'GET').toUpperCase();
      if (!/^[A-Z]{1,20}$/.test(method)) {
        skipped++;
        continue;
      }
      const endpointPath = pathTemplate(url.pathname);
      const resourceType = request.resourceType ?? request.resource_type;
      const kind = requestKind(url, method, resourceType);
      const key = `${method} ${url.origin}${endpointPath}`;
      let endpoint = map.endpoints.find(item => item.key === key);
      if (!endpoint) {
        if (map.endpoints.length >= MAX_ENDPOINTS) throw new Error(`Application map reached its ${MAX_ENDPOINTS}-endpoint limit`);
        endpoint = { key, method, origin: url.origin, path: endpointPath, kind, count: 0, statusCodes: [], resourceTypes: [], queryParameters: [], seenOnPages: [] };
        map.endpoints.push(endpoint);
      }
      if (kind === 'api') endpoint.kind = 'api';
      endpoint.count++;
      const status = Number(request.status);
      if (Number.isInteger(status) && status >= 100 && status <= 599) addUnique(endpoint.statusCodes, [status]);
      if (typeof resourceType === 'string' && /^[\w-]{1,40}$/.test(resourceType)) {
        addUnique(endpoint.resourceTypes, [resourceType]);
      }
      addUnique(endpoint.queryParameters, queryNames(url));
      addUnique(endpoint.seenOnPages, [pageKey]);
      recorded++;
    }
    map.updatedAt = new Date().toISOString();
    this.write(map);
    return { recorded, skipped, counts: this.counts(map) };
  }

  counts(map) {
    return { pageCount: map.pages.length, endpointCount: map.endpoints.length, apiEndpointCount: map.endpoints.filter(item => item.kind === 'api').length };
  }

  summary(map = this.read()) {
    return {
      allowedOrigins: map.allowedOrigins,
      startedAt: map.startedAt,
      updatedAt: map.updatedAt,
      ...this.counts(map),
      pages: map.pages,
      endpoints: map.endpoints
    };
  }
}
