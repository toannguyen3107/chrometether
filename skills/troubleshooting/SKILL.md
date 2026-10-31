---
name: troubleshooting
description: Uses Chrome DevTools MCP, ChromeTether Local CDP Hub diagnostics, and documentation to troubleshoot connection, container, and target issues. Trigger this skill when list_pages, new_page, open_container_page, or navigate_page fail, or when the server initialization fails.
---

## Troubleshooting Wizard

You are acting as a troubleshooting wizard to help the user configure and fix their ChromeTether Local CDP Hub and Chrome DevTools MCP server setup. When this skill is triggered (e.g., because `list_pages`, `new_page`, or `navigate_page` failed, or the server wouldn't start), follow this step-by-step diagnostic process:

### Step 1: Check ChromeTether Local CDP Hub & Extension Status

Before changing configuration files, check the health of the Local CDP Hub (`127.0.0.1:19222`):
1. Run `node bin/chrometether.js hub status` (or query `http://127.0.0.1:19222/health`).
2. Check the reported fields:
   - `running`: If stopped, start it with `node bin/chrometether.js hub start`.
   - `extensionConnected`: If `true`, the ChromeTether MV3 Companion Extension is connected over `ws://127.0.0.1:19222/ext` (zero permission prompts, full Multi-Account Container Tabs support).
   - If `extensionConnected` is `false`, ask the user to ensure the unpacked extension from `extension/` is loaded in `chrome://extensions` or that `chrome://inspect/#remote-debugging` is enabled for Phase 0 Direct-CDP fallback.

### Step 2: Find and Read Configuration

Locate and read the MCP configuration file. Search for `.mcp.json`, `gemini-extension.json`, `.claude/settings.json`, `.vscode/launch.json`, `.gemini/config/mcp_config.json`, or `.gemini/settings.json`.

Verify that:
- `chrome-devtools` (or `chrome_devtools`) launches `src/cdp-hub/launcher.js` (which automatically starts the Hub daemon and passes `--ws-endpoint=ws://127.0.0.1:19222/cdp` and `--ws-headers` with the Hub Bearer token).
- `tether-containers`, `tether-reader`, and `tether-map` are registered.

### Step 3: Triage Common Connection Errors

#### Error: `Could not find DevToolsActivePort`

This error occurs when using raw `--autoConnect` without the ChromeTether Companion Extension and without Chrome remote debugging enabled:

1. **Recommend loading the ChromeTether Companion Extension (`extension/`)** in `chrome://extensions` (Developer mode -> Load unpacked) so Chrome connects outbound to `ws://127.0.0.1:19222/ext` with zero prompts.
2. **Alternatively, if using Direct-CDP mode**, instruct the user: "Please open a new tab in Chrome, navigate to `chrome://inspect/#remote-debugging`, and make sure the 'Enable remote debugging' checkbox is checked."
3. **Once confirmed, call the `list_pages` tool** to verify the connection.

#### Symptom: Server starts but creates a new empty profile

If the server starts successfully but `list_pages` returns an empty list or creates a new profile instead of connecting to the existing Chrome instance, check for typos in the arguments (`--ws-endpoint` or `src/cdp-hub/launcher.js`).

#### Symptom: Missing Tools / Only 9 tools available

If the server starts successfully but only a limited subset of tools (like `list_pages`, `get_console_message`, `lighthouse_audit`, `take_memory_snapshot`) are available, this is likely because the MCP client is enforcing a **read-only mode**.

To access the full suite of tools, the user must disable read-only mode in their MCP client (e.g., by exiting "Plan Mode" in Gemini CLI or adjusting their client's tool safety settings).

#### Other Common Errors

Identify other error messages from the failed tool call or the MCP initialization logs:

- `Target closed`
- "Tool not found" (check if they are using `--slim` which only enables navigation and screenshot tools).
- `ProtocolError: Network.enable timed out` or `The socket connection was closed unexpectedly`
- `Error [ERR_MODULE_NOT_FOUND]: Cannot find module`
- Any sandboxing or host validation errors.

### Step 4: Run Diagnostic Commands

If the issue is still unclear, run diagnostic commands to test the toolkit directly:

- Run `node bin/chrometether.js test` to verify `tether-reader`, `tether-map`, `tether-containers`, and `chrome-devtools-mcp`.
- Run `node bin/chrometether.js hub status` to inspect Hub state.
- Run `node bin/chrometether.js containers list` to inspect the persistent Container Vault (`~/.chrometether/containers.json`).
