// ChromeTether MV3 Background Service Worker
// Provides:
// 1. Outbound WebSocket bridge to Local CDP Hub (ws://127.0.0.1:19222/ext) with 20s keep-alive
// 2. Same-window Multi-Account Container Tabs via chrome.tabGroups
// 3. Manifest V3 declarativeNetRequest (DNR) session rules keyed by tabIds (Cookie set + Set-Cookie strip)
// 4. Raw Set-Cookie capture via webRequest.onHeadersReceived (extraHeaders)
// 5. Fail-closed detach protection when chrome.debugger detaches unexpectedly

const HUB_WS_URL = 'ws://127.0.0.1:19222/ext';
const KEEPALIVE_INTERVAL_MS = 20000;

let ws = null;
let reconnectTimer = null;
let keepAliveTimer = null;
let hubToken = null;
let knownContainers = [];

// tabId (number) -> { containerName, color, badge, initScript }
const tabContainers = new Map();
// Set of tabIds with active chrome.debugger attachment
const attachedTabs = new Set();

async function restoreSessionState() {
  try {
    const data = await chrome.storage.session.get(['tabContainers']);
    if (data?.tabContainers && typeof data.tabContainers === 'object') {
      for (const [k, v] of Object.entries(data.tabContainers)) {
        const tabId = Number(k);
        if (Number.isInteger(tabId) && v?.containerName) {
          tabContainers.set(tabId, v);
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
    await chrome.storage.session.set({ tabContainers: serialized });
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
    if (containerInfo.initScript) {
      await chrome.debugger.sendCommand(target, 'Page.addScriptToEvaluateOnNewDocument', {
        source: containerInfo.initScript
      });
    }
    // Auto-attach OOPIFs in flatten mode so cross-origin login frames remain isolated
    await chrome.debugger.sendCommand(target, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function placeTabInContainerGroup(tabId, windowId, containerName, color = 'blue', badge = '🔵') {
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
      const { url = 'about:blank', background = false, containerName, color, badge, initScript } = params;
      // Born at about:blank first so DNR rules + initScript are active before first navigation (Fable 3.2)
      const created = await chrome.tabs.create({
        url: 'about:blank',
        active: !background
      });
      const tabId = created.id;

      if (containerName) {
        const info = {
          containerName,
          color: color || 'blue',
          badge: badge || '🔵',
          initScript: initScript || ''
        };
        tabContainers.set(tabId, info);
        await persistSessionState();
        // Install baseline Set-Cookie strip + Cookie strip DNR rules immediately
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
        await placeTabInContainerGroup(tabId, created.windowId, containerName, info.color, info.badge);
        await configureContainerDebuggerOnTab(tabId, info);
      }

      if (url && url !== 'about:blank') {
        await chrome.tabs.update(tabId, { url });
      }

      result = {
        tabId,
        windowId: created.windowId,
        url,
        title: created.title || url
      };
    } else if (action === 'convert_tab_to_container') {
      // Safe conversion flow (Fable 3.2): navigate to about:blank -> attach & DNR -> reload originalUrl
      const { tabId, containerName, color, badge, initScript, dnrRules, originalUrl } = params;
      const numericTabId = Number(tabId);
      const tab = await chrome.tabs.get(numericTabId);
      const info = {
        containerName,
        color: color || 'blue',
        badge: badge || '🔵',
        initScript: initScript || ''
      };
      tabContainers.set(numericTabId, info);
      await persistSessionState();

      await chrome.tabs.update(numericTabId, { url: 'about:blank' });
      if (Array.isArray(dnrRules)) {
        await updateTabDnrSessionRules(numericTabId, dnrRules);
      }
      await placeTabInContainerGroup(numericTabId, tab.windowId, containerName, info.color, info.badge);
      await configureContainerDebuggerOnTab(numericTabId, info);
      if (originalUrl && originalUrl !== 'about:blank') {
        await chrome.tabs.update(numericTabId, { url: originalUrl });
      }
      result = { ok: true, tabId: numericTabId };
    } else if (action === 'assign_tab_container') {
      const { tabId, containerName, color, badge, initScript, dnrRules } = params;
      const numericTabId = Number(tabId);
      const tab = await chrome.tabs.get(numericTabId);
      const info = {
        containerName,
        color: color || 'blue',
        badge: badge || '🔵',
        initScript: initScript || ''
      };
      tabContainers.set(numericTabId, info);
      await persistSessionState();
      if (Array.isArray(dnrRules)) {
        await updateTabDnrSessionRules(numericTabId, dnrRules);
      }
      await placeTabInContainerGroup(numericTabId, tab.windowId, containerName, info.color, info.badge);
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
      result = (await chrome.debugger.sendCommand({ tabId: numericTabId }, params.method, params.params || {})) || {};
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
    // Try immediate re-attach unless the tab itself was closed
    if (reason !== 'target_closed') {
      const reattached = await configureContainerDebuggerOnTab(tabId, info);
      if (!reattached) {
        await engageFailClosedDnrBlock(tabId);
        sendToHub({ type: 'ext_debugger_detached', tabId, reason });
      }
    }
  }
});

function connectHub() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws = hubToken
      ? new WebSocket(HUB_WS_URL, [`chrometether-token.${hubToken}`])
      : new WebSocket(HUB_WS_URL);
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = async () => {
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
        if (Array.isArray(msg.containers)) knownContainers = msg.containers;
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
    ws = null;
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
    scheduleReconnect();
  };

  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      // ignore
    }
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectHub();
  }, 2000);
}

// Handle messages from Extension Popup UI
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'popup_get_state') {
    sendResponse({
      connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
      containers: knownContainers,
      activeContainerTabsCount: tabContainers.size
    });
    return true;
  }
  if (msg?.type === 'popup_action') {
    const ok = sendToHub({ type: 'ext_popup_action', ...msg.payload });
    sendResponse({ ok });
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
