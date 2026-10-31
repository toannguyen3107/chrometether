// ChromeTether MV3 Background Service Worker
// Provides:
// 1. Outbound WebSocket bridge to Local CDP Hub (ws://127.0.0.1:19222/ext) with 20s keep-alive
//    (probes http://127.0.0.1:19222/health first so Chrome never logs WebSocket ERR_CONNECTION_REFUSED errors)
// 2. Same-window Multi-Account Container Tabs via chrome.tabGroups (works both with Hub and standalone)
// 3. Manifest V3 declarativeNetRequest (DNR) session rules keyed by tabIds (Cookie set + Set-Cookie strip)
// 4. Raw Set-Cookie capture via webRequest.onHeadersReceived (extraHeaders)
// 5. Fail-closed detach protection when chrome.debugger detaches unexpectedly

const HUB_HEALTH_URL = 'http://127.0.0.1:19222/health';
const HUB_WS_URL = 'ws://127.0.0.1:19222/ext';
const KEEPALIVE_INTERVAL_MS = 20000;

const COLOR_BADGES = {
  blue: '🔵',
  orange: '🟠',
  green: '🟢',
  purple: '🟣',
  pink: '🩷',
  cyan: '🩵',
  yellow: '🟡',
  red: '🔴',
  grey: '⚪'
};

let ws = null;
let isConnecting = false;
let reconnectTimer = null;
let keepAliveTimer = null;
let hubToken = null;
let knownContainers = [];

// tabId (number) -> { containerName, color, badge, initScript }
const tabContainers = new Map();
// Set of tabIds with active chrome.debugger attachment
const attachedTabs = new Set();

function buildDefaultInitScript(containerName) {
  const safeName = JSON.stringify(String(containerName || 'default'));
  return `(() => {
  if (window.__chrometetherContainerInitialized) return;
  Object.defineProperty(window, '__chrometetherContainerInitialized', { value: true, configurable: false });
  window.__chrometetherContainerName = ${safeName};
  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = () => Promise.reject(new DOMException('ServiceWorker disabled in ChromeTether Container Tab', 'SecurityError'));
    }
  } catch {}
})();`;
}

function ensureLocalContainerRecord(containerName, color = 'blue') {
  const cleanName = String(containerName || 'acc-1').trim();
  const badge = COLOR_BADGES[color] || '🔵';
  let found = knownContainers.find(c => c.name === cleanName);
  if (!found) {
    found = {
      name: cleanName,
      color: color || 'blue',
      badge,
      cookieCount: 0
    };
    knownContainers.push(found);
  } else if (color) {
    found.color = color;
    found.badge = badge;
  }
  return found;
}

async function restoreSessionState() {
  try {
    const data = await chrome.storage.session.get(['tabContainers', 'knownContainers']);
    if (Array.isArray(data?.knownContainers)) {
      knownContainers = data.knownContainers;
    }
    if (data?.tabContainers && typeof data.tabContainers === 'object') {
      for (const [k, v] of Object.entries(data.tabContainers)) {
        const tabId = Number(k);
        if (Number.isInteger(tabId) && v?.containerName) {
          tabContainers.set(tabId, v);
          ensureLocalContainerRecord(v.containerName, v.color);
        }
      }
    }
  } catch {
    // ignore
  }
}

async function persistSessionState() {
  try {
    const serialized = {};
    for (const [tabId, info] of tabContainers.entries()) {
      serialized[tabId] = info;
    }
    await chrome.storage.session.set({
      tabContainers: serialized,
      knownContainers
    });
  } catch {
    // ignore
  }
}

function sendToHub(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Update Manifest V3 declarativeNetRequest session rules for a specific tabId.
 * Rule IDs for `tabId` live in the range [tabId * 100, tabId * 100 + 99].
 */
async function updateTabDnrSessionRules(tabId, newRules = []) {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId) || numericTabId <= 0) return;

  const minId = numericTabId * 100;
  const maxId = minId + 99;

  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const removeRuleIds = existing
      .filter(r => r.id >= minId && r.id <= maxId)
      .map(r => r.id);

    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds,
      addRules: newRules
    });
  } catch (err) {
    console.warn('DNR updateSessionRules error for tab', numericTabId, err);
  }
}

