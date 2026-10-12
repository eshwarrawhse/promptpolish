const input = document.getElementById('key');
const saveBtn = document.getElementById('save');
const status = document.getElementById('status');

function showStatus(text, ok) {
  status.textContent = text;
  status.className = ok ? 'ok' : 'err';
}

chrome.storage.local.get('api_key', ({ api_key }) => {
  if (api_key) {
    input.placeholder = '••••••••' + api_key.slice(-4);
  }
});

function save() {
  const key = input.value.trim();
  if (!key) {
    showStatus('Please enter an API key', false);
    return;
  }
  chrome.storage.local.set({ api_key: key }, () => {
    if (chrome.runtime.lastError) {
      showStatus(chrome.runtime.lastError.message, false);
      return;
    }
    input.value = '';
    input.placeholder = '••••••••' + key.slice(-4);
    showStatus('Saved ✓', true);
  });
}

saveBtn.addEventListener('click', save);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') save();
});
