import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, mock } from 'node:test';
import {
  searchDDG,
  DDGSearchError,
  DDG_HTML_ENDPOINT,
  DDG_LITE_ENDPOINT,
  normalizeDomain,
  buildQuery,
  isTrackingLink,
  unpackDDGLink,
  stripTrackingParams,
  isChallengeResponse,
  parseHtmlResults,
  parseLiteResults,
  filterByDomain
} from '../src/reader-server/search-ddg.js';
import { makeFetch } from './helpers/mock-fetch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures', 'ddg');

const htmlResults = fs.readFileSync(path.join(fixturesDir, 'html-results.html'), 'utf8');
const htmlChallenge = fs.readFileSync(path.join(fixturesDir, 'html-challenge.html'), 'utf8');
const liteResults = fs.readFileSync(path.join(fixturesDir, 'lite-results.html'), 'utf8');
const htmlUddg = fs.readFileSync(path.join(fixturesDir, 'html-uddg.html'), 'utf8');

test('parseHtmlResults filters ads and tracking links', () => {
  const results = parseHtmlResults(htmlResults, 10);
  assert.equal(results.length, 3);
  for (const item of results) {
    assert.ok(!item.link.includes('duckduckgo.com/y.js'), `Ad link leaked: ${item.link}`);
    assert.ok(!item.link.includes('bing.com/aclick'), `Bing ad leaked: ${item.link}`);
    assert.equal(item.source, 'html');
  }
  assert.equal(results[0].link, 'https://nodejs.org/en');
});

test('maxResults counts organic results only after filtering ads', () => {
  const results = parseHtmlResults(htmlResults, 3);
  assert.equal(results.length, 3);
  assert.ok(results.every(r => !r.link.includes('y.js')));
});

test('unpackDDGLink unpacks protocol-relative uddg redirect and drops rut', () => {
  const unpacked = unpackDDGLink('//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fp%3Fa%3D1&rut=abc');
  assert.equal(unpacked, 'https://example.org/p?a=1');
});

test('parseHtmlResults unpacks uddg fixture and strips utm tracking params', () => {
  const results = parseHtmlResults(htmlUddg, 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].link, 'https://example.org/p?a=1');
  assert.equal(results[0].title, 'Example');
  assert.equal(results[0].snippet, 'Snippet text');
});

test('unpackDDGLink rejects non-http protocols and empty input', () => {
  assert.equal(unpackDDGLink('javascript:void(0)'), '');
  assert.equal(unpackDDGLink('mailto:x@y.com'), '');
  assert.equal(unpackDDGLink(''), '');
});

test('stripTrackingParams removes utm_* and fbclid while keeping other params and hash', () => {
  assert.equal(
    stripTrackingParams('https://e.org/a?utm_source=x&id=2&fbclid=z#h'),
    'https://e.org/a?id=2#h'
  );
});

test('isTrackingLink identifies y.js, bing aclick, and invalid URLs', () => {
  assert.equal(isTrackingLink('https://duckduckgo.com/y.js?ad_domain=interserver.net'), true);
  assert.equal(isTrackingLink('https://www.bing.com/aclick?ld=123'), true);
  assert.equal(isTrackingLink('https://nodejs.org/'), false);
  assert.equal(isTrackingLink('not a url'), true);
});

test('isChallengeResponse detects HTTP 202 and anomaly-modal markup', () => {
  assert.equal(isChallengeResponse(202, '<html></html>'), true);
  assert.equal(isChallengeResponse(200, htmlChallenge), true);
  assert.equal(isChallengeResponse(200, htmlResults), false);
});

test('searchDDG falls back to Lite endpoint on HTTP 202 challenge', async () => {
  const fetchImpl = makeFetch([
    { status: 202, body: htmlChallenge },
    { status: 200, body: liteResults }
  ]);
  const results = await searchDDG('node.js website', { fetchImpl });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(fetchImpl.calls[0].url, DDG_HTML_ENDPOINT);
  assert.equal(fetchImpl.calls[1].url, DDG_LITE_ENDPOINT);
  assert.ok(results.length > 0);
  assert.ok(results.every(r => r.source === 'lite'));
  assert.ok(results.every(r => !r.link.includes('y.js')));
});

