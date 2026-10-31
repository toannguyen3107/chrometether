import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

function createTurndownService() {
  const service = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced'
  });

  service.remove(['button', 'input', 'select', 'textarea']);

  service.addRule('cleanImages', {
    filter: 'img',
    replacement: function (content, node) {
      const alt = node.getAttribute('alt') || '';
      const src = node.getAttribute('src') || '';
      return src ? `![${alt}](${src})` : '';
    }
  });

  service.addRule('dropEmptyLinks', {
    filter: function (node) {
      if (node.nodeName !== 'A') return false;
      const text = (node.textContent || '').trim();
      const hasImg = node.querySelector && node.querySelector('img');
      return !text && !hasImg;
    },
    replacement: function () {
      return '';
    }
  });

  return service;
}

const turndownService = createTurndownService();

const CONTENT_CONTAINERS = 'article, main, [role="main"], .post, .entry-content, .post-content, .markdown-body';
const CONTENT_CANDIDATES = [
  'article',
  'main',
  '[role="main"]',
  '.markdown-body',
  '.post-content',
  '.entry-content',
  '#content',
  '.content',
  'body'
];

/**
 * Removes non-content noise while preserving article headers, callout asides, and content inside form wrappers.
 * @param {cheerio.CheerioAPI} $
 */
export function pruneNoise($) {
  $(
    'script, style, noscript, iframe, svg, canvas, template, [hidden], .ads, .ad, .advertisement, .cookie-banner, #cookie-banner'
  ).remove();

  $('nav, footer, [role="banner"], [role="navigation"], [role="contentinfo"]').remove();

  $('header').each((_, el) => {
    const $el = $(el);
    const inContent = $el.closest(CONTENT_CONTAINERS).length > 0;
    const looksLikeChrome = $el.parent().is('body') || $el.find('nav, [role="navigation"]').length > 0;
    if (!inContent && looksLikeChrome) {
      $el.remove();
    }
  });

  $('aside').each((_, el) => {
    const $el = $(el);
    const inContent = $el.closest('article, main, [role="main"]').length > 0;
    if (!inContent) {
      $el.remove();
    }
  });

  $('form').each((_, el) => {
    const $form = $(el);
    $form.find('input, button, select, textarea, [type="submit"]').remove();
    $form.replaceWith($form.html() || '');
  });
}

function shouldSkipUrlResolution(val) {
  if (!val || typeof val !== 'string') return true;
  const trimmed = val.trim();
  return (
    !trimmed ||
    trimmed.startsWith('#') ||
    /^(mailto:|tel:|javascript:|data:|blob:)/i.test(trimmed)
  );
}

/**
 * Resolves relative href, src, data-src, and srcset attributes against the document base URL.
 * @param {cheerio.CheerioAPI} $
 * @param {string} baseUrl
 */
export function resolveDocumentUrls($, baseUrl) {
  let effectiveBase = baseUrl;
  const baseHref = $('base[href]').first().attr('href');
  if (baseHref) {
    try {
      effectiveBase = new URL(baseHref, baseUrl).href;
    } catch {
      effectiveBase = baseUrl;
    }
  }

  $('img[data-src]').each((_, el) => {
    const $el = $(el);
    if (!$el.attr('src')) {
      $el.attr('src', $el.attr('data-src'));
    }
  });

  const attrPairs = [
    ['a[href]', 'href'],
    ['img[src]', 'src'],
    ['source[src]', 'src'],
    ['video[src]', 'src'],
    ['audio[src]', 'src']
  ];

  for (const [selector, attrName] of attrPairs) {
    $(selector).each((_, el) => {
      const $el = $(el);
      const val = $el.attr(attrName);
      if (shouldSkipUrlResolution(val)) return;
      try {
        $el.attr(attrName, new URL(val.trim(), effectiveBase).href);
      } catch {
        // leave unchanged on invalid URL
      }
    });
  }

  $('img[srcset], source[srcset]').each((_, el) => {
    const $el = $(el);
    const rawSrcset = $el.attr('srcset');
    if (!rawSrcset) return;
    const resolvedParts = rawSrcset
      .split(',')
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return '';
        const tokens = trimmed.split(/\s+/);
        const urlToken = tokens[0];
        const descriptor = tokens.slice(1).join(' ');
        if (shouldSkipUrlResolution(urlToken)) return trimmed;
        try {
          const resolvedUrl = new URL(urlToken, effectiveBase).href;
          return descriptor ? `${resolvedUrl} ${descriptor}` : resolvedUrl;
        } catch {
          return trimmed;
        }
      })
      .filter(Boolean);
    if (resolvedParts.length > 0) {
      $el.attr('srcset', resolvedParts.join(', '));
    }
  });
}

