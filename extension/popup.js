const statusPillEl = document.getElementById('hub-status');
const statusTextEl = document.getElementById('hub-status-text');
const activeTabHostEl = document.getElementById('active-tab-host');
const nameInput = document.getElementById('container-name');
const activeSwatchDot = document.getElementById('active-swatch-dot');
const swatchPicker = document.getElementById('swatch-picker');
const createBtn = document.getElementById('btn-create');
const openBtn = document.getElementById('btn-open');
const convertBtn = document.getElementById('btn-convert');
const listEl = document.getElementById('containers-list');
const countEl = document.getElementById('containers-count');
const activeTabsSummaryEl = document.getElementById('active-tabs-summary');

const COLORS = ['blue', 'orange', 'green', 'purple', 'pink', 'cyan'];
const COLOR_HEX = {
  blue: '#4c8eda',
  orange: '#e07a47',
  green: '#4daa7f',
  purple: '#9b72cf',
  pink: '#d96b98',
  cyan: '#45a5b5'
};

let selectedColor = 'blue';
let currentActiveTab = null;

function setSelectedColor(color) {
  selectedColor = COLOR_HEX[color] ? color : 'blue';
  activeSwatchDot.style.background = COLOR_HEX[selectedColor];
  for (const btn of swatchPicker.querySelectorAll('.swatch-btn')) {
    btn.classList.toggle('active', btn.dataset.color === selectedColor);
  }
}

swatchPicker.addEventListener('click', e => {
  const btn = e.target.closest('.swatch-btn');
  if (!btn || !btn.dataset.color) return;
  setSelectedColor(btn.dataset.color);
  nameInput.focus();
});

function suggestNextContainerDefaults(containers = []) {
  const existingNames = new Set(containers.map(c => c.name));
  let idx = containers.length + 1;
  while (existingNames.has(`acc-${idx}`)) {
    idx += 1;
  }
  nameInput.value = `acc-${idx}`;
  setSelectedColor(COLORS[(idx - 1) % COLORS.length]);
}

