---
name: browser-automation
description: Dual-tier browser automation and web reading. Use read_url_content/search_web for lightweight fetching, and chrome-devtools (CDP) for dynamic SPAs, clicking, filling forms, screenshots, and console/network inspection.
---

# Browser Automation & Web Reading Skill

## Core Principles

1. **Tier 1 (Lightweight Reader)**:
   - `read_url_content`: Fast HTTP fetch converted to Markdown.
   - `search_web`: Fast web search via DuckDuckGo.

2. **Tier 2 (Real Browser CDP - `chrome-devtools`)**:
   - `navigate_page` / `new_page`: Open pages.
   - `wait_for`: Ensure content is rendered.
   - `take_snapshot`: Get Accessibility Tree with element `uid`s.
   - `click`, `fill`, `type_text`, `press_key`: Interact via `uid`.
   - `take_screenshot`: Capture visual verification.
   - `list_console_messages`: Detect JavaScript errors.
   - `list_network_requests`: Inspect network calls.
