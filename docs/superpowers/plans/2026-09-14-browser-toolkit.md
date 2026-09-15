# Universal Agent Browser Toolkit (`agy-browser`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package a universal dual-tier web browsing toolkit (`agy-browser`) supporting Claude Desktop, Claude Code, Cursor, Windsurf, Roo Code, Cline, and OpenAI Codex.

**Architecture:** A dual-tier setup combining Google Chrome DevTools MCP (Accessibility Tree snapshots with `uid`, headed visible UI, persistent session) and a lightweight Node.js Reader MCP (`read_url_content`, `search_web`), orchestrated with a multi-agent safe config merger, prompt rule templates, and 1-click setup scripts.

**Tech Stack:** Node.js (v20+), `@modelcontextprotocol/sdk`, `chrome-devtools-mcp`, `cheerio`, `turndown`, PowerShell.

**Spec:** `docs/superpowers/specs/2026-09-14-browser-toolkit-design.md`

## Global Constraints
- Must run cleanly on Windows (PowerShell/cmd) and be cross-platform compatible.
- Safe JSON merging: never overwrite or delete user's existing MCP servers in config files.
- Chrome automation defaults to visible window (`headless: false`) and persistent user profile.
- All code formatted cleanly with zero unnecessary dependencies.

---

### Task 1: Initialize Project Structure & Dependencies

**Files:**
- Create: `package.json`
- Create: `.gitignore`

**Interfaces:**
- Produces: Project root package with npm scripts and core dependencies.

- [ ] **Step 1: Create package.json**
Define `agy-browser` package with dependencies: `@modelcontextprotocol/sdk`, `cheerio`, `turndown`, `chrome-devtools-mcp`.
- [ ] **Step 2: Run npm install**
Run `npm install` in `d:\Tools\agy_browser` and verify `node_modules` generated.
- [ ] **Step 3: Create .gitignore**
Ignore `node_modules`, `logs`, `.cache`, temporary test artifacts.

---

### Task 2: Build Tier 1 Lightweight Reader MCP Server

**Files:**
- Create: `src/reader-server/fetch-markdown.js`
- Create: `src/reader-server/search-ddg.js`
- Create: `src/reader-server/index.js`
- Create: `test/reader-test.js`

**Interfaces:**
- Produces:
  - `fetchMarkdown(url: string): Promise<{ title: string, content: string }>`
  - `searchDDG(query: string, maxResults?: number): Promise<Array<{ title: string, snippet: string, link: string }>>`
  - Standard stdio MCP Server exposing `read_url_content` and `search_web`.

- [ ] **Step 1: Write `fetch-markdown.js`**
Fetch HTML with standard Node `fetch`, clean scripts/styles with `cheerio`, convert article to clean Markdown with `turndown`.
- [ ] **Step 2: Write `search-ddg.js`**
Implement lightweight web search via DuckDuckGo HTML parser (no API key needed).
- [ ] **Step 3: Write `src/reader-server/index.js`**
MCP Server implementation exposing tools `read_url_content` and `search_web`.
- [ ] **Step 4: Write and run `test/reader-test.js`**
Verify `fetchMarkdown` fetches a test page and `searchDDG` returns search results.

---

### Task 3: Build Multi-Agent Config Merger & Discovery Engine

**Files:**
- Create: `src/installer/paths.js`
- Create: `src/installer/config-merger.js`
- Create: `src/installer/agent-detector.js`
- Create: `test/merger-test.js`

**Interfaces:**
- Produces:
  - `detectInstalledAgents(): Promise<Array<AgentInfo>>`
  - `mergeMcpConfig(targetFile: string, newServers: object): Promise<{ updated: boolean, backupFile: string }>`

- [ ] **Step 1: Write `paths.js`**
Define standard config paths across Windows, macOS, Linux for Claude Desktop, Claude Code, Cursor, Windsurf, Roo Code, Cline.
- [ ] **Step 2: Write `config-merger.js`**
Implement deep JSON merge for `mcpServers`, creating automatic timestamped `.bak` backup file before editing.
- [ ] **Step 3: Write `agent-detector.js`**
Check filesystem presence of config directories / executable binaries for each agent.
- [ ] **Step 4: Write and run `test/merger-test.js`**
Test merging into a mock JSON file and verify existing servers remain intact.

---

### Task 4: Generate Preset Configurations & Agent Rules / Prompts

**Files:**
- Create: `configs/claude_desktop_config.json`
- Create: `configs/cursor_mcp.json`
- Create: `configs/windsurf_mcp.json`
- Create: `configs/cline_mcp.json`
- Create: `prompts/CLAUDE.md`
- Create: `prompts/AGENTS.md`
- Create: `prompts/.cursorrules`
- Create: `prompts/.cursor/rules/browser.mdc`
- Create: `prompts/.windsurfrules`
- Create: `prompts/SKILL.md`

**Interfaces:**
- Produces: Production-ready configuration presets and AI system prompts teaching agents the 2-tier workflow and Accessibility Tree `uid` interaction.

- [ ] **Step 1: Write JSON configs in `configs/`**
- [ ] **Step 2: Write `prompts/CLAUDE.md` and `prompts/AGENTS.md`**
- [ ] **Step 3: Write Cursor and Windsurf rule files**
- [ ] **Step 4: Write `prompts/SKILL.md` for Antigravity / Gemini CLI**

---

### Task 5: Build CLI Orchestrator & 1-Click Setup Scripts

**Files:**
- Create: `bin/agy-browser.js`
- Create: `bin/test-connection.js`
- Create: `scripts/setup.ps1`
- Create: `scripts/setup.sh`

**Interfaces:**
- Produces:
  - `npx agy-browser install [agent]`
  - `npx agy-browser test`
  - `.\scripts\setup.ps1` (1-click Windows setup)

- [ ] **Step 1: Write `bin/test-connection.js`**
Script that tests both Reader MCP and launches Chrome to verify `chrome-devtools-mcp` connectivity.
- [ ] **Step 2: Write `bin/agy-browser.js`**
CLI interface supporting `install`, `status`, `test`, `start-reader`.
- [ ] **Step 3: Write `scripts/setup.ps1`**
PowerShell script with colorful interactive menu, automated agent detection, dependency install, and verification run.
- [ ] **Step 4: Write `scripts/setup.sh`**
Bash equivalent for Unix environments.

---

### Task 6: Documentation & End-to-End Verification

**Files:**
- Create: `README.md`
- Create: `README.vi.md`

- [ ] **Step 1: Write comprehensive README**
Document installation, architecture, supported agents, manual config snippets, and troubleshooting.
- [ ] **Step 2: Run End-to-End Test**
Execute `node bin/test-connection.js` and verify output.
