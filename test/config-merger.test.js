import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  getChromeDevToolsLaunch,
  getBrowserMcpConfigs,
  getOpenCodeMcpConfigs,
  getZCodeMcpConfigs,
  mergeMcpConfig
} from '../src/installer/config-merger.js';

test('getChromeDevToolsLaunch uses local script and process.execPath when bundled script exists', () => {
  const tempProj = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-proj-'));
  try {
    const scriptPath = path.join(
      tempProj,
      'node_modules',
      'chrome-devtools-mcp',
      'build',
      'src',
      'bin',
      'chrome-devtools-mcp.js'
    );
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '// mock script', 'utf8');

    const prevNodeCmd = process.env.CHROMETETHER_NODE_COMMAND;
    delete process.env.CHROMETETHER_NODE_COMMAND;
    try {
      const launch = getChromeDevToolsLaunch(tempProj);
      assert.equal(launch.command, process.execPath);
      assert.ok(launch.args[0].endsWith('chrome-devtools-mcp.js'));
      assert.equal(launch.args[1], '--auto-connect');
      assert.equal(launch.fallback, undefined);
    } finally {
      if (prevNodeCmd !== undefined) process.env.CHROMETETHER_NODE_COMMAND = prevNodeCmd;
    }
  } finally {
    fs.rmSync(tempProj, { recursive: true, force: true });
  }
});

test('getChromeDevToolsLaunch falls back to pinned npx version when local script is absent', () => {
  const tempProj = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-proj-empty-'));
  try {
    fs.writeFileSync(
      path.join(tempProj, 'package.json'),
      JSON.stringify({ dependencies: { 'chrome-devtools-mcp': '^1.9.0' } }),
      'utf8'
    );
    const launch = getChromeDevToolsLaunch(tempProj);
    assert.equal(launch.command, 'npx');
    assert.match(launch.args[1], /^chrome-devtools-mcp@\d+\.\d+\.\d+$/);
    assert.equal(launch.fallback, true);
  } finally {
    fs.rmSync(tempProj, { recursive: true, force: true });
  }
});

test('CHROMETETHER_NODE_COMMAND override is respected across all three config builders', () => {
  const prev = process.env.CHROMETETHER_NODE_COMMAND;
  process.env.CHROMETETHER_NODE_COMMAND = 'node';
  try {
    const projectRoot = path.resolve('.');
    const std = getBrowserMcpConfigs(projectRoot);
    const oc = getOpenCodeMcpConfigs(projectRoot);
    const zc = getZCodeMcpConfigs(projectRoot);

    for (const srv of Object.values(std)) {
      assert.equal(srv.command, 'node');
    }
    for (const srv of Object.values(oc)) {
      assert.equal(srv.command[0], 'node');
    }
    for (const srv of Object.values(zc)) {
      assert.equal(srv.command, 'node');
    }

    assert.deepEqual(std['chrome-devtools'].args, zc['chrome-devtools'].args);
    assert.deepEqual(oc['chrome-devtools'].command.slice(1), std['chrome-devtools'].args);
  } finally {
    if (prev === undefined) delete process.env.CHROMETETHER_NODE_COMMAND;
    else process.env.CHROMETETHER_NODE_COMMAND = prev;
  }
});

test('mergeMcpConfig preserves existing servers and writes timestamped backup', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-merge-'));
  try {
    const mockConfigFile = path.join(tempDir, 'mock_config.json');
    const initialConfig = {
      mcpServers: {
        my_custom_db: { command: 'npx', args: ['-y', 'my-db-mcp'] }
      }
    };
    fs.writeFileSync(mockConfigFile, JSON.stringify(initialConfig, null, 2), 'utf8');

    const servers = getBrowserMcpConfigs(path.resolve('.'));
    const res = mergeMcpConfig(mockConfigFile, servers);
    assert.equal(res.success, true);
    assert.ok(res.backupFile && fs.existsSync(res.backupFile));

    const updated = JSON.parse(fs.readFileSync(mockConfigFile, 'utf8'));
    assert.ok(updated.mcpServers.my_custom_db);
    assert.ok(updated.mcpServers['chrome-devtools']);
    assert.ok(updated.mcpServers['tether-reader']);
    assert.ok(updated.mcpServers['tether-map']);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
