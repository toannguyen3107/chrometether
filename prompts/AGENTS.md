# Web Browsing & Browser Automation Guidelines for Agents (AGENTS.md)

This agent environment is equipped with a **Dual-Tier Web Browsing & Automation System**:

## Available Tool Tiers

### 1. Tier 1: Fast Reader (Lightweight HTTP)
Use these tools first when you need to read content or search the web without executing JavaScript:
* `read_url_content(url)`: Fetches an HTML page via HTTP GET and converts it to clean Markdown. Extremely fast (100–200ms) with zero browser overhead. Ideal for documentation, GitHub issues/READMEs, and static blogs.
* `search_web(query, max_results)`: Fast organic search using DuckDuckGo to discover URLs and documentation.

### 2. Tier 2: Real Browser (`chrome-devtools`)
Use the Chrome DevTools MCP tools when the target site is dynamic (React/Next.js/Vue), requires interaction (clicking, typing, login), or needs UI/console/network debugging.

## Browser Automation Rules & Workflow

1. **Navigation**:
   - Use `navigate_page(url)` or `new_page(url)` to open the target website.
2. **Synchronization**:
   - Use `wait_for(text)` if the page relies on client-side rendering (SPA) or AJAX loading.
3. **Accessibility Snapshot (Critical)**:
   - Call `take_snapshot()`.
   - The response is an **Accessibility Tree** containing interactive elements with unique numeric `uid`s (e.g. `[uid: 10] button "Log In"`).
4. **Targeted Interaction by `uid`**:
   - ALWAYS interact using the element's `uid`.
   - `click(uid)`: Click buttons, links, toggles.
   - `fill(uid, value)`: Type text into textboxes or textareas.
   - `press_key(key)`: Trigger keyboard events (Enter, Escape, Tab).
   - DO NOT hallucinate CSS selectors or attempt coordinate-based clicks unless specifically requested.
5. **State Invalidation**:
   - If an action changes the page content or navigates away, previous `uid`s become stale. Call `take_snapshot()` again to refresh `uid`s.
6. **Verification & Diagnostics**:
   - `take_screenshot()`: Verify visual UI changes.
   - `list_console_messages()`: Check for JavaScript errors or warnings.
   - `list_network_requests()`: Verify backend API request/response statuses.