/**
 * Selects the primary content element from a Cheerio document, picking the largest match per candidate selector.
 * @param {cheerio.CheerioAPI} $
 */
export function selectContentRoot($) {
  for (const selector of CONTENT_CANDIDATES) {
    const matches = $(selector).toArray();
    if (matches.length === 0) continue;

    let bestEl = null;
    let bestLen = -1;
    for (const el of matches) {
      const len = $(el).text().trim().length;
      if (len > bestLen) {
        bestLen = len;
        bestEl = el;
      }
    }
    if (bestEl && bestLen > 100) {
      return bestEl;
    }
  }
  return $('body')[0] || $.root()[0];
}

/**
 * Converts an HTML document string into clean Markdown with resolved links.
 * @param {string} html
 * @param {string} baseUrl
 * @returns {{ title: string, content: string }}
 */
export function htmlToMarkdown(html, baseUrl) {
  const $ = cheerio.load(html || '');
  const title =
    $('title').first().text().trim() ||
    $('h1').first().text().trim() ||
    baseUrl;

  pruneNoise($);
  resolveDocumentUrls($, baseUrl);
  const root = selectContentRoot($);
  const contentHtml = root ? $.html(root) : ($.html() || '');
  let markdown = turndownService.turndown(contentHtml);
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

  return { title, content: markdown };
}

/**
 * Detects the content kind from the HTTP Content-Type header, body sample, and URL.
 * @param {string} [contentTypeHeader='']
 * @param {string} [bodySample='']
 * @param {string} [url='']
 * @returns {'html' | 'json' | 'markdown' | 'text' | 'xml' | 'binary'}
 */
export function detectContentKind(contentTypeHeader = '', bodySample = '', url = '') {
  const mediaType = String(contentTypeHeader || '').split(';')[0].trim().toLowerCase();

  if (mediaType) {
    if (mediaType === 'text/html' || mediaType === 'application/xhtml+xml') {
      return 'html';
    }
    if (
      mediaType === 'application/json' ||
      mediaType === 'text/json' ||
      mediaType.endsWith('+json')
    ) {
      return 'json';
    }
    if (mediaType === 'text/markdown' || mediaType === 'text/x-markdown') {
      return 'markdown';
    }
    if (mediaType === 'text/plain') {
      try {
        const pathname = new URL(url).pathname.toLowerCase();
        if (pathname.endsWith('.md') || pathname.endsWith('.markdown')) {
          return 'markdown';
        }
      } catch {
        // ignore
      }
      return 'text';
    }
    if (
      mediaType === 'application/xml' ||
      mediaType === 'text/xml' ||
      mediaType === 'application/rss+xml' ||
      mediaType === 'application/atom+xml' ||
      mediaType.endsWith('+xml')
    ) {
      return 'xml';
    }
    if (
      mediaType === 'application/pdf' ||
      mediaType === 'application/octet-stream' ||
      mediaType === 'application/zip' ||
      mediaType === 'application/wasm' ||
      mediaType.startsWith('image/') ||
      mediaType.startsWith('audio/') ||
      mediaType.startsWith('video/') ||
      mediaType.startsWith('font/')
    ) {
      return 'binary';
    }
  }

  const sample = String(bodySample || '').slice(0, 512);
  if (/^\s*[\[{]/.test(sample)) return 'json';
  if (/^\s*<(!doctype|html)/i.test(sample)) return 'html';
  if (/^\s*<\?xml/i.test(sample)) return 'xml';
  if (!mediaType && sample.includes('<')) return 'html';
  return 'text';
}

function titleFromUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : parsed.hostname;
  } catch {
    return urlStr;
  }
}

