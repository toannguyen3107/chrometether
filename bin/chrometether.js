#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { detectAgents } from '../src/installer/agent-detector.js';
import { mergeMcpConfig, getBrowserMcpConfigs, getOpenCodeMcpConfigs, getZCodeMcpConfigs } from '../src/installer/config-merger.js';
import { getAgentPaths } from '../src/installer/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectDir = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0] || 'status';

function showHelp() {
  console.log(`
ChromeTether: Dual-Tier Browser & Live Chrome Automation Toolkit
================================================================

Usage:
  npx chrometether <command> [options]

Commands:
  status               Check detected agents and their MCP configuration status
  install [agent]      Install/merge MCP configuration into agents (default: all detected)
                       Supported: all, zcode, opencode, claude-code, claude-desktop, cursor, windsurf, roo-code, cline
  test                 Run full diagnostics and health check
  start-reader         Start the Tier 1 Reader MCP server on stdio
  help                 Display this help information

Examples:
  node bin/chrometether.js status
  node bin/chrometether.js install zcode
  node bin/chrometether.js install opencode
  node bin/chrometether.js install all
  node bin/chrometether.js test
`);
}

function handleStatus() {
  console.log('\n=== AGENT ENVIRONMENT STATUS ===\n');
  const agents = detectAgents();
  agents.forEach(a => {
    let statusText = 'Not Detected';
    if (a.isConfigured) {
      statusText = '✔ CONFIGURED (Ready)';
    } else if (a.isDetected) {
      statusText = '⚠ Detected (Not yet configured)';
    }
    console.log(`• ${a.name.padEnd(30)}: ${statusText}`);
    console.log(`  Config Path: ${a.configPath}\n`);
  });
  console.log('To install into all detected agents, run: node bin/chrometether.js install all\n');
}

function handleInstall(targetAgent = 'all') {
  console.log('\n=== INSTALLING CHROMETETHER MCP SERVERS ===\n');
  const agents = detectAgents();
  const allPaths = getAgentPaths();
  const configs = getBrowserMcpConfigs(projectDir);

  const targets = [];
  if (targetAgent === 'all') {
    // Target all detected, or all if none detected
    const detected = agents.filter(a => a.isDetected);
    if (detected.length > 0) {
      targets.push(...detected);
    } else {
      console.log('ℹ No existing agents detected automatically. Configuring all supported agent paths...\n');
      targets.push(...agents);
    }
  } else {
    const found = agents.find(a => a.id === targetAgent || a.name.toLowerCase().includes(targetAgent.toLowerCase()));
    if (!found) {
      console.error(`❌ Unknown agent: "${targetAgent}".`);
      console.log('Available agents: ' + Object.keys(allPaths).join(', '));
      process.exit(1);
    }
    targets.push(found);
  }

  targets.forEach(agent => {
    console.log(`Installing into ${agent.name}...`);
    let serverConfigs = configs;
    let format = 'standard';
    if (agent.id === 'opencode' || agent.format === 'opencode') {
      serverConfigs = getOpenCodeMcpConfigs(projectDir);
      format = 'opencode';
    } else if (agent.id === 'zcode' || agent.format === 'zcode') {
      serverConfigs = getZCodeMcpConfigs(projectDir);
      format = 'zcode';
    }
    const result = mergeMcpConfig(agent.configPath, serverConfigs, format);
    if (result.success) {
      console.log(`  ✔ Successfully configured! File: ${result.filePath}`);
      if (result.backupFile) {
        console.log(`  ✔ Backup saved: ${result.backupFile}`);
      }
      console.log(`  ✔ Servers registered: ${result.serverKeys.join(', ')}\n`);
    } else {
      console.error(`  ❌ Failed to configure ${agent.name}: ${result.error}\n`);
    }
  });

  const localSkillsDir = path.join(projectDir, 'skills');
  const userHome = process.env.USERPROFILE || process.env.HOME;

  // 1. Copy skills to Claude Code
  const claudeSkillsDir = path.join(userHome, '.claude', 'skills');
  if (fs.existsSync(localSkillsDir)) {
    try {
      if (!fs.existsSync(claudeSkillsDir)) {
        fs.mkdirSync(claudeSkillsDir, { recursive: true });
      }
      fs.cpSync(localSkillsDir, claudeSkillsDir, { recursive: true });
      console.log('✔ Copied official browser skills to ~/.claude/skills/ (chrome-devtools, a11y, lcp, memory, troubleshooting)');
    } catch {
      // ignore
    }
  }

  // 2. Copy skills, slash command, and instructions to ZCode
  const zcodeSkillsDir = path.join(userHome, '.zcode', 'skills');
  const zcodeCommandsDir = path.join(userHome, '.zcode', 'commands');
  const zcodeAgentsMd = path.join(userHome, '.zcode', 'AGENTS.md');
  const localAgentsMd = path.join(projectDir, 'prompts', 'AGENTS.md');
  const localBrowserCmd = path.join(projectDir, 'commands', 'browser.md');

  if (fs.existsSync(localSkillsDir)) {
    try {
      if (!fs.existsSync(zcodeSkillsDir)) {
        fs.mkdirSync(zcodeSkillsDir, { recursive: true });
      }
      fs.cpSync(localSkillsDir, zcodeSkillsDir, { recursive: true });
      console.log('✔ Copied official browser skills to ~/.zcode/skills/');

      if (fs.existsSync(localBrowserCmd)) {
        if (!fs.existsSync(zcodeCommandsDir)) {
          fs.mkdirSync(zcodeCommandsDir, { recursive: true });
        }
        fs.copyFileSync(localBrowserCmd, path.join(zcodeCommandsDir, 'browser.md'));
        console.log('✔ Installed /browser slash command in ~/.zcode/commands/browser.md');
      }

      if (fs.existsSync(localAgentsMd) && !fs.existsSync(zcodeAgentsMd)) {
        fs.copyFileSync(localAgentsMd, zcodeAgentsMd);
        console.log('✔ Copied browser instructions to ~/.zcode/AGENTS.md');
      }
    } catch {
      // ignore
    }
  }

  console.log('----------------------------------------------------');
  console.log('✔ ChromeTether MCP configuration complete!');
  console.log('ℹ Next step: Copy the relevant rule file to your project:');
  console.log('  - For Claude:    Copy prompts/CLAUDE.md into your project (skills already in ~/.claude/skills/)');
  console.log('  - For ZCode:     Type /browser in chat! Skills & command are installed in ~/.zcode/');
  console.log('  - For OpenCode:  Copy prompts/AGENTS.md into your project (or ~/.config/opencode/AGENTS.md)');
  console.log('  - For Cursor:    Copy prompts/.cursor/rules/browser.mdc into your project');
  console.log('  - For Windsurf:  Copy prompts/.windsurfrules into your project');
  console.log('  - For Codex/All: Copy prompts/AGENTS.md into your project\n');
}

switch (command) {
  case 'status':
    handleStatus();
    break;
  case 'install':
    handleInstall(args[1] || 'all');
    break;
  case 'test':
    import('./test-connection.js');
    break;
  case 'start-reader':
    import('../src/reader-server/index.js');
    break;
  case 'help':
  case '--help':
  case '-h':
  default:
    showHelp();
    break;
}
