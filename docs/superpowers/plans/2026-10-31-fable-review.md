# Technical Review: Multi-Account Container Tabs & "Allow remote debugging?" Bypass

| | |
|---|---|
| **Plan under review** | `docs/superpowers/plans/2026-10-31-multi-account-containers-plan.md` |
| **Reviewer** | Claude Fable 5.1 (Orca worker, task `task_16375f869c37`) |
| **Date** | 2026-10-31 |
| **Review type** | Read-only architecture review. No code was changed. |
| **Code examined** | `src/installer/config-merger.js`, `bin/chrometether.js`, `package.json`, `skills/troubleshooting/SKILL.md`, and the bundled `chrome-devtools-mcp@1.9.0` (`puppeteer-core@25.10.0`) in the main checkout's `node_modules`, to verify the exact CDP handshake the Hub must emulate. |

---

## 0. Verdict

**Part 1 (popup bypass): APPROVED WITH CHANGES.** A local Hub that owns the single approved browser connection is sound. Re-sequence it so the *approve-once CDP multiplexer over `DevToolsActivePort`* (listed in the plan only as a "fallback") becomes **Phase 0**, and the extension transport becomes Phase 1. Phase 0 alone removes the repeated "Allow remote debugging?" prompt for every MCP client restart, with low risk and no protocol emulation.

**Part 2 (Firefox-style container tabs in one window): NOT APPROVED AS WRITTEN.** The goal is achievable, but the plan has three defects that must be fixed in the design before implementation starts:

| ID | Severity | Finding |
|---|---|---|
| **B1** | Blocking | Capturing `Set-Cookie` at the CDP `Fetch` response stage **cannot** stop the cookie from being written to the user's default cookie jar. Chrome commits cookies in the network stack *before* the DevTools interceptor sees response headers (DevTools only applies `Set-Cookie` itself for `Fetch.fulfillRequest` mocks). A container login therefore overwrites the user's own session cookie for the same site. "Delete it afterwards" is racy and still logs the user out. |
| **B2** | Blocking | The `isolatedContext` name the AI passes to `new_page` **never crosses the CDP wire**. `chrome-devtools-mcp` keeps the name only in process memory and sends a bare `Target.createBrowserContext {}` followed by `Target.createTarget {browserContextId}`. The Hub cannot know that a new context should be the persistent container `acc-1`. The "virtual browserContextId == container name" mapping in the plan does not work for pre-existing containers. |
| **B3** | Blocking until verified | Injecting a `Cookie` header via `Fetch.continueRequest` at the request stage races with Chrome's own cookie attachment, which happens *after* interception in `URLRequestHttpJob`. Whether the explicit header is kept, replaced, or merged with default-jar cookies is not verified by the plan. If the jar wins, an `acc-1` tab silently sends the *default* account's cookies: the worst possible failure for this feature. Spike S1 (Section 4) is mandatory. |

The recommended fix for B1 and B3 is to move cookie **injection and stripping** off the `Fetch` domain and onto **`declarativeNetRequest` session rules scoped by `tabIds`** (Section 3.3). Those rules run in the network process at the webRequest stage, after cookies are attached and before `Set-Cookie` is committed, keep working while the service worker is asleep, and leave the `Fetch` domain free for `chrome-devtools-mcp` itself. CDP via `chrome.debugger` remains for command forwarding and storage virtualization.

Re-submit the plan after addressing B1–B3 and the High items (H1–H5). The rest of this document gives the evidence and concrete recommendations.

---

## 1. Findings index