async function clearTabDnrSessionRules(tabId) {
  await updateTabDnrSessionRules(tabId, []);
}

async function engageFailClosedDnrBlock(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId) || numericTabId <= 0) return;
  await updateTabDnrSessionRules(numericTabId, [
    {
      id: numericTabId * 100,
      priority: 1000,
      action: { type: 'block' },
      condition: {
        tabIds: [numericTabId],
        urlFilter: '*'
      }
    }
  ]);
}

async function ensureDebuggerAttached(tabId) {
  const numericTabId = Number(tabId);
  if (attachedTabs.has(numericTabId)) return true;
  try {
    await chrome.debugger.attach({ tabId: numericTabId }, '1.3');
    attachedTabs.add(numericTabId);
    return true;
  } catch (err) {
    if (String(err?.message || '').includes('Already attached')) {
      attachedTabs.add(numericTabId);
      return true;
    }
    return false;
  }
}

async function configureContainerDebuggerOnTab(tabId, containerInfo) {
  const numericTabId = Number(tabId);
  const ok = await ensureDebuggerAttached(numericTabId);
  if (!ok) {
    await engageFailClosedDnrBlock(numericTabId);
    return false;
  }

  const target = { tabId: numericTabId };
  try {
    await chrome.debugger.sendCommand(target, 'Network.enable', {});
    await chrome.debugger.sendCommand(target, 'Network.setCacheDisabled', {
      cacheDisabled: true
    });
    await chrome.debugger.sendCommand(target, 'Network.setBypassServiceWorker', {
      bypass: true
    });
    await chrome.debugger.sendCommand(target, 'Runtime.enable', {});
    await chrome.debugger.sendCommand(target, 'Runtime.addBinding', {
      name: '__chrometether_vault_sync'
    });
    await chrome.debugger.sendCommand(target, 'Page.enable', {});
    const scriptSource =
      containerInfo.initScript || buildDefaultInitScript(containerInfo.containerName);
    await chrome.debugger.sendCommand(target, 'Page.addScriptToEvaluateOnNewDocument', {
      source: scriptSource
    });
    // Auto-attach OOPIFs in flatten mode so cross-origin login frames remain isolated
    await chrome.debugger
      .sendCommand(target, 'Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true
      })
      .catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function placeTabInContainerGroup(
  tabId,
  windowId,
  containerName,
  color = 'blue',
  badge = '🔵'
) {
  try {
    const title = `${badge} ${containerName}`;
    const existingGroups = await chrome.tabGroups.query({ windowId, title });
    if (existingGroups && existingGroups.length > 0) {
      await chrome.tabs.group({ groupId: existingGroups[0].id, tabIds: [tabId] });
      return existingGroups[0].id;
    }
    const groupId = await chrome.tabs.group({
      createProperties: windowId ? { windowId } : undefined,
      tabIds: [tabId]
    });
    await chrome.tabGroups.update(groupId, {
      title,
      color: color || 'blue',
      collapsed: false
    });
    return groupId;
  } catch {
    return null;
  }
}

async function createContainerTabLocal({
  url = 'about:blank',
  background = false,
  containerName,
  color = 'blue',
  badge,
  initScript
}) {
  const effectiveBadge = badge || COLOR_BADGES[color] || '🔵';
  const created = await chrome.tabs.create({
    url: 'about:blank',
    active: !background
  });
  const tabId = created.id;

  if (containerName) {
    ensureLocalContainerRecord(containerName, color);
    const info = {
      containerName,
      color: color || 'blue',
      badge: effectiveBadge,
      initScript: initScript || buildDefaultInitScript(containerName)
    };
    tabContainers.set(tabId, info);
    await persistSessionState();
    await updateTabDnrSessionRules(tabId, [
      {
        id: tabId * 100 + 1,
        priority: 100,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [{ header: 'set-cookie', operation: 'remove' }]
        },
        condition: { tabIds: [tabId] }
      },
      {
        id: tabId * 100 + 2,
        priority: 150,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'cookie', operation: 'remove' }]
        },
        condition: { tabIds: [tabId] }
      }
    ]);
    await placeTabInContainerGroup(
      tabId,
      created.windowId,
      containerName,
      info.color,
      info.badge
    );
    await configureContainerDebuggerOnTab(tabId, info);
  }

  if (url && url !== 'about:blank') {
    await chrome.tabs.update(tabId, { url });
  }

  return {
    tabId,
    windowId: created.windowId,
    url,
    title: created.title || url
  };
}

