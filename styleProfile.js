// ============================================================================
// styleProfile — on-device style learning for improve / tighten.
//
// Keeps a small rolling buffer of the developer's last few ACCEPTED rewrites per
// mode and turns them into a style anchor for the system prompt. Nothing here
// touches the network; everything lives in chrome.storage.local and old entries
// age out. Loaded by background.js (importScripts) and popup.html (<script>).
// ============================================================================

const STYLE_PROFILE_CONFIG = {
  // Master switch. false = never record, never inject (the popup toggle is hidden).
  AVAILABLE: true,
  // Modes that learn. touch up is mechanical and scope-check is a detector.
  MODES: ['improve', 'tighten'],
  // Accepted rewrites kept per mode; older ones drop off.
  BUFFER_SIZE: 5,
  // Long accepted prompts are clipped before storing so the anchor stays small.
  MAX_ENTRY_CHARS: 1200,
  STORAGE_KEY: 'style_profile',          // { improve: [entry], tighten: [entry] }
  ENABLED_KEY: 'style_learning_enabled'  // user toggle in the popup (default on)
};

const StyleProfile = (() => {
  const C = STYLE_PROFILE_CONFIG;
  const store = chrome.storage.local;

  async function isEnabled() {
    if (!C.AVAILABLE) return false;
    const { [C.ENABLED_KEY]: on } = await store.get(C.ENABLED_KEY);
    return on !== false;
  }

  async function setEnabled(on) {
    await store.set({ [C.ENABLED_KEY]: !!on });
  }

  async function load() {
    const { [C.STORAGE_KEY]: profile } = await store.get(C.STORAGE_KEY);
    return profile && typeof profile === 'object' ? profile : {};
  }

  // entry: { mode, text, site, at }
  async function record(mode, text, site) {
    if (!C.MODES.includes(mode) || !(await isEnabled())) return;
    const clean = (text || '').trim().slice(0, C.MAX_ENTRY_CHARS);
    if (!clean) return;
    const profile = await load();
    const list = (profile[mode] || []).filter((e) => e.text !== clean);
    list.push({ mode, text: clean, site: site || '', at: Date.now() });
    profile[mode] = list.slice(-C.BUFFER_SIZE);
    await store.set({ [C.STORAGE_KEY]: profile });
  }

  async function count() {
    const profile = await load();
    return C.MODES.reduce((n, m) => n + (profile[m] || []).length, 0);
  }

  async function clear() {
    await store.remove(C.STORAGE_KEY);
  }

  // Text appended to the system prompt, or '' when there is nothing to anchor on.
  async function buildAnchor(mode) {
    if (!C.MODES.includes(mode) || !(await isEnabled())) return '';
    const entries = (await load())[mode] || [];
    if (!entries.length) return '';
    const examples = entries.map((e) => e.text).join('\n---\n');
    return '\n\nRecent prompts this developer accepted (style reference only). Match their ' +
      'phrasing, length, casing and level of terseness. Do not copy their content, topics ' +
      `or file names.\n---\n${examples}\n---`;
  }

  return { config: C, isEnabled, setEnabled, record, count, clear, buildAnchor };
})();