| ID | Sev | Area | One-line summary | Section |
|---|---|---|---|---|
| B1 | Blocking | Cookie vault | Fetch response stage is too late to stop default-jar writes | 3.3 |
| B2 | Blocking | MCP compat | `isolatedContext` name is not observable by the Hub | 3.4 |
| B3 | Blocking (spike) | Cookie vault | Request-stage Cookie injection may be overwritten by jar cookies | 3.3, 4 |
| H1 | High | Hub/CDP | `chrome.debugger` allows one attachment per tab; Puppeteer needs ≥2 sessions per page, so the Hub must multiplex **and replay domain state** | 3.2 |
| H2 | High | UX/safety | "0 popup" is overstated: the debugger infobar still appears and its Cancel detaches silently; design must fail closed | 3.2 |
| H3 | High | MV3 | Service-worker termination drops all `chrome.debugger` sessions; keep-alive and fail-closed are required | 3.5 |
| H4 | High | Isolation | Service-worker-controlled requests, OOPIFs, WebSocket handshakes and the HTTP cache bypass tab-scoped Fetch isolation | 3.3 |
| H5 | High | Security | Unauthenticated `ws://127.0.0.1:19222` is reachable from any web page; token + Origin check needed; vault at rest holds live sessions | 3.6 |
| M1 | Medium | Hub/CDP | Virtual target model must reproduce the tab→page nesting and init barrier of puppeteer-core 25.10 exactly, or `puppeteer.connect` hangs | 3.1 |
| M2 | Medium | Cookie vault | Redirect hops, 3xx `Set-Cookie`, header-replace semantics, double-pause latency | 3.3 |
| M3 | Medium | Storage | Virtualization scope is narrower than "100%"; `window.open` race; "convert existing tab" is unsafe | 3.5 |
| M4 | Medium | Installer | Two sources of truth for launch args; `mergeMcpConfig` clobbers user keys; auto-approve keys are agent-specific; daemon spawn hygiene on Windows | 3.7 |
| L1 | Low | Tests | Plan tests are unit-only; needs a real-Chrome integration harness with an echo server | 5 |
| L2 | Low | Ops | Pin `chrome-devtools-mcp` exactly; atomic writes for `containers.json`; wording | 6 |

---

## 2. Part 1: bypassing "Allow remote debugging?"

### 2.1 What the current code does

`src/installer/config-merger.js:37-50` launches `chrome-devtools-mcp` with `--auto-connect`. In 1.9.0 that path (`build/src/browser.js`) resolves the stable channel's profile, reads `DevToolsActivePort`, and calls `puppeteer.connect({browserWSEndpoint})`. Chrome 144+ shows the "Allow remote debugging?" dialog for each new client connection. Every MCP server restart (every agent session) is a new client, hence the repeated prompt. `skills/troubleshooting/SKILL.md:33,73` already documents this friction.

### 2.2 Assessment of the two mechanisms in the plan

**(a) Extension → Hub transport.** Correct that `chrome.debugger` never triggers the remote-debugging dialog. But it is not "0 popup": Chrome shows the *"ChromeTether started debugging this browser"* infobar on attached tabs unless Chrome was started with `--silent-debugger-extension-api`, which the installer cannot add to the user's existing Chrome. Clicking the infobar's Cancel fires `chrome.debugger.onDetach` with reason `canceled_by_user`. The plan must (1) word this honestly, and (2) treat detach as a safety event (H2/H3).

**(b) Keep one approved `DevToolsActivePort` connection alive in the Hub.** This is the strongest part of the plan and is under-sold as a "fallback". A Hub that holds the one approved browser WebSocket and multiplexes N `chrome-devtools-mcp` clients onto it:

- needs **no protocol emulation**: Chrome handles per-session state; the Hub only namespaces `sessionId`s and message `id`s per client and replays `Target.targetCreated` / `Target.attachedToTarget` to each new client;
- gives real `Target.createBrowserContext` (still opens windows, as today);
- is approved once per Chrome run;
- is exactly what `--ws-endpoint=ws://127.0.0.1:19222/cdp` needs on the MCP side, and `--ws-headers` can carry an auth token (H5).

**Recommendation:** make (b) **Phase 0** and ship it first. Add (a) as Phase 1 for users who refuse `chrome://inspect`. Note `chrome-devtools-mcp@1.9.0` already ships a CLI "daemon" (`build/src/daemon/`) that holds a shared browser connection for its CLI tool. It is not reusable for MCP, but it is good prior art for pid-file and socket hygiene.

### 2.3 `--ws-endpoint` compatibility notes (verified in 1.9.0)

- `wsEndpoint` conflicts only with `browserUrl`; `channel` is ignored when `wsEndpoint` is set (`index.js` passes `channel` only when `autoConnect`).
- `--category-extensions` and `--category-pwa` are documented as unsupported with `wsEndpoint`/`autoConnect` until Chrome 149. Document this in `rules/AGENTS.md` so agents don't expect extension tools.
- The MCP connects lazily on the first tool call, so Hub startup latency is tolerable, but the launcher must still wait for the Hub's health endpoint before handing over, to avoid `Could not connect to Chrome` on the first tool call.

