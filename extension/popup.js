const statusEl = document.getElementById('hub-status');
const nameInput = document.getElementById('container-name');
const colorSelect = document.getElementById('container-color');
const createBtn = document.getElementById('btn-create');
const openBtn = document.getElementById('btn-open');
const convertBtn = document.getElementById('btn-convert');
const listEl = document.getElementById('containers-list');

const COLORS = ['blue', 'orange', 'green', 'purple', 'pink', 'cyan'];

function suggestNextContainerDefaults(containers = []) {
  const nextIdx = containers.length + 1;
  nameInput.value = `acc-${nextIdx}`;
  colorSelect.value = COLORS[(nextIdx - 1) % COLORS.length];
}

function renderState(state) {
  if (state?.connected) {
    statusEl.textContent = 'AI Hub Linked';
  } else {
    statusEl.textContent = 'Standalone Ready';
  }

  listEl.innerHTML = '';
  const containers = Array.isArray(state?.containers) ? state.containers : [];

  if (containers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'note';
    empty.textContent = 'No containers yet. Click "+ Save Container" or "+ New Container Tab" above.';
    listEl.appendChild(empty);
    return;
  }

  for (const c of containers) {
    const row = document.createElement('div');
    row.className = 'item';

    const left = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = `${c.badge || '🔵'} ${c.name}`;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = `${c.cookieCount || 0} cookies • ${c.activeTabs || 0} active tab(s)`;
    left.appendChild(title);
    left.appendChild(meta);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '4px';

    const tabBtn = document.createElement('button');
    tabBtn.textContent = '+ Tab';
    tabBtn.addEventListener('click', () => {
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

    const clearBtn = document.createElement('button');
    clearBtn.className = 'secondary';
    clearBtn.textContent = 'Clear';
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

    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = '×';
    delBtn.title = 'Delete container';
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

    actions.appendChild(tabBtn);
    actions.appendChild(clearBtn);
    actions.appendChild(delBtn);
    row.appendChild(left);
    row.appendChild(actions);
    listEl.appendChild(row);
  }
}

// Create & save container without opening a tab yet
createBtn.addEventListener('click', () => {
  const containerName = nameInput.value.trim() || 'acc-1';
  const color = colorSelect.value || 'blue';
  chrome.runtime.sendMessage(
    {
      type: 'popup_action',
      payload: {
        action: 'create_container_only',
        containerName,
        color
      }
    },
    res => {
      renderState(res || {});
      if (Array.isArray(res?.containers)) {
        suggestNextContainerDefaults(res.containers);
      }
    }
  );
});

// Create container & immediately open a new tab in it
openBtn.addEventListener('click', () => {
  const containerName = nameInput.value.trim() || 'acc-1';
  const color = colorSelect.value || 'blue';
  chrome.runtime.sendMessage(
    {
      type: 'popup_action',
      payload: {
        action: 'open_container_tab',
        containerName,
        color,
        url: 'about:blank'
      }
    },
    () => window.close()
  );
});

convertBtn.addEventListener('click', async () => {
  const containerName = nameInput.value.trim() || 'acc-1';
  const color = colorSelect.value || 'blue';
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
          color
        }
      },
      () => window.close()
    );
  }
});

chrome.runtime.sendMessage({ type: 'popup_get_state' }, res => {
  renderState(res || {});
  if (Array.isArray(res?.containers) && res.containers.length > 0) {
    suggestNextContainerDefaults(res.containers);
  }
});
