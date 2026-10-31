import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { TOOL_DEFINITIONS } from '../src/reader-server/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function readRel(relPath) {
  return fs.readFileSync(path.join(rootDir, relPath), 'utf8');
}

test('prompts/AGENTS.md, rules/AGENTS.md, and root AGENTS.md are byte-identical', () => {
  const promptsAgents = readRel('prompts/AGENTS.md');
  const rulesAgents = readRel('rules/AGENTS.md');
  const rootAgents = readRel('AGENTS.md');
  assert.equal(promptsAgents, rulesAgents);
  assert.equal(promptsAgents, rootAgents);
});

test('all prompt and skill files enforce take_screenshot(filePath), 30s timeout, and Multi-Account Container Hub guidance', () => {
  const files = [
    'prompts/AGENTS.md',
    'prompts/CLAUDE.md',
    'prompts/.cursorrules',
    'prompts/.windsurfrules',
    'prompts/.cursor/rules/browser.mdc',
    'prompts/SKILL.md',
    'commands/browser.md',
    'skills/chrome-devtools/SKILL.md'
  ];

  for (const rel of files) {
    const content = readRel(rel);
    assert.match(content, /filePath/, `${rel} must mention filePath`);
    assert.doesNotMatch(content, /take_screenshot\(\)/, `${rel} must not use bare take_screenshot()`);
    assert.match(content, /30000ms|30 ?s/, `${rel} must mention 30s / 30000ms timeout`);
    assert.match(content, /tether-containers|open_container_page/, `${rel} must document tether-containers / open_container_page`);
    assert.match(content, /pageId/, `${rel} must document passing pageId for multi-account/parallel tabs`);
  }
});

test('prompts/AGENTS.md and prompts/CLAUDE.md document search_web(query, max_results, domain)', () => {
  assert.match(readRel('prompts/AGENTS.md'), /search_web\(query, max_results, domain\)/);
  assert.match(readRel('prompts/CLAUDE.md'), /search_web\(query, max_results, domain\)/);
});

test('TOOL_DEFINITIONS in reader-server exposes domain, max_results<=25, and JSON support', () => {
  const searchTool = TOOL_DEFINITIONS.find(t => t.name === 'search_web');
  const readTool = TOOL_DEFINITIONS.find(t => t.name === 'read_url_content');

  assert.ok(searchTool);
  assert.equal(searchTool.inputSchema.properties.domain.type, 'string');
  assert.equal(searchTool.inputSchema.properties.max_results.maximum, 25);

  assert.ok(readTool);
  assert.match(readTool.description, /JSON/);
});
