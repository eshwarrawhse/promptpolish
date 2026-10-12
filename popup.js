const input = document.getElementById('key');
const saveBtn = document.getElementById('save');
const status = document.getElementById('status');

function showStatus(text, ok) {
  status.textContent = text;
  status.className = ok ? 'ok' : 'err';
}

chrome.storage.local.get('openai_key', ({ openai_key }) => {
  if (openai_key) {
    input.placeholder = '••••••••' + openai_key.slice(-4);
  }
});

function save() {
  const key = input.value.trim();
  if (!key.startsWith('sk-')) {
    showStatus('Key must start with "sk-"', false);
    return;
  }
  chrome.storage.local.set({ openai_key: key }, () => {
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
