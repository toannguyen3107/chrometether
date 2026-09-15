---
description: Browse web, automate Chrome, and test web apps using Chrome DevTools & Fast Reader
argument-hint: <URL or instructions>
skills: chrome-devtools
---

Use the Dual-Tier browsing system to handle this user request: $ARGUMENTS

Workflow Guidelines:
1. **Tier 1 (Fast Read / Search)**:
   - If the task is reading documentation, blogs, or searching the web, call `read_url_content` or `search_web`.
2. **Tier 2 (Real Browser Automation via Chrome DevTools)**:
   - If the task requires dynamic web interaction, clicking, form submission, UI inspection, or console error checks:
     a. Call `navigate_page` to load the target URL.
     b. Call `wait_for` if content renders dynamically.
     c. Call `take_snapshot` to retrieve the Accessibility Tree.
     d. Locate the target element's numeric `uid` (e.g. `[uid: 12] button "Submit"`).
     e. Interact using the `uid`: `click(uid)` or `fill(uid, value)`.
     f. Verify using `take_screenshot` or `list_console_messages`.

Task:
$ARGUMENTS