async function convertTabToContainerLocal({
  tabId,
  containerName,
  color = 'blue',
  badge,
  initScript,
  dnrRules,
  originalUrl
}) {
  const numericTabId = Number(tabId);
  const tab = await chrome.tabs.get(numericTabId);
  const effectiveBadge = badge || COLOR_BADGES[color] || '🔵';
  ensureLocalContainerRecord(containerName, color);
  const info = {
    containerName,
    color: color || 'blue',
    badge: effectiveBadge,
    initScript: initScript || buildDefaultInitScript(containerName)
  };
  tabContainers.set(numericTabId, info);
  await persistSessionState();

  await chrome.tabs.update(numericTabId, { url: 'about:blank' });
  const rulesToApply = Array.isArray(dnrRules)
    ? dnrRules
    : [
        {
          id: numericTabId * 100 + 1,
          priority: 100,
          action: {
            type: 'modifyHeaders',
            responseHeaders: [{ header: 'set-cookie', operation: 'remove' }]
          },
          condition: { tabIds: [numericTabId] }
        },
        {
          id: numericTabId * 100 + 2,
          priority: 150,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'cookie', operation: 'remove' }]
          },
          condition: { tabIds: [numericTabId] }
        }
      ];
  await updateTabDnrSessionRules(numericTabId, rulesToApply);
  await placeTabInContainerGroup(
    numericTabId,
    tab.windowId,
    containerName,
    info.color,
    info.badge
  );
  await configureContainerDebuggerOnTab(numericTabId, info);
  if (originalUrl && originalUrl !== 'about:blank') {
    await chrome.tabs.update(numericTabId, { url: originalUrl });
  }
  return { ok: true, tabId: numericTabId };
}

async function sendTabsSnapshot() {
  try {
    const tabs = await chrome.tabs.query({});
    const payload = tabs.map(t => ({
      tabId: t.id,
      windowId: t.windowId,
      url: t.url || t.pendingUrl || 'about:blank',
      title: t.title || '',
      containerName: tabContainers.get(t.id)?.containerName || null
    }));
    sendToHub({ type: 'ext_tabs_snapshot', tabs: payload });
  } catch {
    // ignore
  }
}

