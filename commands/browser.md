---
description: Browse web, automate Chrome, and test web apps using Chrome DevTools & Fast Reader
argument-hint: <URL or instructions>
skills: chrome-devtools
---

Use the Dual-Tier browsing system to handle this user request: $ARGUMENTS

Workflow Guidelines:
1. **Tier 1 (Fast Read / Search)**:
   - If the task is reading documentation, blogs, or searching the web, call `read_url_content` or `search_web`. Extremely fast (~150ms) with zero browser overhead.
2. **Tier 2 (Real Browser Automation via Chrome DevTools)**:
   - If the task requires dynamic web interaction, clicking, form submission, UI inspection, or console error checks:
     a. Call `navigate_page(url)` to load the target URL.
     b. Call `wait_for(text)` if content renders dynamically (SPA/AJAX).
     c. Call `take_snapshot()` to retrieve the Accessibility Tree.
     d. Locate the target element's numeric `uid` (e.g. `[uid: 12] button "Submit"`).
     e. Interact using the `uid`: `click(uid)` or `fill(uid, value)`. Never guess CSS selectors or pixel coordinates.
     f. If page content changes or navigates, call `take_snapshot()` again to refresh `uid`s.
     g. Verify using `list_console_messages()` or `take_screenshot(filePath)`.
        > **CRITICAL**: When calling `take_screenshot`, ALWAYS pass the `filePath` parameter (e.g., to a temporary scratch path) to avoid 30s IPC buffer timeouts. Ensure Chrome is not minimized.

Task:
$ARGUMENTS
