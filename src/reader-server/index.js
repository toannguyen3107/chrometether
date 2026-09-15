#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { fetchMarkdown } from './fetch-markdown.js';
import { searchDDG } from './search-ddg.js';

const server = new Server(
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
    tools: [
      {
        name: 'read_url_content',
        description: 'Fetch web content directly via lightweight HTTP GET and convert to clean Markdown. Use this first for reading documentation, static articles, GitHub pages, and blogs without launching Chrome.',
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
        description: 'Search the web using DuckDuckGo to quickly discover relevant web pages, documentation, and URLs.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query string',
            },
            max_results: {
              type: 'number',
              description: 'Maximum number of results to return (default: 8)',
            },
          },
          required: ['query'],
        },
      },
    ],
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
      return {
        content: [
          {
            type: 'text',
            text: `# ${result.title}\n\nSource: ${result.url}\n\n---\n\n${result.content}`,
          },
        ],
      };
    }

    if (name === 'search_web') {
      const query = args?.query;
      const maxResults = args?.max_results ? Number(args.max_results) : 8;
      if (!query) {
        throw new Error('Missing required parameter: query');
      }

      const results = await searchDDG(query, maxResults);
      if (results.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No search results found for query: "${query}"`,
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

      return {
        content: [
          {
            type: 'text',
            text: `## Search Results for "${query}"\n\n${formatted}`,
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

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('agy-reader MCP server running on stdio');
}

run().catch((error) => {
  console.error('Fatal error running agy-reader MCP server:', error);
  process.exit(1);
});
