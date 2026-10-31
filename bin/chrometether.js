#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ContainerVault } from '../src/cdp-hub/container-vault.js';
import {
  checkHubHealth,
  ensureHubDaemon,
  stopHubDaemon
} from '../src/cdp-hub/launcher.js';
import { getHubPort, getOrCreateHubToken } from '../src/cdp-hub/token.js';
import { detectAgents } from '../src/installer/agent-detector.js';
import { installAntigravity } from '../src/installer/antigravity.js';
import {
  getBrowserMcpConfigs,
  getChromeDevToolsLaunch,
  getNodeCommand,
  getOpenCodeMcpConfigs,
  getZCodeMcpConfigs,
  mergeMcpConfig
} from '../src/installer/config-merger.js';
import { getAgentPaths, getHome } from '../src/installer/paths.js';

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
  node bin/chrometether.js <command> [options]     (from a clone)
  npx chrometether <command> [options]             (once published to npm)

Commands:
  status               Check detected agents and their MCP configuration status
  install [agent]      Install/merge MCP configuration into agents (default: all detected)
                       Supported: all, zcode, opencode, claude-code, claude-desktop, cursor, windsurf, roo-code, cline, antigravity, dsh
                       Options: --force (install to all supported paths even when none are detected)
  hub <subcommand>     Manage the Local CDP Hub daemon (status [--json] | start | stop | token)
  containers <sub>     Manage Multi-Account Containers (list [--json] | create <name> [color] | clear <name> | delete <name>)
  test                 Run full diagnostics and health check
  start-reader         Start the Tier 1 Reader MCP server on stdio
  start-containers     Start the Multi-Account Containers MCP server on stdio
  help                 Display this help information

Examples:
  node bin/chrometether.js status
  node bin/chrometether.js install all
  node bin/chrometether.js hub status
  node bin/chrometether.js containers create acc-1 blue
  node bin/chrometether.js containers create acc-2 orange
  node bin/chrometether.js test
