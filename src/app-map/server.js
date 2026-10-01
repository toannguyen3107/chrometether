#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AppMapStore } from './store.js';

const store = new AppMapStore();
const server = new Server({ name: 'tether-map', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'start_app_map',
      description: 'Start a new application exploration map. Replaces the previous map in this local profile. Only the target origin and explicitly allowed origins can be recorded.',
      inputSchema: {
        type: 'object',
        properties: {
          target_url: { type: 'string', description: 'Starting HTTP(S) URL of the application' },
          allowed_origins: { type: 'array', items: { type: 'string' }, description: 'Additional API origins explicitly in scope, for example https://api.example.com' }
        },
        required: ['target_url']
      }
    },
    {
      name: 'record_app_page',
      description: 'Record one page actually visited in Chrome. Query parameter names are retained; values and fragments are discarded.',
      inputSchema: {
        type: 'object',
        properties: {
          page_url: { type: 'string' },
          title: { type: ['string', 'null'], description: 'Optional page title; values longer than 200 characters are shortened' }
        },
        required: ['page_url']
      }
    },
    {
      name: 'record_app_requests',
      description: 'Record network requests observed through chrome-devtools list_network_requests while visiting page_url. Pass only URL, method, status, and resourceType; headers and bodies are never stored.',
      inputSchema: {
        type: 'object',
        properties: {
          page_url: { type: 'string' },
          requests: {
            type: 'array',
            maxItems: 200,
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                method: { type: 'string' },
                status: { type: 'number' },
                resourceType: { type: 'string' },
                resource_type: { type: 'string', description: 'Alternative spelling of resourceType' }
              },
              required: ['url']
            }
          }
        },
        required: ['page_url', 'requests']
      }
    },
    {
      name: 'get_app_map',
      description: 'Get the saved application map with visited pages and grouped endpoints. Supports pagination and filtering endpoints by api, navigation, asset, or other.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['api', 'navigation', 'asset', 'other'] },
          page_offset: { type: 'integer', minimum: 0 },
          endpoint_offset: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 100 }
        }
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params;
  try {
    let result;
    switch (name) {
      case 'start_app_map':
        result = store.start(args.target_url, args.allowed_origins);
        break;
      case 'record_app_page':
        result = store.recordPage(args.page_url, args.title);
        break;
      case 'record_app_requests':
        result = store.recordRequests(args.page_url, args.requests);
        break;
      case 'get_app_map':
        {
          const map = store.summary();
          const limit = args.limit ?? 50;
          const pageOffset = args.page_offset ?? 0;
          const endpointOffset = args.endpoint_offset ?? 0;
          if (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
              !Number.isInteger(pageOffset) || pageOffset < 0 ||
              !Number.isInteger(endpointOffset) || endpointOffset < 0 ||
              (args.kind && !['api', 'navigation', 'asset', 'other'].includes(args.kind))) {
            throw new Error('Invalid map pagination or kind filter');
          }
          const endpoints = args.kind ? map.endpoints.filter(item => item.kind === args.kind) : map.endpoints;
          result = {
            ...map,
            filteredEndpointCount: endpoints.length,
            pageOffset,
            endpointOffset,
            pages: map.pages.slice(pageOffset, pageOffset + limit),
            endpoints: endpoints.slice(endpointOffset, endpointOffset + limit)
          };
        }
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    return { isError: true, content: [{ type: 'text', text: error.message || String(error) }] };
  }
});

server.connect(new StdioServerTransport()).catch(error => {
  console.error('Failed to start tether-map:', error);
  process.exitCode = 1;
});
