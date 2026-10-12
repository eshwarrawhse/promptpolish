const input = document.getElementById('key');
const saveBtn = document.getElementById('save');
const status = document.getElementById('status');
const customInput = document.getElementById('custom');
const saveCustomBtn = document.getElementById('save-custom');
const customStatus = document.getElementById('custom-status');

function showStatus(el, text, ok) {
  el.textContent = text;
  el.className = `status ${ok ? 'ok' : 'err'}`;
}

chrome.storage.local.get(['api_key', 'custom_prompt'], ({ api_key, custom_prompt }) => {
  if (api_key) {
    input.placeholder = '••••••••' + api_key.slice(-4);
  }
  if (custom_prompt) customInput.value = custom_prompt;
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

// Saving an empty prompt clears it, which greys out the custom button in the pill.
function saveCustom() {
  const prompt = customInput.value.trim();
  chrome.storage.local.set({ custom_prompt: prompt }, () => {
    if (chrome.runtime.lastError) {
      showStatus(customStatus, chrome.runtime.lastError.message, false);
      return;
    }
    showStatus(customStatus, prompt ? 'saved ✓' : 'cleared', true);
  });
}

saveBtn.addEventListener('click', save);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') save();
});
saveCustomBtn.addEventListener('click', saveCustom);
