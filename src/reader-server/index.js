#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { fetchMarkdown } from './fetch-markdown.js';
import { searchDDG, normalizeDomain } from './search-ddg.js';

export const TOOL_DEFINITIONS = [
  {
    name: 'read_url_content',
    description: 'Fetch a URL over HTTP and return it as Markdown. HTML is cleaned and converted; JSON, XML, Markdown and plain text are returned verbatim (JSON pretty-printed). Relative links are resolved against the final URL. Does not execute JavaScript; use chrome-devtools for SPAs.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The absolute URL of the web page to read (http:// or https://)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'search_web',
    description: 'Search the web with DuckDuckGo. Returns organic results only (ads and tracking redirects removed).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query string',
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 25,
          description: 'Maximum number of results to return (default: 8, max: 25)',
        },
        domain: {
          type: 'string',
          description: 'Optional domain to prioritise, e.g. "developer.mozilla.org". Same meaning as Antigravity search_web: the query is restricted with site: and results from other hosts are dropped when any result matches.',
        },
      },
      required: ['query'],
    },
  },
];

export const server = new Server(
  {
    name: 'tether-reader',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: TOOL_DEFINITIONS,
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'read_url_content') {
      const url = args?.url;
      if (!url) {
        throw new Error('Missing required parameter: url');
      }

      const result = await fetchMarkdown(url);
      const headerLines = [`# ${result.title}`, '', `Source: ${result.url}`];
      if (result.requestedUrl && result.requestedUrl !== result.url) {
        headerLines.push(`Requested: ${result.requestedUrl}`);
      }
      if (result.contentType) {
        headerLines.push(`Type: ${result.contentType}`);
      }
      headerLines.push('', '---', '', result.content);

      return {
        content: [
          {
            type: 'text',
            text: headerLines.join('\n'),
          },
        ],
      };
    }

    if (name === 'search_web') {
      const query = args?.query;
      const maxResults = args?.max_results ? Number(args.max_results) : 8;
      const domain = typeof args?.domain === 'string' ? args.domain : undefined;
      if (!query) {
        throw new Error('Missing required parameter: query');
      }

      const results = await searchDDG(query, { maxResults, domain });
      const normalizedDom = normalizeDomain(domain);
      const domainSuffix = normalizedDom ? ` (domain: ${normalizedDom})` : '';

      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No search results found for query: "${query}"${domainSuffix}`,
            },
          ],
        };
      }

      const formatted = results
        .map(
          (r, idx) =>
            `### ${idx + 1}. [${r.title}](${r.link})\n**URL:** ${r.link}\n${r.snippet}\n`
        )
        .join('\n');

      const sourceLabel = results[0]?.source || 'html';

      return {
        content: [
          {
            type: 'text',
            text: `## Search Results for "${query}"${domainSuffix}\n\n${formatted}\n_Source: DuckDuckGo ${sourceLabel}_`,
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Error executing ${name}: ${error.message || String(error)}`,
        },
      ],
    };
  }
});

export async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('tether-reader MCP server running on stdio');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    console.error('Fatal error running tether-reader MCP server:', error);
    process.exit(1);
  });
}