---

## 3. Part 2: container tabs

### 3.1 The exact handshake the Hub must emulate (M1)

Read from `puppeteer-core@25.10.0` as bundled in `chrome-devtools-mcp/build/src/third_party/index.js`:

1. **`Target.getBrowserContexts`** → `{ browserContextIds: string[] }`. Puppeteer creates a `CdpBrowserContext` per id plus the default one. Return the persistent containers here (see B2 for what the MCP then names them).
2. **`Browser.getVersion`** when `--allowed-url-pattern` is used (requires a parseable `product: "Chrome/NNN…"`, major ≥ 149). Return real values (fetch via the extension's `navigator.userAgentData` if `Browser.getVersion` is blocked through `chrome.debugger`).
3. **`Target.setDiscoverTargets { discover: true, filter: [{}] }`** → the Hub must emit **`Target.targetCreated` for every existing target before answering**. Each page target needs `browserContextId` (the container's virtual id, or the default context id for normal tabs), `type`, `url`, `title`, `attached`, `canAccessOpener`.
4. **`Target.setAutoAttach { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{type:'page', exclude:true}, {}] }`** on the browser connection. Note the filter: top-level `page` targets are **excluded**; Puppeteer expects **`tab` targets**. The Hub must emit `Target.attachedToTarget` for a target of `type: 'tab'` per Chrome tab, each with its own `sessionId`.
5. On each tab session Puppeteer sends `Target.setAutoAttach { filter: [{}] }` and `Runtime.runIfWaitingForDebugger`. The Hub must then emit `Target.attachedToTarget` **on the tab session** (the event's `sessionId` is the tab session) for the child `page` target, with `browserContextId` set.
6. **Init barrier:** `TargetManager.initialize()` resolves only when every `tab` target that passed the target filter has received its `page` child (`#targetsIdsForInit`). A tab the extension *cannot* attach to (another debugger attached, Chrome Web Store, `chrome-extension://` pages, discarded tabs) but whose URL passes `isAllowedUrl` would **hang `puppeteer.connect` forever**. The Hub must exclude such tabs from discovery or emit `Target.targetDestroyed` for them. `chrome://*` tabs are safe: Puppeteer's `targetFilter` rejects them before the barrier (`makeTargetFilter` → `isAllowedUrl`).
7. Per page session Puppeteer immediately sends: `Page.enable`, `Page.getFrameTree`, `Target.setAutoAttach` (OOPIF/worker children), `Runtime.enable`, `Network.enable`, `Performance.enable`, `Log.enable`, `Audits.enable`, `Page.setLifecycleEventsEnabled`, `Emulation.setFocusEmulationEnabled`, `Runtime.runIfWaitingForDebugger`.
8. **A second session per page:** `McpPage.#initDevToolsUniverseNoThrow` calls `pptrPage.createCDPSession()` → `Target.attachToTarget { targetId, flatten: true }` on the browser connection, and `emulate` opens a further "secondary session" for `Emulation.setCPUThrottlingRate`. The Hub must serve **at least two, often three, concurrent sessions for the same tab** (H1).
9. `new_page(url, isolatedContext)` → `Target.createBrowserContext {}` → `Target.createTarget { url: 'about:blank', browserContextId, background }` → wait for `targetCreated` + attached page → `Page.navigate`. Hub implementation: `chrome.tabs.create({ windowId: current, url: 'about:blank', active: !background })` → `chrome.debugger.attach` → install init scripts (`Page.addScriptToEvaluateOnNewDocument`) → `chrome.tabs.group` + `chrome.tabGroups.update` → emit the discovery/attach events → reply `{ targetId }`.
10. `close_page` → `Target.closeTarget` (and `Page.close` on the last page) → `chrome.tabs.remove` → emit `Target.detachedFromTarget` for every virtual session and `Target.targetDestroyed` for page and tab.
11. `select_page(bringToFront)` → `Target.activateTarget` → `chrome.tabs.update({active:true})` + `chrome.windows.update({focused:true})`. `resize_page` → `Browser.getWindowForTarget`, `Browser.getWindowBounds`, `Browser.setWindowBounds` (tolerates failure), then `Emulation.setDeviceMetricsOverride`. Emulate the `Browser.*` calls with `chrome.windows.*`; forward `Emulation.*`.
12. Keep `Target.targetInfoChanged` flowing from `chrome.tabs.onUpdated` (url/title) so `list_pages` shows current URLs.

**Action:** write this as a conformance checklist in the plan and add an automated test that connects the real `chrome-devtools-mcp@1.9.0` to the Hub and runs `list_pages`, `new_page(isolatedContext)`, `take_snapshot`, `evaluate_script`, `close_page`. Because the Hub emulates Puppeteer's *expectations*, pin `chrome-devtools-mcp` to an exact version in `package.json` (today `^1.9.0`) and bump deliberately.

### 3.2 `chrome.debugger` constraints (H1, H2)

- **One attachment per tab per extension.** A second `chrome.debugger.attach` on the same `tabId` fails. Puppeteer + MCP need 2–3 sessions per tab (3.1 step 8). The Hub must multiplex virtual sessions onto one real attachment. That is not just id rewriting: Chrome keeps **per-session domain state**. When a second session sends `Runtime.enable`, real Chrome replays `Runtime.executionContextCreated` for existing contexts to *that* session. If the Hub forwards `Runtime.enable` once and does not replay, the second session never learns the main-world context and every `evaluate_script` / `take_snapshot` on it **hangs**. The Hub needs per-target caches for `Runtime` contexts, `Page.frameTree`/`frameNavigated`, `Network.enable` ref-counting (a `disable` from one client must not disable the domain for another), and `Fetch.enable` pattern merging. Budget this as the single largest Hub component.
- **Infobar + `canceled_by_user`** (H2). Dismissing the infobar detaches *all* tabs for the extension. `onDetach` also fires for `target_closed`, `replaced_with_devtools`, and when the tab is **discarded by Memory Saver**. Every detach must be **fail-closed**: immediately re-attach, and if that fails, block the tab's network (a DNR `block` rule for that `tabId`) or navigate it to a "container paused" page. Never let a container tab keep browsing with the default jar.
- **Methods blocked through `chrome.debugger`.** Not every CDP method is available to extensions (notably parts of `Browser.*` and `Target.*`). Build a probe test that sends each method listed in 3.1 through `chrome.debugger.sendCommand` on the pinned Chrome version and record which must be emulated by the Hub (`Browser.getWindowForTarget`, `Browser.setWindowBounds`, `Target.*`) versus forwarded.
- **Attach before first navigation.** `Page.addScriptToEvaluateOnNewDocument` only protects documents created *after* it is installed. Container tabs must be born by the Hub as `about:blank`, attached, scripted, grouped, and only then navigated. The popup button "Đổi Tab hiện tại sang Container…" (convert the current tab) is unsafe as described: the current document has already run with the default jar and default `localStorage`. Implement it as: assign container → clear → navigate to `about:blank` → attach → reload the original URL. Say so in the UI.
- **Attach is per tab, not per frame.** Cross-origin iframes are separate targets; use `Target.setAutoAttach` on the real session (flatten mode is supported by `chrome.debugger` in current Chrome) and install the init script on each child session, or `document.cookie`/`localStorage` stay unvirtualized inside third-party iframes (embedded login widgets are exactly where this matters).

### 3.3 Cookie vault via `Fetch`: correctness analysis (B1, B3, H4, M2)

**Request stage.** At `Fetch.requestPaused` (Request stage) the `request.headers` do **not** contain the `Cookie` header; cookies are attached later by `URLRequestHttpJob` when the real request starts. `Fetch.continueRequest { headers }` *replaces the whole header set* (a common gotcha: all original headers must be re-sent). Whether an explicit `Cookie` header set here survives Chrome's subsequent cookie attachment (replaced, merged, or kept) is **not verified by the plan** and is version-dependent. This is B3 and spike S1 decides the design. If the jar wins when it has matching cookies, container tabs send the default account's cookies to the same site: account mixing with no error.

**Response stage.** `Set-Cookie` is committed to the profile cookie store inside the network stack **before** the DevTools interceptor observes the response headers. The only case where DevTools applies `Set-Cookie` itself is a `Fetch.fulfillRequest` mock, for which no real request ran. Consequently the plan's "bắt mọi header Set-Cookie trả về … xóa khỏi luồng chung để không bị rò rỉ sang Tab khác" cannot be implemented with `Fetch`. Concretely: the user is logged in as themselves on `site.com` in a normal tab; the AI logs in as `acc-1` in a container tab; the server's `Set-Cookie: sid=acc1` overwrites `sid=self` in the default jar. The user's own session is gone, *and* until the Hub's clean-up runs any request from any tab uses `acc1`. This is B1.

**Redirects (M2).** Most logins set cookies on a `302`. Capturing them needs the HeadersReceived stage (`Fetch.enable` patterns with `requestStage: 'Response'`, or `continueRequest { interceptResponse: true }`), so every request pauses twice and each pause is a round trip through the extension service worker. Cookie injection must also be recomputed per hop for the hop's domain. If the service worker is asleep or slow, every network request in every container tab stalls until Chrome detaches.

**Requests that never pass through the tab's `Fetch` interception (H4):**

- **Service-worker-controlled fetches** (Gmail, Twitter/X, most PWAs). These run in the site's service worker target, not the page, and carry `tabId = -1`. They go out with the default jar and write back to it. Mitigation: `Network.setBypassServiceWorker { bypass: true }` on container page sessions, and unregister the site's service worker inside container tabs.
- **OOPIF requests** unless the child targets are also attached and intercepted.
- **WebSocket handshakes**: verify whether `Fetch.requestPaused` fires for them on the pinned Chrome; historically it does not. Session cookies on `wss://` upgrades are common.
- **HTTP cache**: the cache is keyed by site, not by tab. A response cached while `acc-1` was logged in can be served verbatim to the `acc-2` tab (authenticated HTML/JSON leaking across accounts). Use `Network.setCacheDisabled { cacheDisabled: true }` on container sessions.
- **Prefetch/prerender** speculation-rule navigations are not reliably tab-attributed; disable network prediction and prerendering for container tabs.

**Recommended architecture for the cookie layer.** Use the MV3 **`declarativeNetRequest`** (DNR) API with **session rules** conditioned on `tabIds` (session scope is the only scope that allows `tabIds`):

| Concern | Primitive | Why it is correct |
|---|---|---|
| Inject container cookies | `modifyHeaders` → `requestHeaders: [{ header: 'cookie', operation: 'set', value }]` with `tabIds`, `requestDomains`, `urlFilter` (path/scheme), `domainType` (SameSite approximation), `resourceTypes` | Runs at the webRequest stage **after** Chrome attaches jar cookies, so `set` deterministically replaces them. Covers all frames, tab-attributed workers, and the `websocket` resource type. No service-worker round trip per request. |
| Prevent default-jar pollution | `modifyHeaders` → `responseHeaders: [{ header: 'set-cookie', operation: 'remove' }]` with `tabIds` | webRequest-stage header overrides are applied **before** `URLRequestHttpJob` saves cookies, which is why webRequest-based cookie blockers have always worked. Keeps working while the service worker sleeps. |
| Capture `Set-Cookie` into the vault | `webRequest.onHeadersReceived` (observe-only, `['responseHeaders', 'extraHeaders']`), **or** `Fetch` Response stage via `chrome.debugger` if one transport is preferred | The listener sees the original headers; the vault stores them with full RFC 6265 attributes and updates the DNR rule set. |
| `document.cookie`, `cookieStore`, `localStorage` | CDP `Page.addScriptToEvaluateOnNewDocument` via `chrome.debugger` | Unchanged from the plan. |

Trade-offs to record in the plan: dynamic + session rules are capped at 5000 per extension; cookie scoping becomes domain-level with path approximated by `urlFilter`; `Secure` is approximated by `urlFilter: "|https"`; `SameSite=Lax/Strict` by `domainType: 'firstParty'` plus `resourceTypes: ['main_frame']`; there is a small window between receiving `Set-Cookie` and `updateSessionRules` resolving where a racing request sends stale cookies. All are acceptable for agent tooling and far better than the `Fetch` design's failure modes. Keep `Fetch` for `chrome-devtools-mcp`'s own use (`--blocked-url-pattern`, request interception) so the Hub does not need to arbitrate two owners of `Fetch.requestPaused`.

Still required with DNR: `Network.setCacheDisabled`, `Network.setBypassServiceWorker`, a fail-closed `block` rule on detach, and spike S1 (to confirm `set` semantics for the `Cookie` header on the pinned Chrome).

### 3.4 `isolatedContext` naming (B2)

Verified in `McpContext.js`: `newPage(background, isolatedContextName)` looks the name up in a private `Map`, otherwise calls `browser.createBrowserContext()` (→ `Target.createBrowserContext {}` with no payload), stores `name → ctx` in memory, then `ctx.newPage()`. Contexts discovered from `Target.getBrowserContexts` that the MCP did not create are auto-named **`isolated-context-N`** in iteration order (`#getBrowserContextToNameMap`). The name is never sent over CDP.

Consequences for the plan:

- `new_page({ isolatedContext: 'acc-1' })` arrives at the Hub as an anonymous `createBrowserContext`. The Hub cannot bind it to the persistent `acc-1` vault.
- Persistent containers returned at connect time are shown to the AI as `isolated-context-1`, `isolated-context-2`, … not `acc-1`, `acc-2`.
- Each MCP restart would create new anonymous contexts if the agent keeps using `acc-1`.

Options, in order of preference:

1. **Deterministic exposure + a naming tool.** At connect, return containers in a stable order (creation order) so `isolated-context-1` is always the first persistent container, and ship a small `tether-containers` MCP (same pattern as `tether-map`) with `list_containers` (name ↔ `isolated-context-N` ↔ tab ids), `create_container(name)`, `rename_container`, `clear_container`. Document in `rules/AGENTS.md`: "call `list_containers`, then `new_page` with the `isolated-context-N` it reports". Anonymous contexts created via `new_page` map to a fresh persistent container named `ctx-<n>` that the agent can rename.
2. **URL-carried hint.** `new_page({ url: 'https://site/…#tether-container=acc-1' })` without `isolatedContext`: the Hub reads the fragment on `Page.navigate` and moves the tab into the container before the navigation proceeds (the tab is still `about:blank` at that point, step 9). Fragile against fragment stripping; acceptable as a secondary path.
3. **Upstream change** to `chrome-devtools-mcp` to pass the name through `Target.createBrowserContext` metadata. Not under this project's control; do not depend on it.

Whatever is chosen, the plan's statement that containers are "recognised naturally via `isolatedContext`" must be rewritten.

### 3.5 Storage virtualization and MV3 lifetime (M3, H3)

- **Scope honesty.** The plan promises "100% isolation". With cookies + `localStorage` + `document.cookie` virtualized, the following remain shared with the default profile: **IndexedDB** (Firebase Auth and many SPAs keep tokens here), **CacheStorage**, service-worker registrations, `BroadcastChannel`/`SharedWorker`, HTTP cache, HSTS, TLS session resumption, client certificates, the HTTP-auth credential cache, and `window.cookieStore`. State the real scope: *cookies, localStorage, document.cookie, cookieStore*; disable cache and service workers in container tabs; list IndexedDB virtualization as a later phase (feasible via the same init-script approach but much larger).
- **Synchronous getters.** `document.cookie` and `localStorage.getItem` are synchronous, so the vault snapshot must already be *inside the page* when the first script runs. Design: the init script is generated per container and embeds the current snapshot; updates are pushed with `Runtime.evaluate` on each frame; writes go to the Hub via `Runtime.addBinding`/`Runtime.bindingCalled`. Synthesize the cross-tab `storage` event for tabs of the same container. Strip `HttpOnly` cookies from what `document.cookie` returns.
- **`window.open` / `target=_blank` / middle-click.** The new tab starts loading before the extension can attach. Handle `chrome.tabs.onCreated` with `openerTabId` in a container: immediately redirect to `about:blank`, attach, script, then navigate to the original URL. Without this the first document of every popup runs un-virtualized.
- **MV3 service-worker lifetime (H3).** When the extension service worker is terminated, `chrome.debugger` sessions are detached. Keep-alive rules that apply: any extension API call resets the 30 s idle timer (Chrome 110+), and **WebSocket message activity** resets it (Chrome 116+). The Hub↔extension socket must therefore exchange a ping at least every ~25 s; an idle open socket is not enough. `chrome.alarms` (minimum 30 s) only *wakes* the worker; it cannot keep it alive and fires after detach has already happened. On wake, the worker must re-attach every container tab and re-install init scripts, with tabs fail-closed (DNR block) in between. Avoid any single awaited operation longer than 5 minutes in the worker.
- **Persistence.** `~/.chrometether/containers.json`: write atomically (temp file + rename), debounce, restrict permissions (0600 on POSIX; user-only ACL on Windows), prune expired and session cookies on load, cap size. It contains live authentication material (H5).

### 3.6 Security (H5)

- Browsers allow a WebSocket to `ws://127.0.0.1:19222` from **any origin**; there is no CORS for WebSockets. An unauthenticated Hub lets any web page the user visits drive their Chrome and read every container's cookies. Require a per-install random token: the MCP side passes it via `--ws-headers '{"Authorization":"Bearer …"}'` (supported in 1.9.0); the extension cannot set custom headers, so it sends the token in the first message or as the `Sec-WebSocket-Protocol` value. Reject any connection whose `Origin` header is `http(s)://…`; allow only `chrome-extension://<id>` and header-less Node clients.
- Auto-approving all `chrome-devtools` tools in agents (plan item 3) widens the blast radius; it is acceptable only together with the token and Origin checks above.
- Treat `containers.json` as a credential store (3.5).

### 3.7 Installer and CLI touch points (M4)

- **Two sources of truth.** `getChromeDevToolsLaunch` (`src/installer/config-merger.js:37-50`) is the canonical launch spec, but the `dsh` branch in `bin/chrometether.js:161-169` hard-codes the script path and `--auto-connect` inside a YAML string. Adding `--ws-endpoint`/`--ws-headers` in one place and not the other silently splits behaviour between agents. Refactor `dsh` to consume `getChromeDevToolsLaunch(...).args` first.
- **Config clobbering.** `mergeMcpConfig` assigns `targetMap[key] = val` (`config-merger.js:231`), replacing the whole server entry. If the plan adds `alwaysAllow`/`autoApprove` and a user has tuned `env`, `disabled`, or timeouts, re-running `install` wipes them. Shallow-merge known fields instead, and add a test.
- **Auto-approve keys are agent-specific** and today's `getBrowserMcpConfigs` emits none. Cline/Roo use `alwaysAllow`, Claude Code uses `permissions.allow` in `settings.json` (not the MCP block), Cursor has no per-server field, OpenCode uses its `permission` config. Enumerate per agent and verify each against current docs rather than adding one key everywhere.
- **Launcher hygiene** (`src/cdp-hub/launcher.js`). It runs inside the MCP's stdio process, so it must never write to stdout. Spawn the Hub `detached: true, stdio: 'ignore', windowsHide: true` and `unref()`; use the port bind as the singleton lock and a `/health` version handshake so an old Hub is replaced rather than reused; fail with a clear error if the port is held by a foreign process.
- **CLI additions** (`containers`, `hub`) are fine. Add `hub stop` and `hub status --json` for the troubleshooting skill.

---

## 4. Required spikes before implementation

| ID | Question | Pass criterion |
|---|---|---|
| **S1** | Does a `Cookie` header set via `Fetch.continueRequest`, and separately via a DNR `modifyHeaders set` rule, replace the jar cookies when the default jar also has cookies for that host? | A local echo server reports exactly the injected cookie line while the default jar holds `sid=default` for the same host, for `main_frame`, `xhr`, `fetch`, `websocket`, and a `302` hop. Run on the pinned Chrome stable. |
| **S2** | Does removing `Set-Cookie` with a DNR session rule (`tabIds`) prevent the cookie from being stored? Does `Fetch` Response-stage stripping prevent it? | After the response, `chrome.cookies.getAll` shows no new cookie for the DNR case; record the `Fetch` result to close B1 with evidence. |
| **S3** | Can the Hub serve two virtual sessions on one `chrome.debugger` attachment such that `page.evaluate` works on both after `Runtime.enable`? | `chrome-devtools-mcp@1.9.0` connected via `--ws-endpoint` completes `new_page` → `take_snapshot` → `evaluate_script` on a container tab without hanging; `list_pages` shows the tab under an isolated context. |
| **S4** | Which CDP methods from Section 3.1 are rejected by `chrome.debugger.sendCommand`? | A forward-vs-emulate table for the pinned Chrome. |
| **S5** | Service-worker lifetime: does a 25 s WebSocket ping keep `chrome.debugger` attached for ≥ 30 minutes idle? What happens on worker termination and on Memory Saver discard? | Attachment survives 30 min; detach events are observed and the fail-closed rule engages within 1 s. |

If S1 shows that `Fetch`-set `Cookie` headers lose to the jar *and* DNR `set` also loses, the per-tab container design is not implementable on current Chrome without a new window per context, and the plan should fall back to real `Target.createBrowserContext` contexts (Phase 0 already provides them).

---

## 5. Recommended phasing

1. **Phase 0 — Approve-once CDP multiplexer (ship first).** Hub holds the single `DevToolsActivePort` browser connection; N MCP clients via `--ws-endpoint` + token; `Target.*` discovery replay per client; health endpoint; launcher; installer switch from `--auto-connect` to the Hub endpoint behind a flag; `hub status/stop` CLI. Acceptance: two agents connect concurrently, one prompt per Chrome run, all existing tools pass.
2. **Phase 1 — Extension transport.** Same Hub, add the `/ext` WebSocket and `chrome.debugger` forwarding for users who refuse `chrome://inspect`. Deliver the session multiplexer with state replay (S3) and the conformance test from 3.1. Acceptance: the MCP tool suite passes over the extension path on normal tabs.
3. **Phase 2 — Containers.** DNR-based cookie layer (S1/S2), vault, tab groups, `localStorage`/`document.cookie`/`cookieStore` init script, cache and service workers disabled in container tabs, fail-closed detach handling, `tether-containers` MCP for naming (B2), popup UI. Acceptance: two container tabs logged into two accounts on the same site in one window; echo-server assertions prove zero default-jar writes and no cross-container cookie; the user's own session in a normal tab is untouched.
4. **Phase 3 — Breadth.** IndexedDB/CacheStorage virtualization, OOPIF init scripts, popup inheritance, import/export of containers.

Update `rules/AGENTS.md` and `prompts/AGENTS.md` only when Phase 2 lands, and describe the `list_containers` → `new_page` flow rather than bare `isolatedContext="acc-1"`.

---

## 6. Smaller notes

- Pin `chrome-devtools-mcp` exactly (`1.9.0`, not `^1.9.0`) once the Hub emulates its handshake; add the conformance test to `npm test`.
- Wording: replace "Bypass 100% Popup" and "Cô lập 100%" with precise statements (no remote-debugging dialog; infobar remains without `--silent-debugger-extension-api`; isolation scope as in 3.5). Over-promising here will produce user reports that look like security bugs.
- `containers.json`: atomic write, 0600, expiry pruning, size cap, and a `clear` path that also wipes DNR rules and virtualized storage for the container.
- Follow the repo convention of English in code examples and identifiers (commit `d64461b`).
- The mermaid diagram labels the Hub "Virtual CDP Router"; after Phase 0 it is a real multiplexer for the default context and a virtual browser only for containers. Reflect both modes in the diagram.

---

## 7. Summary for the plan author (Tóm tắt)

- **Phần 1 (bỏ popup):** duyệt, nhưng đổi thứ tự: làm **Hub multiplexer giữ 1 kết nối `DevToolsActivePort` đã được duyệt** trước (Phase 0), extension là Phase 1. Vẫn còn infobar "started debugging this browser"; bấm Cancel sẽ detach, nên phải thiết kế fail-closed.
- **Phần 2 (container tab):** chưa duyệt. Ba lỗi thiết kế phải sửa: (B1) chặn `Set-Cookie` bằng `Fetch` là quá muộn, cookie đã ghi vào jar mặc định và ghi đè phiên của người dùng; (B2) tên `isolatedContext` không bao giờ đi qua CDP nên Hub không biết context mới là `acc-1`; (B3) chèn `Cookie` ở `Fetch.continueRequest` có thể bị cookie jar mặc định ghi đè, cần spike S1.
- **Hướng sửa:** chuyển chèn/xoá cookie sang `declarativeNetRequest` session rules theo `tabIds`; dùng CDP chỉ để forward lệnh và ảo hoá `localStorage`/`document.cookie`; tắt cache và service worker trong tab container; thêm MCP `tether-containers` để đặt tên; thêm token + kiểm tra Origin cho Hub; ping WebSocket ≤ 25 s để giữ service worker MV3 sống.
