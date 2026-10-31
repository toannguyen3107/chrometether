#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { pathToFileURL } from 'node:url';
import { CONTAINER_COLORS, ContainerVault } from '../cdp-hub/container-vault.js';
import { ensureHubDaemon, hubHttpRequest } from '../cdp-hub/launcher.js';

export const CONTAINER_TOOL_DEFINITIONS = [
  {
    name: 'list_containers',
    description:
      'List all Firefox-style Multi-Account Container profiles in deterministic order, including their mapped chrome-devtools isolatedContext ID (isolated-context-N), color badge, cookie count, and active tabs.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'create_container',
    description:
      'Create or ensure a named persistent Multi-Account Container (e.g., "acc-1", "acc-2") and reserve it in the ChromeTether Hub so the next new_page(isolatedContext) call binds to this container.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Container name (e.g., "acc-1", "acc-2", "work", "personal")'
        },
        color: {
          type: 'string',
          enum: CONTAINER_COLORS,
          description: 'Optional Chrome Tab Group color badge'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'open_container_page',
    description:
      'Open a new isolated Container Tab in the SAME Chrome window with visual Tab Group badge, isolated Cookie jar (DNR tabIds) and isolated localStorage/sessionStorage, then navigate to url.',
    inputSchema: {
      type: 'object',
      properties: {
        container: {
          type: 'string',
          description: 'Container name (e.g., "acc-1", "acc-2")'
        },
        url: {
          type: 'string',
          description: 'Target URL to open inside the container tab'
        },
        color: {
          type: 'string',
          enum: CONTAINER_COLORS,
          description: 'Optional Chrome Tab Group color'
        },
        background: {
          type: 'boolean',
          description: 'Whether to open the tab in the background without stealing focus'
        }
      },
      required: ['container', 'url']
    }
  },
  {
    name: 'clear_container',
    description:
      'Clear all stored cookies, localStorage, sessionStorage, and active DNR session rules for a named container.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Container name to clear'
        }
      },
      required: ['name']
    }
  },
  {
    name: 'delete_container',
    description:
      'Delete a named container from the vault, close its Chrome Tab Group / container tabs, and sync deletion between the Extension and CDP Hub.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Container name to delete'
        },
        closeTabs: {
          type: 'boolean',
          description: 'Whether to close active tabs belonging to this container (default: true)'
        }
      },
      required: ['name']
    }
  }
];

export async function handleContainerToolCall(name, args = {}) {
  switch (name) {
    case 'list_containers': {
      try {
        await ensureHubDaemon({ waitTimeoutMs: 2000 });
        const res = await hubHttpRequest('/containers', { method: 'GET' });
        if (res.statusCode === 200 && res.data?.ok) {
          return res.data;
        }
      } catch {
        // Fallback to direct vault read
      }
      const vault = new ContainerVault();
      return { ok: true, containers: vault.listContainers(), pendingReservations: [] };
    }

    case 'create_container': {
      if (!args.name) throw new Error('Container name is required');
      try {
        await ensureHubDaemon({ waitTimeoutMs: 2000 });
        const res = await hubHttpRequest('/containers', {
          method: 'POST',
          body: { name: args.name, color: args.color, reserveNextContext: true }
        });
        if (res.statusCode === 200 && res.data?.ok) {
          return res.data;
        }
      } catch {
        // Fallback to direct vault write
      }
      const vault = new ContainerVault();
      const entry = vault.ensureContainer(args.name, { color: args.color });
      const info = vault.listContainers().find(c => c.name === entry.name) || entry;
      return { ok: true, container: info };
    }

    case 'open_container_page': {
      const containerName = args.container || args.name;
      if (!containerName) throw new Error('container is required');
      if (!args.url) throw new Error('url is required');

      await ensureHubDaemon({ waitTimeoutMs: 3000 });
      const res = await hubHttpRequest('/containers/open-tab', {
        method: 'POST',
        body: {
          container: containerName,
          url: args.url,
          color: args.color,
          background: Boolean(args.background)
        }
      });
      if (res.statusCode === 200 && res.data?.ok) {
        return res.data;
      }
      throw new Error(res.data?.error || 'Failed to open container tab via Hub');
    }

    case 'clear_container': {
      const containerName = args.name || args.container;
      if (!containerName) throw new Error('Container name is required');
      if (args.deleteContainer) {
        return handleContainerToolCall('delete_container', {
          name: containerName,
          closeTabs: args.closeTabs !== false
        });
      }
      try {
        await ensureHubDaemon({ waitTimeoutMs: 2000 });
        const res = await hubHttpRequest('/containers/clear', {
          method: 'POST',
          body: { name: containerName, deleteContainer: Boolean(args.deleteContainer) }
        });
        if (res.statusCode === 200 && res.data?.ok) {
          return res.data;
        }
      } catch {
        // Fallback to direct vault clear
      }
      const vault = new ContainerVault();
      const cleared = vault.clearContainer(containerName);
      return { ok: true, cleared };
    }

    case 'delete_container': {
      const containerName = args.name || args.container;
      if (!containerName) throw new Error('Container name is required');
      try {
        await ensureHubDaemon({ waitTimeoutMs: 2000 });
        const res = await hubHttpRequest('/containers/delete', {
          method: 'POST',
          body: {
            name: containerName,
            closeTabs: args.closeTabs !== false
          }
        });
        if (res.statusCode === 200 && res.data?.ok) {
          return res.data;
        }
      } catch {
        // Fallback to direct vault delete
      }
      const vault = new ContainerVault();
      const deleted = vault.deleteContainer(containerName);
      return { ok: true, deleted };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function createContainersMcpServer() {
  const server = new Server(
    { name: 'tether-containers', version: '2.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: CONTAINER_TOOL_DEFINITIONS
  }));

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params;
    try {
      const result = await handleContainerToolCall(name, args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error.message || String(error) }]
      };
    }
  });

  return server;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const server = createContainersMcpServer();
  server.connect(new StdioServerTransport()).catch(error => {
    console.error('Failed to start tether-containers:', error);
    process.exitCode = 1;
  });
}
