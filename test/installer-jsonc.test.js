import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mergeMcpConfig } from '../src/installer/config-merger.js';

test('merges OpenCode JSONC while preserving existing settings and servers', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-jsonc-'));
  try {
    const filePath = path.join(directory, 'opencode.jsonc');
    const original = `{
      // Existing provider settings
      "model": "provider/model",
      "url": "https://example.test/path//item",
      "note": "literal /* comment */ and escaped \\"quotes\\"",
      "mcp": {
        "existing": { "type": "local", "command": ["node", "old.js"] },
      },
      /* Retain other settings */
      "theme": "dark",
    }`;
    fs.writeFileSync(filePath, original);
    const result = mergeMcpConfig(filePath, { 'tether-map': { type: 'local', command: ['node', 'map.js'] } }, 'opencode');
    assert.equal(result.success, true, result.error);
    assert.equal(fs.readFileSync(result.backupFile, 'utf8'), original);
    const updated = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(updated.model, 'provider/model');
    assert.equal(updated.url, 'https://example.test/path//item');
    assert.equal(updated.note, 'literal /* comment */ and escaped "quotes"');
    assert.equal(updated.theme, 'dark');
    assert.deepEqual(updated.mcp.existing.command, ['node', 'old.js']);
    assert.deepEqual(updated.mcp['tether-map'].command, ['node', 'map.js']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('leaves malformed existing configuration unchanged', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-jsonc-'));
  try {
    const filePath = path.join(directory, 'opencode.jsonc');
    const original = '{"model":"provider/model", /* unfinished';
    fs.writeFileSync(filePath, original);
    const result = mergeMcpConfig(filePath, { 'tether-map': {} }, 'opencode');
    assert.equal(result.success, false);
    assert.match(result.error, /not changed/);
    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('does not replace an existing non-object MCP setting', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chrometether-jsonc-'));
  try {
    const filePath = path.join(directory, 'opencode.jsonc');
    const original = '{"model":"provider/model","mcp":"custom"}';
    fs.writeFileSync(filePath, original);
    const result = mergeMcpConfig(filePath, { 'tether-map': {} }, 'opencode');
    assert.equal(result.success, false);
    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
