import nodeFs from 'fs';
import { getAgentPaths } from './paths.js';
import { parseJsonc } from './jsonc.js';

export const TETHER_SERVER_KEYS = ['tether-reader', 'tether-map', 'tether-containers', 'agy-reader'];
export const DEVTOOLS_SERVER_KEYS = ['chrome-devtools', 'chrome_devtools'];

const DSH_ID_MAP = {
  'mcp-tether-reader': 'tether-reader',
  'mcp-tether-map': 'tether-map',
  'mcp-tether-containers': 'tether-containers',
  'mcp-chrome-devtools': 'chrome-devtools'
};

/**
 * Extracts configured MCP server keys from raw configuration file text.
 * Never throws; returns [] on malformed input.
 * @param {string} content
 * @param {string} [format='standard']
 * @returns {string[]}
 */
export function getConfiguredServers(content, format = 'standard') {
  if (!content || typeof content !== 'string') return [];

  try {
    if (format === 'dsh') {
      const found = [];
      const regex = /^\s*-\s*id:\s*(mcp-[\w-]+)/gm;
      let match;
      while ((match = regex.exec(content)) !== null) {
        const rawId = match[1];
        const mapped = DSH_ID_MAP[rawId] || rawId.replace(/^mcp-/, '');
        if (!found.includes(mapped)) found.push(mapped);
      }
      return found;
    }

    if (format === 'opencode') {
      const parsed = parseJsonc(content);
      if (parsed && typeof parsed.mcp === 'object' && !Array.isArray(parsed.mcp)) {
        return Object.keys(parsed.mcp);
      }
      return [];
    }

    if (format === 'zcode') {
      const parsed = JSON.parse(content);
      if (parsed?.mcp?.servers && typeof parsed.mcp.servers === 'object' && !Array.isArray(parsed.mcp.servers)) {
        return Object.keys(parsed.mcp.servers);
      }
      return [];
    }

    const parsed = JSON.parse(content);
    if (parsed?.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) {
      return Object.keys(parsed.mcpServers);
    }
    if (parsed?.mcp?.servers && typeof parsed.mcp.servers === 'object' && !Array.isArray(parsed.mcp.servers)) {
      return Object.keys(parsed.mcp.servers);
    }
    if (parsed?.mcp && typeof parsed.mcp === 'object' && !Array.isArray(parsed.mcp)) {
      return Object.keys(parsed.mcp);
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Evaluates a single agent definition against the filesystem.
 * @param {object} info
 * @param {{ fs?: typeof nodeFs }} [options]
 */
export function evaluateAgent(info, { fs = nodeFs } = {}) {
  const candidateDirs = Array.isArray(info.appDirs) ? info.appDirs : (info.appDir ? [info.appDir] : []);
  const appDirExists = candidateDirs.some((dir) => dir && fs.existsSync(dir));
  const configExists = info.configPath ? fs.existsSync(info.configPath) : false;

  const format = info.format || (info.id === 'dsh' ? 'dsh' : 'standard');
  const serverSet = new Set();

  if (configExists) {
    try {
      const content = fs.readFileSync(info.configPath, 'utf8');
      for (const s of getConfiguredServers(content, format)) {
        serverSet.add(s);
      }
    } catch {
      // ignore read errors
    }
  }

  if (info.pluginMcpConfigPath && fs.existsSync(info.pluginMcpConfigPath)) {
    try {
      const pluginContent = fs.readFileSync(info.pluginMcpConfigPath, 'utf8');
      for (const s of getConfiguredServers(pluginContent, 'standard')) {
        serverSet.add(s);
      }
    } catch {
      // ignore read errors
    }
  }

  const configuredServers = [...serverSet];
  const isConfigured = configuredServers.includes('tether-reader') || configuredServers.includes('agy-reader');
  const isPartiallyConfigured = !isConfigured && configuredServers.length > 0;
  const pluginInstalled = info.pluginManifestPath ? fs.existsSync(info.pluginManifestPath) : undefined;

  return {
    ...info,
    isDetected: appDirExists || configExists,
    configExists,
    isConfigured,
    isPartiallyConfigured,
    configuredServers,
    ...(pluginInstalled !== undefined ? { pluginInstalled } : {})
  };
}

/**
 * Detects which agent environments are present on the local machine.
 * @param {{ paths?: object, fs?: typeof nodeFs }} [options]
 */
export function detectAgents({ paths = getAgentPaths(), fs = nodeFs } = {}) {
  return Object.values(paths).map((info) => evaluateAgent(info, { fs }));
}