async function handleHubRequest(msg) {
  const { reqId, action, params = {} } = msg;
  try {
    let result = {};

    if (action === 'create_tab') {
      result = await createContainerTabLocal(params);
    } else if (action === 'convert_tab_to_container') {
      result = await convertTabToContainerLocal(params);
    } else if (action === 'assign_tab_container') {
      const { tabId, containerName, color, badge, initScript, dnrRules } = params;
      const numericTabId = Number(tabId);
      const tab = await chrome.tabs.get(numericTabId);
      ensureLocalContainerRecord(containerName, color);
      const info = {
        containerName,
        color: color || 'blue',
        badge: badge || COLOR_BADGES[color] || '🔵',
        initScript: initScript || buildDefaultInitScript(containerName)
      };
      tabContainers.set(numericTabId, info);
      await persistSessionState();
      if (Array.isArray(dnrRules)) {
        await updateTabDnrSessionRules(numericTabId, dnrRules);
      }
      await placeTabInContainerGroup(
        numericTabId,
        tab.windowId,
        containerName,
        info.color,
        info.badge
      );
      await configureContainerDebuggerOnTab(numericTabId, info);
      result = { ok: true };
    } else if (action === 'update_tab_dnr_rules') {
      const { tabId, rules } = params;
      await updateTabDnrSessionRules(Number(tabId), Array.isArray(rules) ? rules : []);
      result = { ok: true };
    } else if (action === 'close_tab') {
      const numericTabId = Number(params.tabId);
      await clearTabDnrSessionRules(numericTabId);
      tabContainers.delete(numericTabId);
      await persistSessionState();
      await chrome.tabs.remove(numericTabId);
      result = { ok: true };
    } else if (action === 'activate_tab') {
      const numericTabId = Number(params.tabId);
      const tab = await chrome.tabs.update(numericTabId, { active: true });
      if (tab?.windowId) {
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      }
      result = { ok: true };
    } else if (action === 'cdp_command') {
      const numericTabId = Number(params.tabId);
      await ensureDebuggerAttached(numericTabId);
      result =
        (await chrome.debugger.sendCommand(
          { tabId: numericTabId },
          params.method,
          params.params || {}
        )) || {};
    }

    sendToHub({ type: 'hub_response', reqId, result });
  } catch (err) {
    sendToHub({
      type: 'hub_response',
      reqId,
      error: err?.message || String(err)
    });
  }
}

// Observe raw Set-Cookie headers on container tabs before DNR strips them from the default jar
chrome.webRequest.onHeadersReceived.addListener(
  details => {
    if (details.tabId <= 0 || !tabContainers.has(details.tabId)) return;
    const containerInfo = tabContainers.get(details.tabId);
    if (!containerInfo || !Array.isArray(details.responseHeaders)) return;

    const setCookies = details.responseHeaders
      .filter(h => h.name && h.name.toLowerCase() === 'set-cookie' && h.value)
      .map(h => h.value);

    if (setCookies.length > 0) {
      sendToHub({
        type: 'ext_set_cookie_captured',
        tabId: details.tabId,
        containerName: containerInfo.containerName,
        url: details.url,
        setCookieHeaders: setCookies
      });
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders']
);

// Inherit container when a container tab opens a child tab via window.open / target="_blank" (Fable 3.5)
chrome.tabs.onCreated.addListener(async tab => {
  if (tab.openerTabId && tabContainers.has(tab.openerTabId) && !tabContainers.has(tab.id)) {
    const parentInfo = tabContainers.get(tab.openerTabId);
    tabContainers.set(tab.id, { ...parentInfo });
    await persistSessionState();
    await placeTabInContainerGroup(
      tab.id,
      tab.windowId,
      parentInfo.containerName,
      parentInfo.color,
      parentInfo.badge
    );
    await configureContainerDebuggerOnTab(tab.id, parentInfo);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title || changeInfo.status === 'complete') {
    sendToHub({
      type: 'ext_tab_updated',
      tab: {
        tabId,
        windowId: tab.windowId,
        url: tab.url || 'about:blank',
        title: tab.title || '',
        containerName: tabContainers.get(tabId)?.containerName || null
      }
    });
  }
});

chrome.tabs.onRemoved.addListener(async tabId => {
  attachedTabs.delete(tabId);
  if (tabContainers.has(tabId)) {
    tabContainers.delete(tabId);
    await persistSessionState();
    await clearTabDnrSessionRules(tabId);
  }
  sendToHub({ type: 'ext_tab_removed', tabId });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId) {
    sendToHub({
      type: 'ext_cdp_event',
      tabId: source.tabId,
      method,
      params: params || {}
    });
  }
});

// Fail-closed detach handler (Fixes Fable H2 & H3)
chrome.debugger.onDetach.addListener(async (source, reason) => {
  if (!source.tabId) return;
  const tabId = source.tabId;
  attachedTabs.delete(tabId);

  if (tabContainers.has(tabId)) {
    const info = tabContainers.get(tabId);
    if (reason !== 'target_closed') {
      const reattached = await configureContainerDebuggerOnTab(tabId, info);
      if (!reattached) {
        await engageFailClosedDnrBlock(tabId);
        sendToHub({ type: 'ext_debugger_detached', tabId, reason });
      }
    }
  }
});

async function connectHub() {
  if (isConnecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  isConnecting = true;
  try {
    // Probe /health via fetch first so Chrome does not log red WebSocket connection errors when Hub is idle
    const healthResp = await fetch(HUB_HEALTH_URL, {
      method: 'GET',
      cache: 'no-store'
    });
    if (!healthResp.ok) {
      isConnecting = false;
      scheduleReconnect(4000);
      return;
    }
  } catch {
    isConnecting = false;
    scheduleReconnect(4000);
    return;
  }

  try {
    ws = hubToken
      ? new WebSocket(HUB_WS_URL, [`chrometether-token.${hubToken}`])
      : new WebSocket(HUB_WS_URL);
  } catch {
    isConnecting = false;
    scheduleReconnect(4000);
    return;
  }

  ws.onopen = async () => {
    isConnecting = false;
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = setInterval(() => {
      sendToHub({ type: 'ping', ts: Date.now() });
    }, KEEPALIVE_INTERVAL_MS);

    await restoreSessionState();
    await sendTabsSnapshot();
  };

  ws.onmessage = event => {
    try {
      const msg = JSON.parse(String(event.data));
      if (msg.type === 'hub_hello') {
        if (msg.token) hubToken = msg.token;
        if (Array.isArray(msg.containers)) {
          knownContainers = msg.containers;
          persistSessionState();
        }
        return;
      }
      if (msg.type === 'ping') {
        sendToHub({ type: 'pong', ts: Date.now() });
        return;
      }
      if (msg.type === 'hub_request') {
        handleHubRequest(msg);
      }
    } catch {
      // ignore
    }
  };

  ws.onclose = () => {
    isConnecting = false;
    ws = null;
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    scheduleReconnect(4000);
  };

  ws.onerror = () => {
    isConnecting = false;
    try {
      ws?.close();
    } catch {
      // ignore
    }
  };
}

function scheduleReconnect(delayMs = 4000) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectHub();
  }, delayMs);
}

