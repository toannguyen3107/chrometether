---
name: chrome-devtools
description: Uses Chrome DevTools via MCP (routed through the ChromeTether Local CDP Hub) for efficient debugging, multi-account container tabs, troubleshooting, and browser automation. Use when debugging web pages, automating browser interactions, running isolated multi-account sessions, analyzing performance, or inspecting network requests. This skill does not apply to `--slim` mode (MCP configuration).
---

## Core Concepts

**Local CDP Hub & Zero-Prompt Lifecycle**: `chrome-devtools-mcp` connects through the persistent ChromeTether Local CDP Hub (`ws://127.0.0.1:19222/cdp`, auto-started by `src/cdp-hub/launcher.js`). Multiple AI agents share a single persistent bridge without triggering repeated *"Allow remote debugging?"* prompts.

**Same-Window Multi-Account Container Tabs (`tether-containers`)**:
- Use `list_containers()` to inspect existing persistent containers (including containers created manually in the ChromeTether extension popup) and their mapped `mcpIsolatedContextName` (`isolated-context-1`, `isolated-context-2`, ...).
- Use `open_container_page(container, url, background)` or `create_container(name, color)` + `new_page(url, background, isolatedContext)` (or append `#tether-container=acc-1` to `url`) to open isolated container tabs in the **same Chrome window**.
- Each container has its own isolated Cookie Vault (enforced via Manifest V3 `declarativeNetRequest` `tabIds` rules) and virtualized `localStorage`, `sessionStorage`, and `document.cookie`.

**Page selection & Parallel Execution**:
- Use `list_pages` to see available pages and their `pageId`.
- When running parallel tasks or working with background container tabs (`background: true`), ALWAYS pass `pageId` explicitly to `take_snapshot(pageId)`, `click(uid, pageId)`, `fill(uid, value, pageId)`, and `evaluate_script(function, args, pageId)` so parallel agents never steal tab focus from each other.

**Element interaction**: Use `take_snapshot` to get page structure with element `uid`s. Each element has a unique `uid` for interaction. If an element isn't found, take a fresh snapshot - the element may have been removed or the page changed.

## Workflow Patterns

### Before interacting with a page

1. Navigate: `navigate_page`, `new_page`, or `open_container_page`
2. Wait: `wait_for` to ensure content is loaded if you know what you look for.
3. Snapshot: `take_snapshot` (pass `pageId` when targeting a specific container tab)
4. Interact: Use element `uid`s from snapshot for `click`, `fill`, etc.

### Efficient data retrieval

- **Screenshots**: ALWAYS provide the `filePath` parameter for `take_screenshot`. Omitting `filePath` streams large Base64 strings across stdio IPC, which frequently triggers `Tool execution timed out after 30000ms`.
- Use `filePath` parameter for large outputs (screenshots, snapshots, traces)
- Use pagination (`pageIdx`, `pageSize`) and filtering (`types`) to minimize data
- Set `includeSnapshot: false` on input actions unless you need updated page state

### Tool selection

- **Automation/interaction**: `take_snapshot` (text-based, faster, better for automation)
- **Multi-account isolation**: `list_containers`, `create_container`, `open_container_page`, `clear_container`
- **Visual inspection**: `take_screenshot` (when user needs to see visual state)
- **Additional details**: `evaluate_script` for data not in accessibility tree

### Parallel execution

You can send multiple tool calls in parallel, but maintain correct order: navigate → wait → snapshot → interact. Always pass `pageId` when multiple tabs or containers are open.

## Troubleshooting

- **Error: `Tool execution timed out after 30000ms`**:
  1. Ensure you passed `filePath` when taking a screenshot.
  2. Verify Google Chrome is not minimized to the taskbar. On Windows, minimized windows suspend GPU rendering and CDP screenshot captures hang indefinitely.
  3. Ensure the page is not blocked by a native modal dialog (`alert()`, `confirm()`, `prompt()`) or pending reCAPTCHA challenge. Use `handle_dialog` if applicable.
- **Check Local CDP Hub & Extension Status**:
  - Run `node bin/chrometether.js hub status` (or check `http://127.0.0.1:19222/health`) to verify the Local CDP Hub daemon is running and whether the ChromeTether extension is connected (`extensionConnected: true`).
- If `chrome-devtools-mcp` is insufficient, guide users to use Chrome DevTools UI:
  - https://developer.chrome.com/docs/devtools
  - https://developer.chrome.com/docs/devtools/ai-assistance
- If there are errors launching `chrome-devtools-mcp` or Chrome, refer to https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md.
