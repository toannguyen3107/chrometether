---
name: application-mapping
description: Build a local map of visited pages and observed network requests during authorized web application exploration.
---

# Application mapping

Use the `tether-map` MCP server alongside `chrome-devtools` when a user asks to explore an application or map its API surface.

1. Call `start_app_map` with the application's URL. Add any separate API origins to `allowed_origins` only when they are part of the requested application. Starting a map replaces the previous local map.
2. Navigate and interact with Chrome using the normal browser workflow. After visiting a page, call `record_app_page` with the actual page URL and title.
3. Call Chrome DevTools `list_network_requests({includePreservedRequests: true})` so requests remain visible across navigations, then pass observed request URL, method, status, and resource type to `record_app_requests`. Use the page where the requests occurred as `page_url`. Record batches of at most 200 requests. Do not pass request or response bodies, cookies, or authorization headers.
4. Call `get_app_map` to review the grouped endpoints, query parameter names, status codes, and pages where they were observed. Treat the map as observed coverage, not proof of a vulnerability.

The map server does not capture Chrome traffic automatically. It records the observations supplied by the agent. Its default local file is `~/.chrometether/app-map.json`; set `CHROMETETHER_MAP_FILE` before starting the server to choose a different file.