`);
}

function handleStatus() {
  console.log('\n=== AGENT ENVIRONMENT STATUS ===\n');
  const agents = detectAgents();
  agents.forEach(a => {
    let statusText = 'Not Detected';
    if (a.isConfigured) {
      const list = a.configuredServers?.length ? a.configuredServers.join(', ') : 'Ready';
      statusText = `✔ CONFIGURED (${list})`;
    } else if (a.isPartiallyConfigured) {
      statusText = `◐ Partially configured (${a.configuredServers.join(', ')} only)`;
    } else if (a.isDetected) {
      statusText = '⚠ Detected (Not yet configured)';
    }
    console.log(`• ${a.name.padEnd(30)}: ${statusText}`);
    console.log(`  Config Path: ${a.configPath}`);
    if (a.id === 'antigravity') {
      console.log(`  Plugin:      ${a.pluginInstalled ? 'installed' : 'missing'} (${a.pluginsDir})`);
    }
    console.log('');
  });
  console.log('To install into all detected agents, run: node bin/chrometether.js install all\n');
}

function handleInstall(targetAgent = 'all', extraArgs = []) {
  const forceAll = extraArgs.includes('--force');
  console.log('\n=== INSTALLING CHROMETETHER MCP SERVERS ===\n');
  const agents = detectAgents();
  const allPaths = getAgentPaths();
  const configs = getBrowserMcpConfigs(projectDir);

  const targets = [];
  if (targetAgent === 'all') {
    const detected = agents.filter(a => a.isDetected);
    if (detected.length > 0) {
      targets.push(...detected);
    } else if (forceAll) {
      console.log('ℹ No existing agents detected automatically. --force specified: configuring all supported agent paths...\n');
      targets.push(...agents);
    } else {
      const supportedIds = Object.values(allPaths).map(p => p.id).join(', ');
      console.log('ℹ No installed AI agents were detected in the current home directory.');
      console.log(`  Supported agents: ${supportedIds}`);
      console.log('  To install for a specific agent: node bin/chrometether.js install <agent>');
      console.log('  To force configuration of all paths: node bin/chrometether.js install all --force\n');
      return;
    }
  } else {
    const exactMatch = agents.find(a => a.id.toLowerCase() === targetAgent.toLowerCase());
    if (exactMatch) {
      targets.push(exactMatch);
    } else {
      const nameMatches = agents.filter(a => a.name.toLowerCase().includes(targetAgent.toLowerCase()));
      if (nameMatches.length === 1) {
        targets.push(nameMatches[0]);
      } else if (nameMatches.length > 1) {
        console.error(`❌ Ambiguous agent name "${targetAgent}" matched multiple agents: ${nameMatches.map(a => a.id).join(', ')}.`);
        process.exit(1);
      } else {
        console.error(`❌ Unknown agent: "${targetAgent}".`);
        console.log('Available agents: ' + Object.values(allPaths).map(a => a.id).join(', '));
        process.exit(1);
      }
    }
  }

  targets.forEach(agent => {
    console.log(`Installing into ${agent.name}...`);
    if (agent.id === 'antigravity') {
      const res = installAntigravity({ projectDir, agent });
      if (!res.success) {
        console.error(`  ❌ Failed to install Antigravity plugin: ${res.error}\n`);
      }
      return;
    }

    if (agent.id === 'dsh') {
      try {
        const patchPath = agent.configPath;
        const patchDir = path.dirname(patchPath);
        if (!fs.existsSync(patchDir)) {
          fs.mkdirSync(patchDir, { recursive: true });
        }

        // Single source of truth via getChromeDevToolsLaunch (Fixes Fable M4)
        const dtLaunch = getChromeDevToolsLaunch(projectDir);
        const dtCommand = dtLaunch.command.replace(/\\/g, '/');
        const dtArgsYaml = dtLaunch.args
          .map(a => `          - ${String(a).replace(/\\/g, '/')}`)
          .join('\n');

        const nodeExe = getNodeCommand().replace(/\\/g, '/');
        const tetherReaderScript = path.join(projectDir, 'src', 'reader-server', 'index.js').replace(/\\/g, '/');
        const tetherMapScript = path.join(projectDir, 'src', 'app-map', 'server.js').replace(/\\/g, '/');
        const tetherContainersScript = path.join(projectDir, 'src', 'containers-server', 'index.js').replace(/\\/g, '/');
        const projectDirFwd = projectDir.replace(/\\/g, '/');

        const dshSnippet = `    - id: mcp-tether-reader
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: tether_reader
        transport: stdio
        command: ${nodeExe}
        args:
          - ${tetherReaderScript}
        cwd: ${projectDirFwd}
    - id: mcp-chrome-devtools
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: chrome_devtools
        transport: stdio
        command: ${dtCommand}
        args:
