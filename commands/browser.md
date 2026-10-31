---
description: Browse web, automate Chrome, manage multi-account container tabs, and test web apps using Chrome DevTools & Fast Reader
argument-hint: <URL or instructions>
skills: chrome-devtools
---

Use the Dual-Tier browsing system to handle this user request: $ARGUMENTS

Workflow Guidelines:
1. **Tier 1 (Fast Read / Search)**:
   - If the task is reading documentation, blogs, or searching the web, call `read_url_content` or `search_web`. Extremely fast (~150ms) with zero browser overhead.
2. **Tier 2 (Real Browser Automation via Chrome DevTools & Local CDP Hub)**:
   - If the task requires dynamic web interaction, clicking, form submission, UI inspection, or console error checks:
     a. Call `navigate_page(url)` or `new_page(url)` to load the target URL.
     b. For multi-account or isolated sessions in the same Chrome window, use `tether-containers` (`list_containers`, `create_container`, `open_container_page`) or `new_page(url, background, isolatedContext)` and pass `pageId` to subsequent tool calls.
     c. Call `wait_for(text)` if content renders dynamically (SPA/AJAX).
     d. Call `take_snapshot()` to retrieve the Accessibility Tree.
     e. Locate the target element's numeric `uid` (e.g. `[uid: 12] button "Submit"`).
     f. Interact using the `uid`: `click(uid)` or `fill(uid, value)`. Never guess CSS selectors or pixel coordinates.
     g. If page content changes or navigates, call `take_snapshot()` again to refresh `uid`s.
     h. Verify using `list_console_messages()` or `take_screenshot(filePath)`.
        > **CRITICAL**: When calling `take_screenshot`, ALWAYS pass the `filePath` parameter (e.g., to a temporary scratch path) to avoid 30s IPC buffer timeouts. Ensure Chrome is not minimized.

Task:
$ARGUMENTS
