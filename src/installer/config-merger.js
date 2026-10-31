import nodeFs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseJsonc } from './jsonc.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PROJECT_DIR = path.resolve(__dirname, '..', '..');

export function getNodeCommand() {
  return process.env.CHROMETETHER_NODE_COMMAND || process.execPath;
}

export function getChromeDevToolsScript(projectDir = DEFAULT_PROJECT_DIR) {
  return path.join(
    path.resolve(projectDir),
    'node_modules',
    'chrome-devtools-mcp',
    'build',
    'src',
    'bin',
    'chrome-devtools-mcp.js'
  );
}

export function getPinnedDevToolsVersion(projectDir = DEFAULT_PROJECT_DIR, { fs = nodeFs } = {}) {
  try {
    const pkgPath = path.join(path.resolve(projectDir), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const raw = pkg?.dependencies?.['chrome-devtools-mcp'] || '1.9.0';
    return String(raw).replace(/^[\^~>=<\s]+/, '');
  } catch {
    return '1.9.0';
  }
}

export function getChromeDevToolsLaunch(projectDir = DEFAULT_PROJECT_DIR, { fs = nodeFs } = {}) {
  const script = getChromeDevToolsScript(projectDir);
  if (fs.existsSync(script)) {
    return {
      command: getNodeCommand(),
      args: [script, '--auto-connect']
    };
  }
  return {
    command: 'npx',
    args: ['-y', `chrome-devtools-mcp@${getPinnedDevToolsVersion(projectDir, { fs })}`, '--auto-connect'],
    fallback: true
  };
}

export function getServerLaunches(projectDir = DEFAULT_PROJECT_DIR, { fs = nodeFs } = {}) {
  const normalizedProjectDir = path.resolve(projectDir);
  const nodeCmd = getNodeCommand();
  const readerScript = path.join(normalizedProjectDir, 'src', 'reader-server', 'index.js');
  const mapScript = path.join(normalizedProjectDir, 'src', 'app-map', 'server.js');
  const devToolsLaunch = getChromeDevToolsLaunch(normalizedProjectDir, { fs });

  return {
    'chrome-devtools': {
      command: devToolsLaunch.command,
      args: devToolsLaunch.args,
      ...(devToolsLaunch.fallback ? { fallback: true } : {})
    },
    'tether-reader': {
      command: nodeCmd,
      args: [readerScript]
    },
    'tether-map': {
      command: nodeCmd,
      args: [mapScript]
    }
  };
}

/**
 * Returns standard MCP server definitions for ChromeTether.
 * @param {string} [projectDir] - Absolute path to project root
 * @param {{ fs?: typeof nodeFs }} [options]
 * @returns {object}
 */
export function getBrowserMcpConfigs(projectDir = DEFAULT_PROJECT_DIR, { fs = nodeFs } = {}) {
  const launches = getServerLaunches(projectDir, { fs });
  return {
    'chrome-devtools': {
      command: launches['chrome-devtools'].command,
      args: launches['chrome-devtools'].args
    },
    'tether-reader': {
      command: launches['tether-reader'].command,
      args: launches['tether-reader'].args
    },
    'tether-map': {
      command: launches['tether-map'].command,
      args: launches['tether-map'].args
    }
  };
}

/**
 * Returns OpenCode-formatted MCP server definitions.
 * @param {string} [projectDir]
 * @param {{ fs?: typeof nodeFs }} [options]
 * @returns {object}
 */
export function getOpenCodeMcpConfigs(projectDir = DEFAULT_PROJECT_DIR, { fs = nodeFs } = {}) {
  const launches = getServerLaunches(projectDir, { fs });
  return {
    'chrome-devtools': {
      type: 'local',
      command: [launches['chrome-devtools'].command, ...launches['chrome-devtools'].args],
      enabled: true
    },
    'tether-reader': {
      type: 'local',
      command: [launches['tether-reader'].command, ...launches['tether-reader'].args],
      enabled: true
    },
    'tether-map': {
      type: 'local',
      command: [launches['tether-map'].command, ...launches['tether-map'].args],
      enabled: true
    }
  };
}

/**
 * Returns ZCode-formatted MCP server definitions.
 * @param {string} [projectDir]
 * @param {{ fs?: typeof nodeFs }} [options]
 * @returns {object}
 */
export function getZCodeMcpConfigs(projectDir = DEFAULT_PROJECT_DIR, { fs = nodeFs } = {}) {
  const launches = getServerLaunches(projectDir, { fs });
  return {
    'chrome-devtools': {
      type: 'stdio',
      command: launches['chrome-devtools'].command,
      args: launches['chrome-devtools'].args
    },
    'tether-reader': {
      type: 'stdio',
      command: launches['tether-reader'].command,
      args: launches['tether-reader'].args
    },
    'tether-map': {
      type: 'stdio',
      command: launches['tether-map'].command,
      args: launches['tether-map'].args
    }
  };
}

/**
 * Safely merges new MCP servers into an existing agent config file.
 * Creates an automatic backup (.bak) before modifying.
 * @param {string} configFilePath - Path to agent's config json
 * @param {object} serversToMerge - Object containing server definitions
 * @param {string|boolean} [format='standard'] - Format identifier ('standard', 'antigravity', 'opencode', 'zcode')
 * @returns {{ success: boolean, backupFile?: string, filePath: string, serverKeys?: string[], error?: string }}
 */
export function mergeMcpConfig(configFilePath, serversToMerge, format = 'standard') {
  try {
    const dir = path.dirname(configFilePath);
    if (!nodeFs.existsSync(dir)) {
      nodeFs.mkdirSync(dir, { recursive: true });
    }

    const normalizedFormat = format === 'antigravity' ? 'standard' : format;
    const isZCode = normalizedFormat === 'zcode' || configFilePath.toLowerCase().includes('.zcode');
    const isOpenCode = normalizedFormat === 'opencode' || normalizedFormat === true || configFilePath.toLowerCase().includes('opencode');

    let currentConfig = {};
    if (isZCode) {
      currentConfig = { mcp: { servers: {} } };
    } else if (isOpenCode) {
      currentConfig = { "$schema": "https://opencode.ai/config.json", mcp: {} };
    } else {
      currentConfig = { mcpServers: {} };
    }

    let backupFile = null;

    if (nodeFs.existsSync(configFilePath)) {
      const raw = nodeFs.readFileSync(configFilePath, 'utf8');
      try {
        currentConfig = isOpenCode ? parseJsonc(raw) : JSON.parse(raw);
      } catch (parseErr) {
        throw new Error(`Cannot parse existing config: ${parseErr.message}. The file was not changed.`);
      }
      if (!currentConfig || typeof currentConfig !== 'object' || Array.isArray(currentConfig)) {
        throw new Error('Existing config must be a JSON object. The file was not changed.');
      }
      if (isZCode) {
        if (currentConfig.mcp === undefined) currentConfig.mcp = {};
        else if (!currentConfig.mcp || typeof currentConfig.mcp !== 'object' || Array.isArray(currentConfig.mcp)) {
          throw new Error('Existing mcp setting must be an object. The file was not changed.');
        }
        if (currentConfig.mcp.servers === undefined) currentConfig.mcp.servers = {};
        else if (!currentConfig.mcp.servers || typeof currentConfig.mcp.servers !== 'object' || Array.isArray(currentConfig.mcp.servers)) {
          throw new Error('Existing mcp.servers setting must be an object. The file was not changed.');
        }
      } else if (isOpenCode) {
        if (currentConfig.mcp === undefined) currentConfig.mcp = {};
        else if (!currentConfig.mcp || typeof currentConfig.mcp !== 'object' || Array.isArray(currentConfig.mcp)) {
          throw new Error('Existing mcp setting must be an object. The file was not changed.');
        }
      } else {
        if (currentConfig.mcpServers === undefined) currentConfig.mcpServers = {};
        else if (!currentConfig.mcpServers || typeof currentConfig.mcpServers !== 'object' || Array.isArray(currentConfig.mcpServers)) {
          throw new Error('Existing mcpServers setting must be an object. The file was not changed.');
        }
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      backupFile = `${configFilePath}.${timestamp}.bak`;
      nodeFs.writeFileSync(backupFile, raw, 'utf8');
    }

    // Merge servers without removing unrelated existing ones; clean up legacy agy-reader key
    const targetMap = isZCode
      ? currentConfig.mcp.servers
      : isOpenCode
      ? currentConfig.mcp
      : currentConfig.mcpServers;

    if (serversToMerge['tether-reader'] && targetMap['agy-reader']) {
      delete targetMap['agy-reader'];
    }
    for (const [key, val] of Object.entries(serversToMerge)) {
      targetMap[key] = val;
    }

    nodeFs.writeFileSync(configFilePath, JSON.stringify(currentConfig, null, 2), 'utf8');

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
