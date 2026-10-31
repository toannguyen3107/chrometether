const statusEl = document.getElementById('hub-status');
const nameInput = document.getElementById('container-name');
const colorSelect = document.getElementById('container-color');
const openBtn = document.getElementById('btn-open');
const convertBtn = document.getElementById('btn-convert');
const listEl = document.getElementById('containers-list');

function renderState(state) {
  if (state?.connected) {
    statusEl.textContent = 'Hub Connected';
    statusEl.classList.add('connected');
  } else {
    statusEl.textContent = 'Hub Offline';
    statusEl.classList.remove('connected');
  }

  listEl.innerHTML = '';
  const containers = Array.isArray(state?.containers) ? state.containers : [];
  for (const c of containers) {
    const row = document.createElement('div');
    row.className = 'item';

    const label = document.createElement('span');
    label.textContent = `${c.badge || '🔵'} ${c.name} (${c.cookieCount || 0} cookies)`;

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '4px';

    const tabBtn = document.createElement('button');
    tabBtn.textContent = 'Open';
    tabBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'popup_action',
        payload: {
          action: 'open_container_tab',
          containerName: c.name,
          color: c.color,
          url: 'about:blank'
        }
      });
      window.close();
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'secondary';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({
        type: 'popup_action',
        payload: {
          action: 'clear_container',
          containerName: c.name
        }
      });
    });

    actions.appendChild(tabBtn);
    actions.appendChild(clearBtn);
    row.appendChild(label);
    row.appendChild(actions);
    listEl.appendChild(row);
  }
}

openBtn.addEventListener('click', () => {
  const containerName = nameInput.value.trim() || 'acc-1';
  const color = colorSelect.value || 'blue';
  chrome.runtime.sendMessage({
    type: 'popup_action',
    payload: {
      action: 'open_container_tab',
      containerName,
      color,
      url: 'about:blank'
    }
  });
  window.close();
});

convertBtn.addEventListener('click', async () => {
  const containerName = nameInput.value.trim() || 'acc-1';
  const color = colorSelect.value || 'blue';
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id) {
    chrome.runtime.sendMessage({
      type: 'popup_action',
      payload: {
        action: 'convert_current_tab',
        tabId: activeTab.id,
        url: activeTab.url || 'about:blank',
        containerName,
        color
      }
    });
    window.close();
  }
});

chrome.runtime.sendMessage({ type: 'popup_get_state' }, res => {
  renderState(res || {});
});
