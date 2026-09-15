import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_DIR = path.resolve(__dirname, '..', '..');

/**
 * Returns standard MCP server definitions for ChromeTether.
 * @param {string} projectDir - Absolute path to project root
 * @returns {object}
 */
export function getBrowserMcpConfigs(projectDir = DEFAULT_PROJECT_DIR) {
  const normalizedProjectDir = path.resolve(projectDir);
  const readerScript = path.join(normalizedProjectDir, 'src', 'reader-server', 'index.js');
  const chromeDevToolsScript = path.join(
    normalizedProjectDir,
    'node_modules',
    'chrome-devtools-mcp',
    'build',
    'src',
    'bin',
    'chrome-devtools-mcp.js'
  );

  return {
    'chrome-devtools': {
      command: 'node',
      args: [
        chromeDevToolsScript,
        '--auto-connect'
      ]
    },
    'tether-reader': {
      command: 'node',
      args: [
        readerScript
      ]
    }
  };
}

/**
 * Returns OpenCode-formatted MCP server definitions.
 * @param {string} projectDir
 * @returns {object}
 */
export function getOpenCodeMcpConfigs(projectDir = DEFAULT_PROJECT_DIR) {
  const normalizedProjectDir = path.resolve(projectDir);
  const readerScript = path.join(normalizedProjectDir, 'src', 'reader-server', 'index.js');
  const chromeDevToolsScript = path.join(
    normalizedProjectDir,
    'node_modules',
    'chrome-devtools-mcp',
    'build',
    'src',
    'bin',
    'chrome-devtools-mcp.js'
  );

  return {
    'chrome-devtools': {
      type: 'local',
      command: [
        'node',
        chromeDevToolsScript,
        '--auto-connect'
      ],
      enabled: true
    },
    'tether-reader': {
      type: 'local',
      command: [
        'node',
        readerScript
      ],
      enabled: true
    }
  };
}

/**
 * Returns ZCode-formatted MCP server definitions.
 * @param {string} projectDir
 * @returns {object}
 */
export function getZCodeMcpConfigs(projectDir = DEFAULT_PROJECT_DIR) {
  const normalizedProjectDir = path.resolve(projectDir);
  const readerScript = path.join(normalizedProjectDir, 'src', 'reader-server', 'index.js');
  const chromeDevToolsScript = path.join(
    normalizedProjectDir,
    'node_modules',
    'chrome-devtools-mcp',
    'build',
    'src',
    'bin',
    'chrome-devtools-mcp.js'
  );

  return {
    'chrome-devtools': {
      type: 'stdio',
      command: 'node',
      args: [
        chromeDevToolsScript,
        '--auto-connect'
      ]
    },
    'tether-reader': {
      type: 'stdio',
      command: 'node',
      args: [
        readerScript
      ]
    }
  };
}

/**
 * Safely merges new MCP servers into an existing agent config file.
 * Creates an automatic backup (.bak) before modifying.
 * @param {string} configFilePath - Path to agent's config json
 * @param {object} serversToMerge - Object containing server definitions
 * @param {string|boolean} [format='standard'] - Format identifier ('standard', 'opencode', 'zcode')
 * @returns {{ success: boolean, backupFile?: string, filePath: string, error?: string }}
 */
export function mergeMcpConfig(configFilePath, serversToMerge, format = 'standard') {
  try {
    const dir = path.dirname(configFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const isZCode = format === 'zcode' || configFilePath.toLowerCase().includes('.zcode');
    const isOpenCode = format === 'opencode' || format === true || configFilePath.toLowerCase().includes('opencode');

    let currentConfig = {};
    if (isZCode) {
      currentConfig = { mcp: { servers: {} } };
    } else if (isOpenCode) {
      currentConfig = { "$schema": "https://opencode.ai/config.json", mcp: {} };
    } else {
      currentConfig = { mcpServers: {} };
    }

    let backupFile = null;

    if (fs.existsSync(configFilePath)) {
      const raw = fs.readFileSync(configFilePath, 'utf8');
      try {
        currentConfig = JSON.parse(raw);
        if (isZCode) {
          if (!currentConfig.mcp || typeof currentConfig.mcp !== 'object') {
            currentConfig.mcp = {};
          }
          if (!currentConfig.mcp.servers || typeof currentConfig.mcp.servers !== 'object') {
            currentConfig.mcp.servers = {};
          }
        } else if (isOpenCode) {
          if (!currentConfig.mcp || typeof currentConfig.mcp !== 'object') {
            currentConfig.mcp = {};
          }
        } else {
          if (!currentConfig.mcpServers || typeof currentConfig.mcpServers !== 'object') {
            currentConfig.mcpServers = {};
          }
        }

        // Create backup
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        backupFile = `${configFilePath}.${timestamp}.bak`;
        fs.writeFileSync(backupFile, raw, 'utf8');
      } catch (parseErr) {
        // If file is corrupted or empty, back it up and start fresh
        backupFile = `${configFilePath}.corrupted.bak`;
        fs.writeFileSync(backupFile, raw, 'utf8');
        if (isZCode) {
          currentConfig = { mcp: { servers: {} } };
        } else if (isOpenCode) {
          currentConfig = { "$schema": "https://opencode.ai/config.json", mcp: {} };
        } else {
          currentConfig = { mcpServers: {} };
        }
      }
    }

    // Merge servers without removing existing ones
    if (isZCode) {
      for (const [key, val] of Object.entries(serversToMerge)) {
        currentConfig.mcp.servers[key] = val;
      }
    } else if (isOpenCode) {
      for (const [key, val] of Object.entries(serversToMerge)) {
        currentConfig.mcp[key] = val;
      }
    } else {
      for (const [key, val] of Object.entries(serversToMerge)) {
        currentConfig.mcpServers[key] = val;
      }
    }

    fs.writeFileSync(configFilePath, JSON.stringify(currentConfig, null, 2), 'utf8');

    return {
      success: true,
      backupFile,
      filePath: configFilePath,
      serverKeys: Object.keys(serversToMerge)
    };
  } catch (error) {
    return {
      success: false,
      filePath: configFilePath,
      error: error.message
    };
  }
}
