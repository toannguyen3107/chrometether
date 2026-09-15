import * as cheerio from 'cheerio';
import TurndownService from 'turndown';

const turndownService = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced'
});

// Remove unnecessary image links or format them cleanly
turndownService.addRule('cleanImages', {
  filter: 'img',
  replacement: function (content, node) {
    const alt = node.getAttribute('alt') || '';
    const src = node.getAttribute('src') || '';
    return src ? `![${alt}](${src})` : '';
  }
});

/**
 * Fetches an HTML page and extracts the core content as clean Markdown.
 * @param {string} url - Target URL
 * @returns {Promise<{ url: string, title: string, content: string }>}
 */
export async function fetchMarkdown(url) {
  if (!url || !url.startsWith('http')) {
    throw new Error('Invalid URL. Must begin with http:// or https://');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8'
      }
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract title
    const title = $('title').text().trim() || $('h1').first().text().trim() || url;

    // Remove noise elements
    $('script, style, noscript, iframe, svg, nav, footer, header, aside, form, [role="banner"], [role="navigation"], .ads, .ad, .advertisement').remove();

    // Select primary content area if present
    let contentHtml = '';
    const candidates = ['article', 'main', '[role="main"]', '#content', '.content', '.post-content', '.entry-content', '.markdown-body', 'body'];
    
    for (const selector of candidates) {
      const el = $(selector);
      if (el.length > 0 && el.text().trim().length > 100) {
        contentHtml = el.html();
        break;
      }
    }

    if (!contentHtml) {
      contentHtml = $('body').html() || html;
    }

    let markdown = turndownService.turndown(contentHtml);

    // Clean up excessive blank lines
    markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

    return {
      url,
      title,
      content: markdown
    };
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Timeout fetching URL: ${url} (exceeded 15s)`);
    }
    throw error;
  }
}