// Handle messages from Extension Popup UI (works both when Hub is connected and standalone)
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'popup_get_state') {
    connectHub();
    sendResponse({
      connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
      containers: knownContainers,
      activeContainerTabsCount: tabContainers.size
    });
    return true;
  }
  if (msg?.type === 'popup_action') {
    const payload = msg.payload || {};
    if (ws && ws.readyState === WebSocket.OPEN) {
      const ok = sendToHub({ type: 'ext_popup_action', ...payload });
      sendResponse({ ok, mode: 'hub' });
      return true;
    }

    // Fallback to standalone execution inside the extension when Hub is idle
    (async () => {
      if (payload.action === 'open_container_tab') {
        await createContainerTabLocal({
          containerName: payload.containerName || 'acc-1',
          color: payload.color || 'blue',
          url: payload.url || 'about:blank',
          background: false
        });
      } else if (payload.action === 'convert_current_tab' && payload.tabId) {
        await convertTabToContainerLocal({
          tabId: payload.tabId,
          containerName: payload.containerName || 'acc-1',
          color: payload.color || 'blue',
          originalUrl: payload.url || 'about:blank'
        });
      } else if (payload.action === 'clear_container' && payload.containerName) {
        for (const [tabId, info] of tabContainers.entries()) {
          if (info.containerName === payload.containerName) {
            await clearTabDnrSessionRules(tabId);
          }
        }
      }
      sendResponse({ ok: true, mode: 'standalone' });
    })();
    return true;
  }
  return false;
});

chrome.alarms.create('chrometether-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'chrometether-keepalive') {
    connectHub();
  }
});

restoreSessionState().then(() => connectHub());
