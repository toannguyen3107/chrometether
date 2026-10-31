---
name: browser-automation
description: Dual-tier browser automation, multi-account container tabs, and web reading. Use read_url_content/search_web for lightweight fetching, tether-containers for same-window multi-account isolation, and chrome-devtools (CDP Hub) for dynamic SPAs, clicking, filling forms, screenshots, and console/network inspection.
---

# Browser Automation & Web Reading Skill

## Core Principles

1. **Tier 1 (Lightweight Reader)**:
   - `read_url_content(url)`: Fast HTTP fetch converted to Markdown (or verbatim JSON/XML/plain text) with relative links resolved.
   - `search_web(query, max_results, domain)`: Fast organic web search via DuckDuckGo (with `domain` prioritization and Lite fallback).

2. **Tier 2 (Real Browser CDP - `chrome-devtools` via Local CDP Hub)**:
   - `navigate_page` / `new_page`: Open pages (supports `isolatedContext` and `background: true`).
   - `wait_for`: Ensure content is rendered.
   - `take_snapshot`: Get Accessibility Tree with element `uid`s.
   - `click`, `fill`, `type_text`, `press_key`: Interact via `uid`.
   - `take_screenshot(filePath)`: Capture visual verification — always pass `filePath` (avoids the 30s IPC timeout); keep Chrome unminimized.
   - `list_console_messages`: Detect JavaScript errors.
   - `list_network_requests`: Inspect network calls.

3. **Multi-Account Container Tabs (`tether-containers`)**:
   - `list_containers()`: List persistent containers (`acc-1`, `acc-2`, ...) and their `mcpIsolatedContextName` (`isolated-context-1`, `isolated-context-2`).
   - `create_container(name, color)` & `open_container_page(container, url, background)`: Open isolated container tabs in the same Chrome window.
   - Always pass `pageId` to `take_snapshot(pageId)`, `click(uid, pageId)`, `fill(uid, value, pageId)` when working with background or multi-account tabs.