${dtArgsYaml}
        cwd: ${projectDirFwd}
    - id: mcp-tether-map
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: tether_map
        transport: stdio
        command: ${nodeExe}
        args:
          - ${tetherMapScript}
        cwd: ${projectDirFwd}
    - id: mcp-tether-containers
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: tether_containers
        transport: stdio
        command: ${nodeExe}
        args:
          - ${tetherContainersScript}
        cwd: ${projectDirFwd}\n`;

        let content = '';
        if (fs.existsSync(patchPath)) {
          content = fs.readFileSync(patchPath, 'utf8');
        } else {
          content = '# dsh profile patch\n- insert:\n';
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        if (fs.existsSync(patchPath)) {
          fs.writeFileSync(`${patchPath}.${timestamp}.bak`, content, 'utf8');
        }

        // Remove any previous mcp-tether-reader, mcp-chrome-devtools, mcp-tether-map, mcp-tether-containers blocks
        content = content.replace(
          /^[ \t]*-\s*id:\s*mcp-(?:tether-reader|chrome-devtools|tether-map|tether-containers|agy-reader)\r?\n(?:[ \t]{6,}.*\r?\n)*/gm,
          ''
        );

        if (content.includes('- insert:')) {
          content = content.replace(/- insert:\r?\n/, `- insert:\n${dshSnippet}`);
        } else {
          content += `\n- insert:\n${dshSnippet}`;
        }
        fs.writeFileSync(patchPath, content, 'utf8');

        const localSkillsDir = path.join(projectDir, 'skills');
        if (agent.skillsDir && fs.existsSync(localSkillsDir)) {
          if (!fs.existsSync(agent.skillsDir)) {
            fs.mkdirSync(agent.skillsDir, { recursive: true });
          }
          fs.cpSync(localSkillsDir, agent.skillsDir, { recursive: true });
        }

        const localAgentsMd = path.join(projectDir, 'AGENTS.md');
        if (agent.agentsMd && fs.existsSync(localAgentsMd)) {
          fs.copyFileSync(localAgentsMd, agent.agentsMd);
        }

        console.log(`  ✔ Successfully configured DeepSeek Harness (dsh)! File: ${patchPath}`);
        console.log(`  ✔ Copied browser skills to: ${agent.skillsDir}`);
        console.log(`  ✔ Set up agent instructions in: ${agent.agentsMd}\n`);
        return;
      } catch (err) {
        console.error(`  ❌ Failed to configure DeepSeek Harness (dsh): ${err.message}\n`);
        return;
      }
    }

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
  const userHome = getHome();

  if (targets.some(t => t.id === 'claude-code')) {
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
  }

  if (targets.some(t => t.id === 'zcode')) {
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

        if (fs.existsSync(localAgentsMd)) {
          fs.copyFileSync(localAgentsMd, zcodeAgentsMd);
          console.log('✔ Copied browser instructions to ~/.zcode/AGENTS.md');
        }
      } catch {
        // ignore
      }
    }
  }

  console.log(`ℹ MCP servers will be launched with: ${getNodeCommand()}`);
  const dtLaunch = getChromeDevToolsLaunch(projectDir);
  if (dtLaunch.fallback) {
    console.log('⚠ Local chrome-devtools-mcp not found in node_modules; falling back to npx. Run "npm install" to use the bundled chrome-devtools-mcp.');
  }

  console.log('----------------------------------------------------');
  console.log('✔ ChromeTether MCP configuration complete!');
  console.log(`ℹ Companion Chrome Extension folder: ${path.join(projectDir, 'extension')}`);
  console.log('ℹ Next step: Copy the relevant rule file to your project:');
  console.log('  - For Claude:    Copy prompts/CLAUDE.md into your project (skills already in ~/.claude/skills/)');
  console.log('  - For ZCode:     Type /browser in chat! Skills & command are installed in ~/.zcode/');
  console.log('  - For OpenCode:  Copy prompts/AGENTS.md into your project (or ~/.config/opencode/AGENTS.md)');
  console.log('  - For Cursor:    Copy prompts/.cursor/rules/browser.mdc into your project');
  console.log('  - For Windsurf:  Copy prompts/.windsurfrules into your project');
  console.log('  - For DSH:       Installed in ~/.dsh/profiles/web/cordis.patch.yml, ~/.dsh/skills, ~/.dsh/AGENTS.md');
  console.log('  - For Codex/All: Copy prompts/AGENTS.md into your project\n');
}

async function handleHub(subArgs = []) {
  const sub = subArgs[0] || 'status';
  const asJson = subArgs.includes('--json');
  const port = getHubPort();

  if (sub === 'status') {
    const health = await checkHubHealth({ port });
    if (asJson) {
      console.log(JSON.stringify(health || { ok: false, running: false, port }, null, 2));
      return;
    }
    if (!health) {
      console.log(`ChromeTether CDP Hub is currently stopped (port ${port}).`);
      console.log('Run "node bin/chrometether.js hub start" to launch it.');
      return;
    }
    console.log(`✔ ChromeTether CDP Hub v${health.version} running on 127.0.0.1:${health.port}`);
    console.log(`  Mode:               ${health.mode}`);
    console.log(`  Extension Connected:${health.extensionConnected ? ' yes' : ' no'}`);
    console.log(`  Direct CDP Active:  ${health.directCdpConnected ? ' yes' : ' no'}`);
    console.log(`  Active MCP Clients: ${health.mcpClientsCount}`);
    console.log(`  Tracked Tabs:       ${health.tabsCount}`);
    console.log(`  Containers:         ${health.containers?.length || 0}`);
    return;
  }

  if (sub === 'start') {
    const health = await ensureHubDaemon({ port });
    if (asJson) {
      console.log(JSON.stringify(health, null, 2));
    } else {
      console.log(`✔ ChromeTether CDP Hub started on 127.0.0.1:${health.port} (mode: ${health.mode})`);
    }
    return;
  }

  if (sub === 'stop') {
    const res = await stopHubDaemon({ port });
    if (asJson) {
      console.log(JSON.stringify(res, null, 2));
    } else if (res.stopped) {
      console.log('✔ ChromeTether CDP Hub stopped.');
    } else {
      console.log('ℹ ChromeTether CDP Hub was not running.');
    }
    return;
  }

  if (sub === 'token') {
    console.log(getOrCreateHubToken());
    return;
  }

  showHelp();
}

function handleContainers(subArgs = []) {
  const sub = subArgs[0] || 'list';
  const asJson = subArgs.includes('--json');
  const vault = new ContainerVault();

  if (sub === 'list') {
    const list = vault.listContainers();
    if (asJson) {
      console.log(JSON.stringify(list, null, 2));
      return;
    }
    if (list.length === 0) {
      console.log('No containers configured yet. Create one with: node bin/chrometether.js containers create acc-1 blue');
      return;
    }
    for (const c of list) {
      console.log(
        `${c.badge} ${c.name.padEnd(16)} [MCP: ${c.mcpIsolatedContextName}] color=${c.color} cookies=${c.cookieCount} origins=${c.originsCount}`
      );
    }
    return;
  }

  if (sub === 'create') {
    const name = subArgs[1];
    const color = subArgs[2];
    if (!name) {
      console.error('Usage: node bin/chrometether.js containers create <name> [color]');
      process.exit(1);
    }
    const entry = vault.ensureContainer(name, { color });
    const info = vault.listContainers().find(c => c.name === entry.name) || entry;
    if (asJson) {
      console.log(JSON.stringify(info, null, 2));
    } else {
      console.log(`✔ Container ready: ${info.badge} ${info.name} (MCP isolatedContext: ${info.mcpIsolatedContextName})`);
    }
    return;
  }

  if (sub === 'clear') {
    const name = subArgs[1];
    if (!name) {
      console.error('Usage: node bin/chrometether.js containers clear <name>');
      process.exit(1);
    }
    const ok = vault.clearContainer(name);
    console.log(ok ? `✔ Cleared container "${name}".` : `ℹ Container "${name}" not found.`);
    return;
  }

  if (sub === 'delete') {
    const name = subArgs[1];
    if (!name) {
      console.error('Usage: node bin/chrometether.js containers delete <name>');
      process.exit(1);
    }
    const ok = vault.deleteContainer(name);
    console.log(ok ? `✔ Deleted container "${name}".` : `ℹ Container "${name}" not found.`);
    return;
  }

  showHelp();
}

switch (command) {
  case 'status':
    handleStatus();
    break;
  case 'install': {
    const installArgs = args.slice(1);
    const nonFlagArgs = installArgs.filter(a => !a.startsWith('-'));
    const flagArgs = installArgs.filter(a => a.startsWith('-'));
    handleInstall(nonFlagArgs[0] || 'all', flagArgs);
    break;
  }
  case 'hub':
    handleHub(args.slice(1));
    break;
  case 'containers':
    handleContainers(args.slice(1));
    break;
  case 'test':
    import('./test-connection.js');
    break;
  case 'start-reader':
    import('../src/reader-server/index.js');
    break;
  case 'start-containers':
    import('../src/containers-server/index.js');
    break;
  case 'help':
  case '--help':
  case '-h':
  default:
    showHelp();
    break;
}
