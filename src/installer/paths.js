import path from 'path';
import os from 'os';

const home = os.homedir();
const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const appData = isWindows ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming') : '';

export function getAgentPaths() {
  return {
    claudeDesktop: {
      name: 'Claude Desktop',
      id: 'claude-desktop',
      configPath: isWindows
        ? path.join(appData, 'Claude', 'claude_desktop_config.json')
        : isMac
        ? path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : path.join(home, '.config', 'Claude', 'claude_desktop_config.json'),
      appDir: isWindows
        ? path.join(appData, 'Claude')
        : isMac
        ? path.join(home, 'Library', 'Application Support', 'Claude')
        : path.join(home, '.config', 'Claude'),
    },
    claudeCode: {
      name: 'Claude Code CLI',
      id: 'claude-code',
      configPath: path.join(home, '.claude.json'),
      appDir: path.join(home, '.claude'),
    },
    cursor: {
      name: 'Cursor IDE',
      id: 'cursor',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      appDir: path.join(home, '.cursor'),
    },
    windsurf: {
      name: 'Windsurf (Codeium)',
      id: 'windsurf',
      configPath: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      appDir: path.join(home, '.codeium', 'windsurf'),
    },
    rooCode: {
      name: 'Roo Code (VS Code Extension)',
      id: 'roo-code',
      configPath: isWindows
        ? path.join(appData, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'cline_mcp_settings.json')
        : isMac
        ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'cline_mcp_settings.json')
        : path.join(home, '.config', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'settings', 'cline_mcp_settings.json'),
      appDir: isWindows
        ? path.join(appData, 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline')
        : isMac
        ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline')
        : path.join(home, '.config', 'Code', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline'),
    },
    cline: {
      name: 'Cline (VS Code Extension)',
      id: 'cline',
      configPath: isWindows
        ? path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
        : isMac
        ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json')
        : path.join(home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
      appDir: isWindows
        ? path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
        : isMac
        ? path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
        : path.join(home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),
    },
    openCode: {
      name: 'OpenCode CLI',
      id: 'opencode',
      format: 'opencode',
      configPath: path.join(home, '.config', 'opencode', 'opencode.jsonc'),
      appDir: path.join(home, '.config', 'opencode'),
    },
    zcode: {
      name: 'ZCode (Z.ai)',
      id: 'zcode',
      format: 'zcode',
      configPath: path.join(home, '.zcode', 'cli', 'config.json'),
      appDir: path.join(home, '.zcode'),
      skillsDir: path.join(home, '.zcode', 'skills'),
      agentsMd: path.join(home, '.zcode', 'AGENTS.md')
    },
  };
}