function createSvgIcon(pathsHtml) {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${pathsHtml}</svg>`;
  return tpl.content.firstChild;
}

function formatTabHost(url) {
  if (!url || url === 'about:blank' || url.startsWith('chrome://newtab')) {
    return 'New Tab (about:blank)';
  }
  try {
    const parsed = new URL(url);
    return parsed.host || url;
  } catch {
    return url;
  }
}

async function refreshActiveTabInfo() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentActiveTab = tab || null;
    if (tab) {
      activeTabHostEl.textContent = formatTabHost(tab.url || tab.pendingUrl);
      activeTabHostEl.title = tab.url || '';
    }
  } catch {
    // ignore
  }
}

function renderState(state) {
  const connected = Boolean(state?.connected);
  statusPillEl.classList.toggle('linked', connected);
  statusTextEl.textContent = connected ? 'MCP :19222' : 'LOCAL VAULT';

  const containers = Array.isArray(state?.containers) ? state.containers : [];
  countEl.textContent = String(containers.length);

  const totalActiveTabs = containers.reduce((sum, c) => sum + (c.activeTabs || 0), 0);
  activeTabsSummaryEl.textContent = `${totalActiveTabs} isolated ${totalActiveTabs === 1 ? 'tab' : 'tabs'}`;

  listEl.innerHTML = '';

  if (containers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'No containers in vault. Enter a name above to create acc-1.';
    listEl.appendChild(empty);
    return;
  }

  containers.forEach((c, idx) => {
    const card = document.createElement('div');
    card.className = 'container-card';

    const bar = document.createElement('span');
    bar.className = 'container-bar';
    bar.style.background = COLOR_HEX[c.color] || COLOR_HEX.blue;
    card.appendChild(bar);

    const main = document.createElement('div');
    main.className = 'container-main';
    main.title = `Open new tab in ${c.name}`;
    main.addEventListener('click', () => {
      chrome.runtime.sendMessage(
        {
          type: 'popup_action',
          payload: {
            action: 'open_container_tab',
            containerName: c.name,
            color: c.color,
            url: 'about:blank'
          }
        },
        () => window.close()
      );
    });

    const titleRow = document.createElement('div');
    titleRow.className = 'container-title-row';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'container-name';
    nameSpan.textContent = c.name;

    const ctxSpan = document.createElement('span');
    ctxSpan.className = 'container-ctx';
    ctxSpan.textContent = `ctx-${idx + 1}`;
    ctxSpan.title = `MCP isolatedContext: isolated-context-${idx + 1}`;

    titleRow.appendChild(nameSpan);
    titleRow.appendChild(ctxSpan);

    const meta = document.createElement('span');
    meta.className = 'container-meta';
    const cookieCount = c.cookieCount || 0;
    const tabCount = c.activeTabs || 0;
    meta.textContent = `${cookieCount} ${cookieCount === 1 ? 'cookie' : 'cookies'} · ${tabCount} ${tabCount === 1 ? 'tab' : 'tabs'}`;

    main.appendChild(titleRow);
    main.appendChild(meta);
    card.appendChild(main);

    const actions = document.createElement('div');
    actions.className = 'container-actions';

    // 1. Open new tab in this container
    const newTabBtn = document.createElement('button');
    newTabBtn.type = 'button';
    newTabBtn.className = 'icon-btn';
    newTabBtn.title = `New tab in ${c.name}`;
    newTabBtn.appendChild(createSvgIcon('<path d="M8 3.2v9.6M3.2 8h9.6"/>'));
    newTabBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage(
        {
          type: 'popup_action',
          payload: {
            action: 'open_container_tab',
            containerName: c.name,
            color: c.color,
            url: 'about:blank'
          }
        },
        () => window.close()
      );
    });

    // 2. Move current active tab into this container
    const assignTabBtn = document.createElement('button');
    assignTabBtn.type = 'button';
    assignTabBtn.className = 'icon-btn';
    assignTabBtn.title = `Assign current tab to ${c.name}`;
    assignTabBtn.appendChild(
      createSvgIcon('<path d="M3 8h7.5M8 5l3 3-3 3"/><path d="M10.5 3.5H12a1.5 1.5 0 0 1 1.5 1.5v6A1.5 1.5 0 0 1 12 12.5h-1.5"/>')
    );
    assignTabBtn.addEventListener('click', async () => {
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!activeTab?.id) return;
      chrome.runtime.sendMessage(
        {
          type: 'popup_action',
          payload: {
            action: 'convert_current_tab',
            tabId: activeTab.id,
            url: activeTab.url || 'about:blank',
            containerName: c.name,
            color: c.color
          }
        },
        () => window.close()
      );
    });

    // 3. Clear cookies & storage for this container
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'icon-btn';
    clearBtn.title = `Clear cookies & storage for ${c.name}`;
    clearBtn.appendChild(
      createSvgIcon('<path d="M2.8 8a5.2 5.2 0 1 0 1.4-3.6L2.5 6"/><path d="M2.5 2.8v3.2h3.2"/>')
    );
    clearBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage(
        {
          type: 'popup_action',
          payload: {
            action: 'clear_container',
            containerName: c.name
          }
        },
        res => renderState(res || {})
      );
    });

    // 4. Delete container
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon-btn danger';
    delBtn.title = `Delete container ${c.name}`;
    delBtn.appendChild(createSvgIcon('<path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/>'));
    delBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage(
        {
          type: 'popup_action',
          payload: {
            action: 'delete_container',
            containerName: c.name
          }
        },
        res => renderState(res || {})
      );
    });

    actions.appendChild(newTabBtn);
    actions.appendChild(assignTabBtn);
    actions.appendChild(clearBtn);
    actions.appendChild(delBtn);
    card.appendChild(actions);

    listEl.appendChild(card);
  });
}

function handleSaveContainerOnly() {
  const containerName = nameInput.value.trim() || 'acc-1';
  chrome.runtime.sendMessage(
    {
      type: 'popup_action',
      payload: {
        action: 'create_container_only',
        containerName,
        color: selectedColor
      }
    },
    res => {
      renderState(res || {});
      if (Array.isArray(res?.containers)) {
        suggestNextContainerDefaults(res.containers);
      }
    }
  );
}

function handleOpenContainerTab() {
  const containerName = nameInput.value.trim() || 'acc-1';
  chrome.runtime.sendMessage(
    {
      type: 'popup_action',
      payload: {
        action: 'open_container_tab',
        containerName,
        color: selectedColor,
        url: 'about:blank'
      }
    },
    () => window.close()
  );
}

createBtn.addEventListener('click', handleSaveContainerOnly);
openBtn.addEventListener('click', handleOpenContainerTab);

nameInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) {
      handleSaveContainerOnly();
    } else {
      handleOpenContainerTab();
    }
  }
});

convertBtn.addEventListener('click', async () => {
  const containerName = nameInput.value.trim() || 'acc-1';
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id) {
    chrome.runtime.sendMessage(
      {
        type: 'popup_action',
        payload: {
          action: 'convert_current_tab',
          tabId: activeTab.id,
          url: activeTab.url || 'about:blank',
          containerName,
          color: selectedColor
        }
      },
      () => window.close()
    );
  }
});

refreshActiveTabInfo();
chrome.runtime.sendMessage({ type: 'popup_get_state' }, res => {
  renderState(res || {});
  if (Array.isArray(res?.containers) && res.containers.length > 0) {
    suggestNextContainerDefaults(res.containers);
  } else {
    setSelectedColor('blue');
  }
});
