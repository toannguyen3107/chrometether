import * as cheerio from 'cheerio';

/**
 * Searches DuckDuckGo HTML version and extracts organic search results.
 * @param {string} query - Search query
 * @param {number} [maxResults=8] - Maximum number of results to return
 * @returns {Promise<Array<{ title: string, snippet: string, link: string }>>}
 */
export async function searchDDG(query, maxResults = 8) {
  if (!query || !query.trim()) {
    throw new Error('Search query cannot be empty');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query.trim())}`;
    const response = await fetch(url, {
      signal: controller.signal,
      method: 'POST',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: `q=${encodeURIComponent(query.trim())}`
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`DuckDuckGo returned status ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const results = [];

    $('.result').each((_, elem) => {
      if (results.length >= maxResults) return false;

      const titleElem = $(elem).find('.result__title a');
      const snippetElem = $(elem).find('.result__snippet');
      const urlElem = $(elem).find('.result__url');

      const title = titleElem.text().trim();
      let rawHref = titleElem.attr('href') || '';

      // Unpack DuckDuckGo redirect link: /l/?uddg=https%3A%2F%2F...
      let link = '';
      if (rawHref.includes('uddg=')) {
        try {
          const match = rawHref.match(/uddg=([^&]+)/);
          if (match && match[1]) {
            link = decodeURIComponent(match[1]);
          }
        } catch {
          link = rawHref;
        }
      } else if (rawHref.startsWith('http')) {
        link = rawHref;
      } else {
        link = urlElem.text().trim();
        if (link && !link.startsWith('http')) {
          link = 'https://' + link;
        }
      }

      const snippet = snippetElem.text().trim();

      if (title && link) {
        results.push({
          title,
          snippet,
          link
        });
      }
    });

    return results;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error.name === 'AbortError') {
      throw new Error(`Timeout searching DuckDuckGo for: "${query}"`);
    }
    throw error;
  }
}
