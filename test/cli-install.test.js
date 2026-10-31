import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, '..', 'bin', 'chrometether.js');

function runCli(args, homeDir) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    env: {
      ...process.env,
      CHROMETETHER_HOME: homeDir,
      CHROMETETHER_NODE_COMMAND: 'node'
    },
    encoding: 'utf8'
  });
}

test('install antigravity writes plugin files, merges global mcp_config.json, and status reports CONFIGURED', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-cli-agy-'));
  try {
    fs.mkdirSync(path.join(tmp, '.gemini', 'antigravity'), { recursive: true });

    const installRes = runCli(['install', 'antigravity'], tmp);
    assert.equal(installRes.status, 0, installRes.stderr);

    const pluginDir = path.join(tmp, '.gemini', 'config', 'plugins', 'agy-browser');
    assert.ok(fs.existsSync(path.join(pluginDir, 'plugin.json')));
    assert.ok(fs.existsSync(path.join(pluginDir, 'mcp_config.json')));
    assert.ok(fs.existsSync(path.join(pluginDir, 'rules', 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(pluginDir, 'skills', 'chrome-devtools', 'SKILL.md')));

    const globalMcpPath = path.join(tmp, '.gemini', 'config', 'mcp_config.json');
    assert.ok(fs.existsSync(globalMcpPath));

    const globalMcp = JSON.parse(fs.readFileSync(globalMcpPath, 'utf8'));
    const pluginMcp = JSON.parse(fs.readFileSync(path.join(pluginDir, 'mcp_config.json'), 'utf8'));

    assert.deepEqual(pluginMcp.mcpServers, globalMcp.mcpServers);
    assert.equal(globalMcp.mcpServers['tether-reader'].command, 'node');
    assert.ok(globalMcp.mcpServers['tether-reader'].args[0].endsWith(path.join('src', 'reader-server', 'index.js')));
    assert.ok(globalMcp.mcpServers['tether-map']);
    assert.ok(!JSON.stringify(globalMcp).includes('chrome-devtools-mcp@latest'));

    const statusRes = runCli(['status'], tmp);
    assert.equal(statusRes.status, 0);
    const agyBlock = statusRes.stdout.split('\n').find(l => l.includes('Google Antigravity'));
    assert.ok(agyBlock && agyBlock.includes('CONFIGURED'), `Expected CONFIGURED on Antigravity line, got: ${agyBlock}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('install antigravity skips duplicate chrome-devtools when chrome_devtools is already configured', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-cli-dup-'));
  try {
    const configDir = path.join(tmp, '.gemini', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    const mcpPath = path.join(configDir, 'mcp_config.json');
    fs.writeFileSync(
      mcpPath,
      JSON.stringify({
        mcpServers: {
          burp_mcp: { command: 'java', args: [] },
          chrome_devtools: { command: 'node', args: ['builtin.js'] }
        }
      }),
      'utf8'
    );

    const res = runCli(['install', 'antigravity'], tmp);
    assert.equal(res.status, 0, res.stderr);

    const updated = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    assert.deepEqual(updated.mcpServers.chrome_devtools, { command: 'node', args: ['builtin.js'] });
    assert.equal(updated.mcpServers['chrome-devtools'], undefined);
    assert.ok(updated.mcpServers['tether-reader']);
    assert.ok(updated.mcpServers['tether-map']);

    const backups = fs.readdirSync(configDir).filter(f => f.startsWith('mcp_config.json.') && f.endsWith('.bak'));
    assert.equal(backups.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('install all in empty home does not create directories unless --force is passed', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-cli-empty-'));
  try {
    const res = runCli(['install', 'all'], tmp);
    assert.equal(res.status, 0);
    assert.deepEqual(fs.readdirSync(tmp), []);
    assert.match(res.stdout, /install <agent>/);

    const forceRes = runCli(['install', 'all', '--force'], tmp);
    assert.equal(forceRes.status, 0);
    assert.ok(fs.readdirSync(tmp).length > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('help command prints clone usage with node bin/chrometether.js', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-cli-help-'));
  try {
    const res = runCli(['help'], tmp);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /node bin\/chrometether\.js <command>/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
