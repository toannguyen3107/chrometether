import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import * as cheerio from 'cheerio';
import {
  fetchMarkdown,
  resolveDocumentUrls
} from '../src/reader-server/fetch-markdown.js';
import { makeFetch } from './helpers/mock-fetch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pagesDir = path.join(__dirname, 'fixtures', 'pages');

const articleHeaderFormHtml = fs.readFileSync(path.join(pagesDir, 'article-header-form.html'), 'utf8');
const relativeLinksHtml = fs.readFileSync(path.join(pagesDir, 'relative-links.html'), 'utf8');
const baseHrefHtml = fs.readFileSync(path.join(pagesDir, 'base-href.html'), 'utf8');
const multiContentHtml = fs.readFileSync(path.join(pagesDir, 'multi-content.html'), 'utf8');

test('preserves article header, unwraps forms, keeps article aside, drops site chrome', async () => {
  const fetchImpl = makeFetch([
    { status: 200, headers: { 'content-type': 'text/html' }, body: articleHeaderFormHtml }
  ]);
  const res = await fetchMarkdown('https://example.com/blog/post', { fetchImpl });
  assert.match(res.content, /# Post Heading Inside Article Header/);
  assert.match(res.content, /2026-10-31/);
  assert.match(res.content, /## Install Instructions/);
  assert.match(res.content, /Note: keep this important callout inside article/);
  assert.doesNotMatch(res.content, /Site Top Navigation Menu/);
  assert.doesNotMatch(res.content, /Global Sidebar Content/);
  assert.doesNotMatch(res.content, /<input/);
});

test('resolves relative links and images against final redirected URL', async () => {
  const fetchImpl = makeFetch([
    {
      status: 200,
      url: 'https://docs.example.com/guide/intro/',
      headers: { 'content-type': 'text/html' },
      body: relativeLinksHtml
    }
  ]);
  const res = await fetchMarkdown('http://docs.example.com/guide/intro', { fetchImpl });
  assert.equal(res.url, 'https://docs.example.com/guide/intro/');
  assert.equal(res.requestedUrl, 'http://docs.example.com/guide/intro');
  assert.match(res.content, /\(https:\/\/docs\.example\.com\/guide\/api\)/);
  assert.match(res.content, /\(https:\/\/docs\.example\.com\/getting-started\)/);
  assert.match(res.content, /\(https:\/\/docs\.example\.com\/img\/a\.png\)/);
  assert.match(res.content, /\(https:\/\/docs\.example\.com\/guide\/intro\/assets\/lazy\.png\)/);
  assert.match(res.content, /\(#top\)/);
  assert.match(res.content, /\(mailto:support@example\.com\)/);
});

test('honours <base href> when resolving document URLs', async () => {
  const fetchImpl = makeFetch([
    { status: 200, headers: { 'content-type': 'text/html' }, body: baseHrefHtml }
  ]);
  const res = await fetchMarkdown('https://example.com/page', { fetchImpl });
  assert.match(res.content, /https:\/\/cdn\.example\.com\/x\/p\.png/);
  assert.match(res.content, /https:\/\/cdn\.example\.com\/x\/sub\/doc\.html/);
});

test('resolveDocumentUrls resolves srcset candidates cleanly', () => {
  const $ = cheerio.load('<img src="a.png" srcset="a.png 1x, b.png 2x">');
  resolveDocumentUrls($, 'https://h/dir/');
  assert.equal($('img').attr('srcset'), 'https://h/dir/a.png 1x, https://h/dir/b.png 2x');
});

test('formats JSON content-type into pretty-printed fenced json block', async () => {
  const fetchImpl = makeFetch([
    { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"a":[1,2]}' }
  ]);
  const res = await fetchMarkdown('https://api.example.com/v1/items', { fetchImpl });
  assert.equal(res.contentType, 'json');
  assert.ok(res.content.startsWith('```json\n'));
  assert.match(res.content, /"a": \[/);
});

test('sniffs JSON when content-type header is missing', async () => {
  const fetchImpl = makeFetch([
    { status: 200, headers: {}, body: '[1, 2, 3]' }
  ]);
  const res = await fetchMarkdown('https://api.example.com/data', { fetchImpl });
  assert.equal(res.contentType, 'json');
  assert.ok(res.content.startsWith('```json'));
});

test('returns plain text and markdown verbatim without turndown escaping', async () => {
  const fetchImpl = makeFetch([
    { status: 200, headers: { 'content-type': 'text/plain' }, body: 'hello\nworld' },
    { status: 200, headers: { 'content-type': 'text/markdown' }, body: '# T\n*x*' },
    { status: 200, headers: { 'content-type': 'text/plain' }, body: '# T\n*x*' }
  ]);

  const plainRes = await fetchMarkdown('https://example.com/notes.txt', { fetchImpl });
  assert.equal(plainRes.contentType, 'text');
  assert.equal(plainRes.content, 'hello\nworld');

  const mdRes = await fetchMarkdown('https://example.com/doc', { fetchImpl });
  assert.equal(mdRes.contentType, 'markdown');
  assert.equal(mdRes.content, '# T\n*x*');

  const rawGhRes = await fetchMarkdown('https://raw.githubusercontent.com/o/r/README.md', { fetchImpl });
  assert.equal(rawGhRes.contentType, 'markdown');
  assert.equal(rawGhRes.content, '# T\n*x*');
});

test('fences XML responses as xml code blocks', async () => {
  const fetchImpl = makeFetch([
    { status: 200, headers: { 'content-type': 'application/rss+xml' }, body: '<rss><channel></channel></rss>' }
  ]);
  const res = await fetchMarkdown('https://example.com/feed.xml', { fetchImpl });
  assert.equal(res.contentType, 'xml');
  assert.ok(res.content.startsWith('```xml\n'));
});

test('rejects binary content-type before reading response body stream', async () => {
  let pullCalled = false;
  const stream = new ReadableStream(
    {
      pull() {
        pullCalled = true;
        throw new Error('Body stream should not be read for binary content-type');
      }
    },
    { highWaterMark: 0 }
  );
  const fetchImpl = async (url) => {
    const res = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/pdf' }
    });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  };
  await assert.rejects(
    () => fetchMarkdown('https://example.com/manual.pdf', { fetchImpl }),
    /Unsupported content-type/
  );
  assert.equal(pullCalled, false);
});

test('truncates oversized content and appends notice', async () => {
  const bigBody = `<html><body><article><p>${'a'.repeat(5000)}</p></article></body></html>`;
  const fetchImpl = makeFetch([
    { status: 200, headers: { 'content-type': 'text/html' }, body: bigBody }
  ]);
  const res = await fetchMarkdown('https://example.com/big', { fetchImpl, maxChars: 1000 });
  assert.equal(res.truncated, true);
  assert.ok(res.content.length < 1200);
  assert.match(res.content, /\[Content truncated at 1000 characters/);
});

test('validates URL protocol strictly and surfaces HTTP and timeout errors', async () => {
  await assert.rejects(() => fetchMarkdown('httpx://foo'), /Invalid URL/);
  await assert.rejects(() => fetchMarkdown('ftp://example.com/file'), /Invalid URL/);
  await assert.rejects(() => fetchMarkdown('not a url'), /Invalid URL/);

  const fetch404 = makeFetch([{ status: 404, statusText: 'Not Found' }]);
  await assert.rejects(() => fetchMarkdown('https://example.com/missing', { fetchImpl: fetch404 }), /HTTP Error 404/);

  const fetchTimeout = makeFetch([{ reject: new DOMException('Timed out', 'TimeoutError') }]);
  await assert.rejects(
    () => fetchMarkdown('https://example.com/slow', { fetchImpl: fetchTimeout, timeoutMs: 5000 }),
    /Timeout fetching URL/
  );
});

test('selectContentRoot picks largest matching element when multiple candidates exist', async () => {
  const fetchImpl = makeFetch([
    { status: 200, headers: { 'content-type': 'text/html' }, body: multiContentHtml }
  ]);
  const res = await fetchMarkdown('https://example.com/multi', { fetchImpl });
  assert.match(res.content, /# Primary Long Content Block/);
});
