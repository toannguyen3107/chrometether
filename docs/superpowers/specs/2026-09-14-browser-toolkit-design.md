# Universal Agent Browser Toolkit (`agy-browser`) Design Spec

**Date:** 2026-09-14  
**Target Repository:** `d:\Tools\agy_browser`  
**Status:** Approved by User  

---

## 1. Overview & Objective

The objective is to package a production-grade, dual-tier web browsing and browser automation toolkit (`agy-browser`) that can be seamlessly plugged into any modern AI agent platform, including:
- **Anthropic Claude Desktop**
- **Anthropic Claude Code CLI**
- **Cursor IDE**
- **Windsurf IDE (Codeium Cascade)**
- **VS Code Extensions (Roo Code, Cline, Continue)**
- **OpenAI Codex / OpenCode / Custom Agent Frameworks**
- **Google Antigravity / Gemini CLI**

---

## 2. Architecture & Core Concepts

### A. Dual-Tier Workflow (Đọc nhanh & Trình duyệt thật)

| Tier | Engine / Tools | Mechanism | Best Used For |
| :--- | :--- | :--- | :--- |
| **Tier 1: Fast Reader** | `read_url_content`, `search_web` | Lightweight HTTP GET + Cheerio/Readability + Turndown Markdown conversion + DuckDuckGo search. Runs in ~150ms with 0MB browser RAM. | Reading documentation, GitHub issues/READMEs, static articles, quick internet search. |
| **Tier 2: Real Browser (CDP)** | `chrome-devtools-mcp` (Official Google Chrome DevTools Team) | Connects to Google Chrome via Chrome DevTools Protocol. Accessibility Tree (`take_snapshot`) with element `uid`, `click`, `fill`, `wait_for`, `take_screenshot`, `list_console_messages`, `list_network_requests`. | SPAs (React, Next.js, Vue), authentication, form submission, E2E testing, UI inspection, console/network debugging. |

### B. Element Identification via Accessibility Tree (`uid`)
Instead of raw, token-heavy HTML or inaccurate coordinate-based clicks, `chrome-devtools-mcp` outputs an Accessibility Tree snapshot where every interactive element is assigned an immutable numeric `uid` for that snapshot:
```
[uid: 10] Link "Documentation"
[uid: 14] Input (Search)
[uid: 17] Button "Submit"
```
The AI agent interacts deterministically using:
- `fill(uid=14, value="react state")`
- `click(uid=17)`

### C. Chrome Execution & Profile Modes
1. **Managed Visible Browser (Default)**:
   - Launches Chrome with `headless: false` so the user can watch the AI agent interact in real time and solve CAPTCHAs/logins manually if needed.
   - Uses a persistent user data profile in `%USERPROFILE%\.cache\agy-browser\chrome-profile` to preserve cookies and login sessions across restarts.
2. **Auto-Connect to Running Chrome**:
   - Supports connecting to an already running Chrome via `--auto-connect` or `--browserUrl http://127.0.0.1:9222`.

---

## 3. Directory Layout

```
d:\Tools\agy_browser\
├── package.json
├── bin\
│   ├── agy-browser.js              # Universal CLI orchestrator
│   └── test-connection.js          # Health check & diagnostics
├── src\
│   ├── reader-server\              # Tier 1 MCP Server (fetch & search)
│   │   ├── index.js
│   │   ├── fetch-markdown.js
│   │   └── search-ddg.js
│   ├── installer\                  # Safe JSON merge & agent discovery
│   │   ├── agent-detector.js
│   │   ├── config-merger.js
│   │   └── paths.js
├── configs\                        # Reference presets
│   ├── claude_desktop_config.json
│   ├── cursor_mcp.json
│   ├── windsurf_mcp.json
│   └── cline_mcp.json
├── prompts\                        # System prompts & rules for agents
│   ├── CLAUDE.md                   # Instructions for Claude Desktop / Claude Code
│   ├── AGENTS.md                   # Instructions for Codex / OpenCode
│   ├── .cursorrules                # Instructions for Cursor
│   ├── .cursor/rules/browser.mdc   # Modern Cursor MDC format
│   ├── .windsurfrules              # Instructions for Windsurf
│   └── SKILL.md                    # Antigravity skill specification
├── scripts\
│   ├── setup.ps1                   # 1-click Windows PowerShell installer
│   └── setup.sh                    # 1-click Bash installer for Linux/macOS
└── README.md                       # Comprehensive documentation
```

---

## 4. Agent Configurations & Paths

1. **Claude Desktop**:
   - Path (Windows): `%APPDATA%\Claude\claude_desktop_config.json`
   - Config format: standard `mcpServers` JSON.
2. **Claude Code CLI**:
   - Command: `claude mcp add --scope user chrome-devtools -- ...`
   - Config file: `~/.claude.json`.
3. **Cursor**:
   - Project path: `.cursor/mcp.json`
   - Global path: `%USERPROFILE%\.cursor\mcp.json`
   - Rule file: `.cursor/rules/browser.mdc`
4. **Windsurf**:
   - Path: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`
   - Rule file: `.windsurfrules`
5. **Roo Code (VS Code)**:
   - Path: `%APPDATA%\Code\User\globalStorage\rooveterinaryinc.roo-cline\settings\cline_mcp_settings.json`
6. **Cline (VS Code)**:
   - Path: `%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev\settings\cline_mcp_settings.json`
7. **Codex / OpenCode**:
   - Project path: `AGENTS.md` in root.

---

## 5. Verification & Testing Strategy
- Automated unit test for Tier 1: fetch an example URL (`https://example.com`), verify clean Markdown output.
- Automated test for web search: search query, verify result format.
- Automated test for Tier 2: trigger `test-connection.js` which verifies `chrome-devtools-mcp` launches Chrome, loads `about:blank`, takes a snapshot, and closes cleanly.
