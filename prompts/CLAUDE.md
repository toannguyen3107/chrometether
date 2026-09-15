# Web Browsing & Browser Automation Guidelines for Claude

When interacting with the web or automating browser actions, you have access to a powerful **Dual-Tier System**:

## Tier 1: Fast Reader (Lightweight HTTP)
Use these tools first when you only need to read content or search for links without JavaScript execution:
- **`read_url_content(url)`**: Fetches the page via HTTP GET and converts it to clean, readable Markdown. Best for documentation, API specs, blogs, and GitHub READMEs. Fast (100ms) and uses 0 MB browser memory.
- **`search_web(query, max_results)`**: Searches DuckDuckGo for relevant documentation and links.

## Tier 2: Real Browser (`chrome-devtools`)
Use the Chrome DevTools MCP tools when the page is a dynamic Single Page App (React, Next.js, Vue), requires clicking, filling forms, submitting data, checking console logs, or taking screenshots:

### Strict Automation Workflow:
1. **Navigate**: Call `navigate_page(url)` or `new_page(url)`.
2. **Wait**: Call `wait_for(text)` if waiting for dynamic content to render.
3. **Snapshot**: Call `take_snapshot()` to retrieve the **Accessibility Tree**.
4. **Target Element by `uid`**: In the snapshot, locate your target element and note its numeric `uid` (e.g., `[uid: 14] button "Submit"`).
5. **Interact**:
   - `click(uid)`: Click buttons, links, tabs.
   - `fill(uid, value)` or `fill_form(...)`: Input text into forms.
   - `press_key(key)`: Send keys like "Enter", "Tab", "Escape".
6. **Re-Snapshot When Needed**: If an action updates the DOM or navigates to a new URL, previous `uid`s become stale. Call `take_snapshot()` again to obtain fresh `uid`s.
7. **Verify**:
   - `take_screenshot()`: Capture visual state for UI inspection.
   - `list_console_messages()`: Verify no uncaught JavaScript errors or network failures.
   - `list_network_requests()`: Verify API responses (HTTP 200/404/500).
