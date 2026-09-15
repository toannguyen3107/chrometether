import fs from 'fs';
import { getAgentPaths } from './paths.js';

/**
 * Detects which agent environments are present on the local machine.
 * @returns {Array<{ id: string, name: string, configPath: string, isDetected: boolean, isConfigured: boolean }>}
 */
export function detectAgents() {
  const agents = getAgentPaths();
  const results = [];

  for (const [key, info] of Object.entries(agents)) {
    const appDirExists = info.appDir ? fs.existsSync(info.appDir) : false;
    const configExists = fs.existsSync(info.configPath);
    let isConfigured = false;

    if (configExists) {
      try {
        const content = fs.readFileSync(info.configPath, 'utf8');
        const json = JSON.parse(content);
        if (
          (json?.mcpServers && (json.mcpServers['chrome-devtools'] || json.mcpServers['tether-reader'] || json.mcpServers['agy-reader'])) ||
          (json?.mcp?.servers && (json.mcp.servers['chrome-devtools'] || json.mcp.servers['tether-reader'] || json.mcp.servers['agy-reader'])) ||
          (json?.mcp && (json.mcp['chrome-devtools'] || json.mcp['tether-reader'] || json.mcp['agy-reader']))
        ) {
          isConfigured = true;
        }
      } catch {
        // ignore parse error
      }
    }

    results.push({
      id: info.id,
      name: info.name,
      configPath: info.configPath,
      appDir: info.appDir,
      isDetected: appDirExists || configExists,
      configExists,
      isConfigured,
    });
  }

  return results;
}
