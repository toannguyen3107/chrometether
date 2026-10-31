import * as cheerio from 'cheerio';

export const DDG_HTML_ENDPOINT = 'https://html.duckduckgo.com/html/';
export const DDG_LITE_ENDPOINT = 'https://lite.duckduckgo.com/lite/';
export const CHALLENGE_MARKERS = [
  'anomaly-modal',
  'anomaly.js',
  'data-testid="anomaly-modal"',
  'id="challenge-form"',
  'cc=botnet'
];

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref_src',
  'yclid'
]);

export class DDGSearchError extends Error {
  constructor(message, code, { status, endpoint } = {}) {
    super(message);
    this.name = 'DDGSearchError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (endpoint !== undefined) this.endpoint = endpoint;
  }
}

/**
 * Normalizes an optional domain filter.
 * Invalid inputs degrade gracefully to undefined to match Antigravity's "recommend" semantics.
 * @param {string} [domain]
 * @returns {string|undefined}
 */
export function normalizeDomain(domain) {
  if (!domain || typeof domain !== 'string') return undefined;
  let cleaned = domain.trim().toLowerCase();
  if (!cleaned) return undefined;
  cleaned = cleaned.replace(/^https?:\/\//, '');
  const slashIdx = cleaned.indexOf('/');
  if (slashIdx !== -1) cleaned = cleaned.slice(0, slashIdx);
  cleaned = cleaned.replace(/^www\./, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(cleaned) || cleaned.includes('..')) {
    return undefined;
  }
  return cleaned;
}

/**
 * Builds the DuckDuckGo query string, appending site:<domain> when a valid domain is provided.
 * @param {string} query
 * @param {string} [domain]
 * @returns {string}
 */
export function buildQuery(query, domain) {
  const base = String(query || '').trim();
  const normalized = normalizeDomain(domain);
  if (normalized && !/\bsite:/i.test(base)) {
    return `${base} site:${normalized}`;
  }
  return base;
}

/**
 * Checks whether a URL is a DuckDuckGo or Bing ad/tracking redirect.
 * @param {string} href
 * @returns {boolean}
 */
export function isTrackingLink(href) {
  if (!href || typeof href !== 'string') return true;
  const trimmed = href.trim();
  if (!/^(https?:\/\/|\/\/|\/)/i.test(trimmed)) return true;
  try {
    const normalized = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
    const url = new URL(normalized, 'https://duckduckgo.com');
    if (!['http:', 'https:'].includes(url.protocol)) return true;
    const host = url.hostname.toLowerCase();
    if (
      (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) &&
      (url.pathname === '/y.js' || url.searchParams.has('ad_provider') || url.searchParams.has('ad_domain'))
    ) {
      return true;
    }
    if ((host === 'bing.com' || host === 'www.bing.com') && url.pathname === '/aclick') {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

/**
 * Unpacks DuckDuckGo redirect links (e.g. //duckduckgo.com/l/?uddg=...) or returns the direct HTTP(S) URL.
 * @param {string} rawHref
 * @returns {string}
 */
export function unpackDDGLink(rawHref) {
  if (!rawHref || typeof rawHref !== 'string') return '';
  const trimmed = rawHref.trim();
  if (!trimmed) return '';

  try {
    let resolved = trimmed;
    if (trimmed.startsWith('//')) {
      resolved = `https:${trimmed}`;
    } else if (trimmed.startsWith('/')) {
      resolved = `https://duckduckgo.com${trimmed}`;
    }
    const url = new URL(resolved);
    if (!['http:', 'https:'].includes(url.protocol)) return '';

    const host = url.hostname.toLowerCase();
    if ((host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) && url.searchParams.has('uddg')) {
      const target = url.searchParams.get('uddg') || '';
      const targetUrl = new URL(target);
      if (!['http:', 'https:'].includes(targetUrl.protocol)) return '';
      return targetUrl.href;
    }
    return url.href;
  } catch {
    return '';
  }
}

/**
 * Strips common marketing/tracking query parameters while preserving functional query params and hash.
 * @param {string} urlStr
 * @returns {string}
 */
export function stripTrackingParams(urlStr) {
  try {
    const url = new URL(urlStr);
    const keysToDelete = [];
    for (const key of url.searchParams.keys()) {
      if (/^utm_/i.test(key) || TRACKING_PARAMS.has(key.toLowerCase())) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      url.searchParams.delete(key);
    }
    return url.href;
  } catch {
    return urlStr;
  }
}

/**
 * Detects whether DuckDuckGo returned a bot challenge / rate-limit response.
 * @param {number} status
 * @param {string} html
 * @returns {boolean}
 */
export function isChallengeResponse(status, html = '') {
  if (status === 202 || status === 403 || status === 429) {
    return true;
  }
  const body = String(html || '');
  return CHALLENGE_MARKERS.some((marker) => body.includes(marker));
}

/**
 * Parses organic results from DuckDuckGo HTML endpoint markup.
 * @param {string} html
 * @param {number} [maxResults=8]
 * @returns {Array<{ title: string, snippet: string, link: string, source: 'html' }>}
 */
export function parseHtmlResults(html, maxResults = 8) {
  const $ = cheerio.load(html || '');
  const results = [];
  const seen = new Set();

  $('.result').each((_, elem) => {
    if (results.length >= maxResults) return false;
    const $elem = $(elem);

    if (
      $elem.hasClass('result--ad') ||
      $elem.find('.badge--ad, .result__badge-wrap').length > 0
    ) {
      return;
    }

    const titleElem = $elem.find('.result__title a.result__a, .result__title a').first();
    const snippetElem = $elem.find('.result__snippet').first();
    const urlElem = $elem.find('.result__url').first();

    const title = titleElem.text().replace(/\s+/g, ' ').trim();
    const rawHref = titleElem.attr('href') || '';

    let unpacked = unpackDDGLink(rawHref);
    if (!unpacked) {
      const fallbackText = urlElem.text().trim();
      if (fallbackText && !fallbackText.includes('...')) {
        unpacked = unpackDDGLink(fallbackText.startsWith('http') ? fallbackText : `https://${fallbackText}`);
      }
    }

    if (!title || !unpacked || isTrackingLink(unpacked)) {
      return;
    }

    const link = stripTrackingParams(unpacked);
    if (seen.has(link)) return;
    seen.add(link);

    const snippet = snippetElem.text().replace(/\s+/g, ' ').trim();
    results.push({
      title,
      snippet,
      link,
      source: 'html'
    });
  });

  return results;
}

/**
 * Parses organic results from DuckDuckGo Lite endpoint markup.
 * @param {string} html
 * @param {number} [maxResults=8]
 * @returns {Array<{ title: string, snippet: string, link: string, source: 'lite' }>}
 */
export function parseLiteResults(html, maxResults = 8) {
  const $ = cheerio.load(html || '');
  const results = [];
  const seen = new Set();

  $('a.result-link').each((_, elem) => {
    if (results.length >= maxResults) return false;
    const $link = $(elem);
    const parentRow = $link.closest('tr');
    if (parentRow.hasClass('result-sponsored')) {
      return;
    }

    const title = $link.text().replace(/\s+/g, ' ').trim();
    if (!title || title.toLowerCase() === 'more info') {
      return;
    }

    const rawHref = $link.attr('href') || '';
    const unpacked = unpackDDGLink(rawHref);
    if (!unpacked || isTrackingLink(unpacked)) {
      return;
    }

    const link = stripTrackingParams(unpacked);
    if (seen.has(link)) return;
    seen.add(link);

    let snippet = '';
    const followingRows = parentRow.nextAll('tr');
    for (let i = 0; i < followingRows.length; i++) {
      const $row = $(followingRows[i]);
      if ($row.find('a.result-link').length > 0) break;
      const $snippetCell = $row.find('td.result-snippet');
      if ($snippetCell.length > 0) {
        snippet = $snippetCell.first().text().replace(/\s+/g, ' ').trim();
        break;
      }
    }

    results.push({
      title,
      snippet,
      link,
      source: 'lite'
    });
  });

  return results;
}

/**
 * Prioritizes results matching the requested domain; falls back to all results if none match.
 * @param {Array<{ title: string, snippet: string, link: string, source?: string }>} results
 * @param {string} [domain]
 */
export function filterByDomain(results, domain) {
  const normalized = normalizeDomain(domain);
  if (!normalized || !Array.isArray(results) || results.length === 0) {
    return results;
  }
  const matched = results.filter((item) => {
    try {
      const host = new URL(item.link).hostname.toLowerCase();
      return host === normalized || host.endsWith(`.${normalized}`);
    } catch {
      return false;
    }
  });
  return matched.length > 0 ? matched : results;
}

/**
 * Searches DuckDuckGo HTML version (with automatic Lite fallback on bot challenge) and extracts organic results.
 * @param {string} query - Search query
 * @param {number|object} [optionsOrMax=8] - Maximum number of results or options object
 * @returns {Promise<Array<{ title: string, snippet: string, link: string, source: 'html' | 'lite' }>>}
 */
export async function searchDDG(query, optionsOrMax = {}) {
  const opts = typeof optionsOrMax === 'number' ? { maxResults: optionsOrMax } : (optionsOrMax || {});
  if (!query || typeof query !== 'string' || !query.trim()) {
    throw new DDGSearchError('Search query cannot be empty', 'EMPTY_QUERY');
  }

  const rawMax = Number.isFinite(Number(opts.maxResults)) ? Number(opts.maxResults) : 8;
  const maxResults = Math.min(25, Math.max(1, Math.trunc(rawMax)));
  const domain = opts.domain;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 12000;
  const allowLiteFallback = opts.allowLiteFallback ?? true;

  const builtQuery = buildQuery(query, domain);
  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Content-Type': 'application/x-www-form-urlencoded'
  };

  async function postForm(endpoint) {
    let endpointHeaders = baseHeaders;
    try {
      const origin = new URL(endpoint).origin;
      endpointHeaders = {
        ...baseHeaders,
        Referer: `${origin}/`,
        Origin: origin
      };
    } catch {
      // keep baseHeaders when endpoint is a relative/mock URL
    }
    try {
      return await fetchImpl(endpoint, {
        method: 'POST',
        headers: endpointHeaders,
        body: `q=${encodeURIComponent(builtQuery)}`,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new DDGSearchError(`Timeout searching DuckDuckGo for: "${query}"`, 'TIMEOUT', { endpoint });
      }
      throw err;
    }
  }

  let sawChallenge = false;
  let lastChallengeStatus = 202;
  let lastHttpError = null;
  let lastTimeoutError = null;
  let lastOtherError = null;

  // 1. Primary attempt: DuckDuckGo HTML endpoint
  try {
    const res = await postForm(DDG_HTML_ENDPOINT);
    const html = await res.text();
    if (isChallengeResponse(res.status, html)) {
      sawChallenge = true;
      lastChallengeStatus = res.status;
    } else if (!res.ok) {
      lastHttpError = new DDGSearchError(
        `DuckDuckGo returned status ${res.status} from ${DDG_HTML_ENDPOINT}`,
        'HTTP_ERROR',
        { status: res.status, endpoint: DDG_HTML_ENDPOINT }
      );
    } else {
      const results = parseHtmlResults(html, maxResults);
      if (results.length > 0) {
        return filterByDomain(results, domain);
      }
      if (html.includes('no-results') || html.includes('No results')) {
        return [];
      }
    }
  } catch (err) {
    if (err instanceof DDGSearchError && err.code === 'TIMEOUT') {
      lastTimeoutError = err;
    } else {
      lastOtherError = err;
    }
  }

  // 2. Fallback attempt: DuckDuckGo Lite endpoint
  if (allowLiteFallback) {
    try {
      const res = await postForm(DDG_LITE_ENDPOINT);
      const html = await res.text();
      if (isChallengeResponse(res.status, html)) {
        sawChallenge = true;
        lastChallengeStatus = res.status;
      } else if (!res.ok) {
        lastHttpError = new DDGSearchError(
          `DuckDuckGo returned status ${res.status} from ${DDG_LITE_ENDPOINT}`,
          'HTTP_ERROR',
          { status: res.status, endpoint: DDG_LITE_ENDPOINT }
        );
      } else {
        const results = parseLiteResults(html, maxResults);
        if (results.length > 0) {
          return filterByDomain(results, domain);
        }
        return [];
      }
    } catch (err) {
      if (err instanceof DDGSearchError && err.code === 'TIMEOUT') {
        lastTimeoutError = err;
      } else {
        lastOtherError = err;
      }
    }
  }

  if (sawChallenge) {
    throw new DDGSearchError(
      `DuckDuckGo returned a bot challenge (HTTP ${lastChallengeStatus}) on both html and lite endpoints. Retry in a minute or search interactively with the Chrome DevTools tools.`,
      'CHALLENGE',
      { status: lastChallengeStatus }
    );
  }
  if (lastHttpError) throw lastHttpError;
  if (lastTimeoutError) throw lastTimeoutError;
  if (lastOtherError) throw lastOtherError;

  return [];
}
