const input = document.getElementById('key');
const saveBtn = document.getElementById('save');
const status = document.getElementById('status');
const learnToggle = document.getElementById('learn');
const styleCount = document.getElementById('style-count');
const clearStyleBtn = document.getElementById('clear-style');

function showStatus(el, text, ok) {
  el.textContent = text;
  el.className = `status ${ok ? 'ok' : 'err'}`;
}

chrome.storage.local.get('api_key', ({ api_key }) => {
  if (api_key) {
    input.placeholder = '••••••••' + api_key.slice(-4);
  }
});

function save() {
  const key = input.value.trim();
  if (!key) {
    showStatus(status, 'please enter an api key', false);
    return;
  }
  chrome.storage.local.set({ api_key: key }, () => {
    if (chrome.runtime.lastError) {
      showStatus(status, chrome.runtime.lastError.message, false);
      return;
    }
    input.value = '';
    input.placeholder = '••••••••' + key.slice(-4);
    showStatus(status, 'saved ✓', true);
  });
}

saveBtn.addEventListener('click', save);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') save();
});

// ---------- style memory (see styleProfile.js) ----------

async function refreshStyle() {
  const n = await StyleProfile.count();
  styleCount.textContent = n === 1 ? '1 example stored' : `${n} examples stored`;
  clearStyleBtn.disabled = n === 0;
}

if (!StyleProfile.config.AVAILABLE) {
  document.getElementById('style-section').hidden = true;
} else {
  StyleProfile.isEnabled().then((on) => { learnToggle.checked = on; });
  refreshStyle();
  learnToggle.addEventListener('change', () => StyleProfile.setEnabled(learnToggle.checked));
  clearStyleBtn.addEventListener('click', async () => {
    await StyleProfile.clear();
    refreshStyle();
  });
}