/**
 * Formats non-HTML content (JSON, Markdown, plain text, XML) without running Turndown.
 * @param {'json' | 'markdown' | 'text' | 'xml'} kind
 * @param {string} text
 * @param {string} url
 * @returns {{ title: string, content: string }}
 */
export function formatNonHtml(kind, text, url) {
  const title = titleFromUrl(url);
  if (kind === 'json') {
    try {
      const formatted = JSON.stringify(JSON.parse(text), null, 2);
      return { title, content: `\`\`\`json\n${formatted}\n\`\`\`` };
    } catch {
      return { title, content: `\`\`\`json\n${String(text).trim()}\n\`\`\`` };
    }
  }
  if (kind === 'xml') {
    return { title, content: `\`\`\`xml\n${String(text).trim()}\n\`\`\`` };
  }
  return { title, content: String(text) };
}

/**
 * Fetches a web resource over HTTP(S) and converts HTML to Markdown or formats JSON/XML/text verbatim.
 * @param {string} url - Target HTTP(S) URL
 * @param {object} [options]
 * @returns {Promise<{ url: string, requestedUrl: string, title: string, content: string, contentType: string, truncated: boolean }>}
 */
export async function fetchMarkdown(url, { fetchImpl = globalThis.fetch, timeoutMs = 15000, maxChars = 200_000 } = {}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error('Invalid URL. Must begin with http:// or https://');
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Invalid URL. Must begin with http:// or https://');
  }

  try {
    const response = await fetchImpl(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/markdown;q=0.8,text/plain;q=0.8,*/*;q=0.5',
        'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8'
      }
    });

    const finalUrl = response.url || url;

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${response.statusText} for ${finalUrl}`);
    }

    const contentTypeHeader = response.headers.get('content-type') || '';
    const mediaType = contentTypeHeader.split(';')[0].trim();

    if (mediaType && detectContentKind(contentTypeHeader, '', finalUrl) === 'binary') {
      throw new Error(
        `Unsupported content-type "${mediaType}" for ${finalUrl}. read_url_content handles HTML, JSON, XML, Markdown and plain text; open the URL in Chrome or download it instead.`
      );
    }

    let text;
    const charsetMatch = contentTypeHeader.match(/charset=([^\s;]+)/i);
    const charset = charsetMatch ? charsetMatch[1].replace(/^["']|["']$/g, '').toLowerCase() : 'utf-8';
    if (charset && charset !== 'utf-8' && charset !== 'utf8') {
      try {
        const buffer = await response.arrayBuffer();
        text = new TextDecoder(charset).decode(buffer);
      } catch {
        text = await response.text();
      }
    } else {
      text = await response.text();
    }

    const kind = detectContentKind(contentTypeHeader, text.slice(0, 512), finalUrl);
    const { title, content: rawContent } =
      kind === 'html' ? htmlToMarkdown(text, finalUrl) : formatNonHtml(kind, text, finalUrl);

    let content = rawContent;
    let truncated = false;
    if (typeof maxChars === 'number' && maxChars > 0 && content.length > maxChars) {
      const total = content.length;
      content = `${content.slice(0, maxChars)}\n\n[Content truncated at ${maxChars} characters; ${total} total]`;
      truncated = true;
    }

    return {
      url: finalUrl,
      requestedUrl: url,
      title,
      content,
      contentType: kind,
      truncated
    };
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw new Error(`Timeout fetching URL: ${url} (exceeded ${Math.round(timeoutMs / 1000)}s)`);
    }
    throw error;
  }
}
