import nodeFs from 'fs';
import path from 'path';
import { getBrowserMcpConfigs, mergeMcpConfig } from './config-merger.js';
import { getConfiguredServers } from './agent-detector.js';

/**
 * Installs ChromeTether plugin and MCP servers into Google Antigravity (AGY).
 * @param {{ projectDir: string, agent: object, fs?: typeof nodeFs, log?: (...args: any[]) => void }} options
 */
export function installAntigravity({ projectDir, agent, fs = nodeFs, log = console.log }) {
  try {
    const dest = agent.pluginsDir;
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
    }

    fs.copyFileSync(path.join(projectDir, 'plugin.json'), path.join(dest, 'plugin.json'));

    const destRules = path.join(dest, 'rules');
    if (!fs.existsSync(destRules)) {
      fs.mkdirSync(destRules, { recursive: true });
    }
    fs.copyFileSync(path.join(projectDir, 'rules', 'AGENTS.md'), path.join(destRules, 'AGENTS.md'));

    const destSkills = path.join(dest, 'skills');
    if (!fs.existsSync(destSkills)) {
      fs.mkdirSync(destSkills, { recursive: true });
    }
    fs.cpSync(path.join(projectDir, 'skills'), destSkills, { recursive: true });

    const servers = { ...getBrowserMcpConfigs(projectDir, { fs }) };

    if (agent.configPath && fs.existsSync(agent.configPath)) {
      try {
        const existingRaw = fs.readFileSync(agent.configPath, 'utf8');
        const existingKeys = getConfiguredServers(existingRaw, 'standard');
        if (existingKeys.includes('chrome_devtools') || existingKeys.includes('chrome-devtools')) {
          delete servers['chrome-devtools'];
          log('  ℹ Antigravity already provides chrome_devtools; skipping duplicate');
        }
      } catch {
        // ignore read error, mergeMcpConfig will handle validation
      }
    }

    const pluginMcpPath = agent.pluginMcpConfigPath || path.join(dest, 'mcp_config.json');
    fs.writeFileSync(pluginMcpPath, JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');

    const mergeRes = mergeMcpConfig(agent.configPath, servers, 'standard');
    if (!mergeRes.success) {
      throw new Error(mergeRes.error);
    }

    log(`  ✔ Successfully installed Antigravity plugin! Directory: ${dest}`);
    log(`  ✔ Merged MCP servers into: ${mergeRes.filePath}`);
    if (mergeRes.backupFile) {
      log(`  ✔ Backup saved: ${mergeRes.backupFile}`);
    }
    log(`  ✔ Servers registered: ${mergeRes.serverKeys.join(', ')}\n`);

    return {
      success: true,
      pluginsDir: dest,
      mergedConfig: mergeRes.filePath,
      backupFile: mergeRes.backupFile,
      serverKeys: mergeRes.serverKeys
    };
  } catch (err) {
    return {
      success: false,
      error: err.message
    };
  }
}