test('parseLiteResults skips sponsored rows and more info links', () => {
  const results = parseLiteResults(liteResults, 10);
  assert.equal(results.length, 2);
  assert.ok(results.every(r => r.title.toLowerCase() !== 'more info'));
  assert.ok(results.every(r => !r.link.includes('y.js')));
  assert.equal(results[0].link, 'https://nodejs.org/');
  assert.ok(results[0].snippet.includes('open-source'));
});

test('searchDDG throws CHALLENGE error when both HTML and Lite endpoints challenge', async () => {
  const fetchImpl = makeFetch([
    { status: 202, body: htmlChallenge },
    { status: 202, body: htmlChallenge }
  ]);
  await assert.rejects(
    () => searchDDG('nodejs', { fetchImpl }),
    (err) => {
      assert.ok(err instanceof DDGSearchError);
      assert.equal(err.code, 'CHALLENGE');
      assert.match(err.message, /Chrome/);
      return true;
    }
  );
});

test('searchDDG tries Lite endpoint even when HTML endpoint times out', async () => {
  const fetchImpl = makeFetch([
    { reject: new DOMException('Timed out', 'TimeoutError') },
    { status: 200, body: liteResults }
  ]);
  const results = await searchDDG('nodejs', { fetchImpl });
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(results.length, 2);
  assert.equal(results[0].source, 'lite');
});

test('searchDDG surfaces HTTP_ERROR when both endpoints fail with 5xx', async () => {
  const fetchImpl = makeFetch([
    { status: 500, body: 'Server Error' },
    { status: 503, body: 'Service Unavailable' }
  ]);
  await assert.rejects(
    () => searchDDG('nodejs', { fetchImpl }),
    (err) => {
      assert.equal(err.code, 'HTTP_ERROR');
      assert.equal(err.status, 503);
      return true;
    }
  );
});

test('domain option builds site: query without duplicating existing site:', async () => {
  const fetchImpl = makeFetch([{ status: 200, body: htmlResults }]);
  await searchDDG('fetch api', { domain: 'https://developer.mozilla.org/en-US/', fetchImpl });
  assert.match(fetchImpl.calls[0].init.body, /site%3Adeveloper\.mozilla\.org/);
  assert.equal(buildQuery('x site:a.com', 'b.com'), 'x site:a.com');
});

test('domain option filters results to matching hostnames', async () => {
  const fetchImpl = makeFetch([{ status: 200, body: htmlResults }]);
  const results = await searchDDG('nodejs', { domain: 'nodejs.org', fetchImpl });
  assert.equal(results.length, 2);
  for (const r of results) {
    const host = new URL(r.link).hostname;
    assert.ok(host === 'nodejs.org' || host.endsWith('.nodejs.org'));
  }
});

test('filterByDomain falls back to unfiltered results when nothing matches', () => {
  const parsed = parseHtmlResults(htmlResults, 10);
  const filtered = filterByDomain(parsed, 'example.invalid');
  assert.equal(filtered.length, parsed.length);
});

test('normalizeDomain handles URLs, www prefixes, and invalid strings', () => {
  assert.equal(normalizeDomain('WWW.Example.com/path'), 'example.com');
  assert.equal(normalizeDomain('not a domain'), undefined);
  assert.equal(normalizeDomain('https://sub.a.org'), 'sub.a.org');
});

test('positional maxResults argument remains backward-compatible', async () => {
  const fetchImpl = makeFetch([{ status: 200, body: htmlResults }]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = mock.fn(fetchImpl);
  try {
    const results = await searchDDG('nodejs', 2);
    assert.equal(results.length, 2);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('empty query rejects with EMPTY_QUERY code', async () => {
  await assert.rejects(
    () => searchDDG('   '),
    (err) => err.code === 'EMPTY_QUERY'
  );
});
