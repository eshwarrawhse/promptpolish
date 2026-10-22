(() => {
  const MIN_LENGTH = 10;
  // Selections longer than this ask for confirmation before calling the API.
  const LONG_TEXT_WORD_LIMIT = 500;
  const MODES = [
    { id: 'touchup', label: 'touch up' },
    { id: 'improve', label: 'improve' },
    { id: 'rewrite', label: 'rewrite' }
  ];
  const CUSTOM_MODE = { id: 'custom', label: 'custom' };
  const LONG_TEXT_WARN_MODES = ['touchup', 'improve', 'rewrite', 'custom'];
  const UNDO_WINDOW_MS = 5000;

  let pillHost = null;   // element in the page that hosts the pill's shadow root
  let pillRoot = null;   // shadow root (isolates pill styles from the site's CSS)
  let target = null;     // { type: 'field' | 'contenteditable', el, start, end, range, selRoot, text, rect }
  let loading = false;
  let dismissTimer = null;
  let customPrompt = '';   // mirrors chrome.storage.local.custom_prompt
  let lastRewrite = null;  // { element, type, originalValue, selectionStart, selectionEnd }
  let undoTimer = null;

  // ---------- Site gating ----------

  // On www.google.com only Google AI Mode counts; the normal search box is left alone.
  // AI Mode is a search results page with udm=50 (unofficial, may change). The URL is
  // checked at event time because Google switches modes without a full page load.
  function isActiveOnThisPage() {
    if (location.hostname !== 'www.google.com') return true;
    return new URLSearchParams(location.search).get('udm') === '50';
  }

  // ---------- Selection detection ----------

  const TEXT_INPUT_TYPES = ['text', 'search', 'url', 'email', 'tel', ''];

  // <textarea> and single-line text <input>s expose selection via selectionStart/End.
  function isTextField(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && TEXT_INPUT_TYPES.includes((el.getAttribute('type') || '').toLowerCase());
  }

  // document.activeElement stops at shadow hosts; follow open shadow roots down to the
  // element that actually has focus (custom-element inputs).
  function getDeepActiveElement() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  // Chrome scopes the selection inside shadow trees to the shadow root.
  function getSelectionFor(node) {
    const root = node && node.getRootNode ? node.getRootNode() : document;
    return (root !== document && typeof root.getSelection === 'function')
      ? root.getSelection()
      : window.getSelection();
  }

  function isEditable(el) {
    if (el.isContentEditable) return true;
    const attr = el.getAttribute('contenteditable');
    if (attr !== null && attr !== 'false') return true;
    // Custom editors sometimes mark the box with an ARIA role instead.
    return el.getAttribute('role') === 'textbox' && el.getAttribute('aria-readonly') !== 'true';
  }

  // Walk up the whole ancestor chain (Claude/ChatGPT nest the text many levels deep inside
  // the editor) and return the outermost editable element that contains the node.
  function getEditingHost(node) {
    let el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    let host = null;
    while (el) {
      if (isTextField(el)) return el;
      if (isEditable(el)) host = el;
      else if (host) break;
      el = el.parentElement;
    }
    return host;
  }

  // Returns a description of the current selection if it's inside an editable prompt input.
  function readSelection() {
    // Text fields don't expose their selection through getSelection() ranges, so check
    // the focused element first.
    const active = getDeepActiveElement();
    if (isTextField(active) && active.selectionStart !== active.selectionEnd) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      const text = active.value.slice(start, end);
      return {
        type: 'field',
        el: active,
        start,
        end,
        text,
        rect: getTextareaSelectionRect(active, start, end)
      };
    }

    const sel = getSelectionFor(active);
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const host = getEditingHost(sel.anchorNode);
    if (!host || isTextField(host) || !host.contains(sel.focusNode)) return null;

    const range = sel.getRangeAt(0);
    let rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) rect = host.getBoundingClientRect();
    return {
      type: 'contenteditable',
      el: host,
      range: range.cloneRange(),
      selRoot: host.getRootNode(),
      text: sel.toString(),
      rect
    };
  }

  // Approximate the on-screen rect of a text-field selection using a mirror div.
  function getTextareaSelectionRect(ta, start, end) {
    const taRect = ta.getBoundingClientRect();
    const style = getComputedStyle(ta);
    const mirror = document.createElement('div');
    const props = [
      'boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
      'textTransform', 'wordSpacing', 'textIndent', 'tabSize'
    ];
    props.forEach((p) => { mirror.style[p] = style[p]; });
    Object.assign(mirror.style, {
      position: 'fixed',
      top: `${taRect.top}px`,
      left: `${taRect.left}px`,
      visibility: 'hidden',
      // <input> is single-line; <textarea> wraps.
      whiteSpace: ta.tagName === 'INPUT' ? 'pre' : 'pre-wrap',
      wordWrap: 'break-word',
      overflow: 'hidden',
      borderStyle: 'solid'
    });
    mirror.textContent = ta.value.slice(0, start);
    const span = document.createElement('span');
    span.textContent = ta.value.slice(start, end) || '.';
    mirror.appendChild(span);
    document.body.appendChild(mirror);

    const first = span.getClientRects()[0] || span.getBoundingClientRect();
    const top = first.top - ta.scrollTop;
    const left = first.left - ta.scrollLeft;
    mirror.remove();

    // Clamp into the visible area of the textarea (the selection may be scrolled out of view).
    const clampedTop = Math.min(Math.max(top, taRect.top), taRect.bottom);
    const clampedLeft = Math.min(Math.max(left, taRect.left), taRect.right);
    return { top: clampedTop, left: clampedLeft, width: 0, height: first.height, bottom: clampedTop + first.height };
  }

  // ---------- Pill UI ----------

  const PILL_CSS = `
    :host { all: initial; }
    .wrap {
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: 'Space Grotesk', system-ui, -apple-system, sans-serif;
      text-transform: lowercase;
      user-select: none;
      animation: pp-fade-in 150ms ease-out;
    }
    @keyframes pp-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    .pill {
      display: flex;
      align-items: center;
      background: #FF8C00;
      color: #000;
      border-radius: 999px;
      padding: 6px 10px;
      box-shadow: 0 2px 12px rgba(255, 140, 0, 0.4);
    }
    button {
      background: none;
      border: none;
      border-right: 1px solid rgba(0, 0, 0, 0.18);
      color: #000;
      font-size: 12px;
      font-family: inherit;
      text-transform: lowercase;
      cursor: pointer;
      padding: 4px 8px;
      line-height: 1.2;
      border-radius: 6px;
      transition: background 120ms ease;
    }
    .pill button:last-child { border-right: none; }
    .pill button:hover { background: #E07B00; }
    button:disabled { cursor: default; opacity: 0.7; }
    .pill button:disabled:hover { background: none; }
    button.loading { display: inline-flex; align-items: center; justify-content: center; opacity: 1; }

    /* Custom mode: outlined, sits next to the solid pill. */
    .custom {
      position: relative;
      background: transparent;
      border: 1px solid #FF8C00;
      border-radius: 999px;
      color: #FF8C00;
      font-weight: 500;
      padding: 9px 16px;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      box-shadow: 0 2px 12px rgba(255, 140, 0, 0.25);
      transition: background 120ms ease;
    }
    .custom:hover { background: rgba(255, 140, 0, 0.12); }
    .custom.off {
      border-color: #777;
      color: #888;
      box-shadow: none;
      opacity: 0.6;
      cursor: not-allowed;
    }
    .custom.off:hover { background: transparent; }
    .star {
      position: absolute;
      line-height: 1;
      pointer-events: none;
    }
    /* Hand-placed, not a grid: two above, two below, offset and unevenly sized. */
    .star.s1 { top: 1px; left: 8px; font-size: 0.5em; }
    .star.s2 { top: -2px; left: 58%; font-size: 0.6em; }
    .star.s3 { bottom: 1px; left: 30%; font-size: 0.5em; }
    .star.s4 { bottom: 4px; right: 5px; font-size: 0.5em; }

    .spinner {
      width: 10px;
      height: 10px;
      border: 1.5px solid rgba(0, 0, 0, 0.25);
      border-top-color: #000;
      border-radius: 50%;
      animation: pp-spin 600ms linear infinite;
    }
    .custom .spinner {
      border-color: rgba(255, 140, 0, 0.3);
      border-top-color: #FF8C00;
    }
    @keyframes pp-spin {
      to { transform: rotate(360deg); }
    }
    .error {
      color: #7a0000;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 6px;
      max-width: 320px;
    }
    .done {
      font-size: 12px;
      font-weight: 600;
      padding: 2px 6px;
      white-space: nowrap;
    }

    /* Long-selection confirmation: dark card, orange accent. */
    .confirm {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: 280px;
      padding: 10px 12px;
      background: #1a1a1a;
      color: #eee;
      border: 1px solid #FF8C00;
      border-radius: 14px;
      box-shadow: 0 2px 12px rgba(255, 140, 0, 0.25);
      font-size: 12px;
      line-height: 1.4;
    }
    .confirm .actions { display: flex; justify-content: flex-end; gap: 6px; }
    .confirm button {
      border: 1px solid #444;
      border-radius: 999px;
      padding: 4px 12px;
    }
    .confirm .yes { background: #FF8C00; border-color: #FF8C00; color: #000; font-weight: 600; }
    .confirm .yes:hover { background: #E07B00; border-color: #E07B00; }
    .confirm .no { background: transparent; color: #aaa; }
    .confirm .no:hover { color: #fff; border-color: #777; }
  `;

  // ---------- Font + custom prompt ----------

  // Load Space Grotesk from the extension package. Using the bytes directly (instead of a
  // Google Fonts URL) means the site's Content-Security-Policy can't block it.
  let fontRequested = false;
  function loadFont() {
    if (fontRequested || !document.fonts) return;
    fontRequested = true;
    fetch(chrome.runtime.getURL('fonts/SpaceGrotesk-latin.woff2'))
      .then((r) => r.arrayBuffer())
      .then((buf) => new FontFace('Space Grotesk', buf, { weight: '300 700' }).load())
      .then((face) => document.fonts.add(face))
      .catch(() => { /* falls back to system-ui */ });
  }

  try {
    chrome.storage.local.get('custom_prompt', ({ custom_prompt }) => {
      customPrompt = (custom_prompt || '').trim();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.custom_prompt) {
        customPrompt = (changes.custom_prompt.newValue || '').trim();
        updateCustomButton();
      }
    });
  } catch (_) { /* extension context gone */ }

  function countWords(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  function showPill(rect, anchorEl) {
    removePill();

    pillHost = document.createElement('div');
    Object.assign(pillHost.style, {
      position: 'fixed',
      zIndex: '2147483647',
      top: '0px',
      left: '0px',
      inset: 'auto',
      margin: '0',
      padding: '0',
      border: '0',
      background: 'transparent',
      overflow: 'visible'
    });
    // A manual popover renders in the browser's top layer, so no site stacking context,
    // overflow:hidden container or z-index can cover or clip the pill.
    const usePopover = typeof pillHost.showPopover === 'function';
    if (usePopover) pillHost.popover = 'manual';
    pillRoot = pillHost.attachShadow({ mode: 'open' });

    loadFont();
    const style = document.createElement('style');
    style.textContent = PILL_CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    pillRoot.append(style, wrap);
    // Inside an open <dialog>, attach there; content outside a modal dialog is inert.
    const dialog = anchorEl && anchorEl.closest && anchorEl.closest('dialog[open]');
    (dialog || document.body || document.documentElement).appendChild(pillHost);
    if (usePopover) {
      try { pillHost.showPopover(); } catch (_) { /* not supported here; stays fixed-position */ }
    }

    renderButtons(wrap);
    positionPill(rect);
  }

  function makeButton(mode, className) {
    const btn = document.createElement('button');
    if (className) btn.className = className;
    btn.dataset.mode = mode.id;
    // Prevent the click from stealing focus / collapsing the selection in the input.
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (btn.classList.contains('off')) return;
      handleModeClick(mode.id, btn);
    });
    return btn;
  }

  function renderButtons(wrap) {
    wrap.textContent = '';
    const pill = document.createElement('div');
    pill.className = 'pill';
    MODES.forEach((mode) => {
      const btn = makeButton(mode);
      btn.textContent = mode.label;
      pill.appendChild(btn);
    });

    const custom = makeButton(CUSTOM_MODE, 'custom');
    ['s1', 's2', 's3', 's4'].forEach((cls) => {
      const star = document.createElement('span');
      star.className = `star ${cls}`;
      star.textContent = '✦';
      custom.appendChild(star);
    });
    custom.appendChild(document.createTextNode(CUSTOM_MODE.label));

    wrap.append(pill, custom);
    updateCustomButton();
  }

  // Grey out the custom button (but keep its tooltip working) when no prompt is saved.
  function updateCustomButton() {
    const btn = pillRoot && pillRoot.querySelector('.custom');
    if (!btn || btn.classList.contains('loading')) return;
    const off = !customPrompt;
    btn.classList.toggle('off', off);
    btn.setAttribute('aria-disabled', String(off));
    btn.title = off ? 'set a custom prompt in the extension settings' : customPrompt;
  }

  // Shown in place of the buttons when a long selection is sent to a warned mode.
  // Nothing is sent to the API until "continue" is clicked.
  function renderLongTextConfirm(mode) {
    const wrap = pillRoot.querySelector('.wrap');
    wrap.textContent = '';
    const label = [...MODES, CUSTOM_MODE].find((m) => m.id === mode)?.label || mode;

    const card = document.createElement('div');
    card.className = 'confirm';
    const msg = document.createElement('span');
    msg.textContent = `this is long — ${label} works best under ${LONG_TEXT_WORD_LIMIT} words. continue?`;
    const actions = document.createElement('div');
    actions.className = 'actions';

    const makeAction = (cls, text, onClick) => {
      const btn = document.createElement('button');
      btn.className = cls;
      btn.textContent = text;
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      });
      return btn;
    };
    const cancel = makeAction('no', 'cancel', () => {
      removePill();
      target = null;
    });
    const confirm = makeAction('yes', 'continue', () => {
      renderButtons(wrap);
      reposition();
      const btn = pillRoot.querySelector(`button[data-mode="${mode}"]`);
      handleModeClick(mode, btn, { confirmed: true });
    });

    actions.append(cancel, confirm);
    card.append(msg, actions);
    wrap.appendChild(card);
    reposition();
  }

  function positionPill(rect) {
    if (!pillHost) return;
    const pill = pillHost;
    const w = pill.offsetWidth;
    const h = pill.offsetHeight;
    const gap = 8;

    let top = rect.top - h - gap;
    if (top < 4) top = (rect.bottom ?? rect.top + rect.height) + gap; // no room above → show below
    let left = rect.left + (rect.width || 0) / 2 - w / 2;
    left = Math.max(4, Math.min(left, window.innerWidth - w - 4));

    pill.style.top = `${top}px`;
    pill.style.left = `${left}px`;
  }

  function removePill() {
    clearTimeout(dismissTimer);
    if (pillHost) pillHost.remove();
    pillHost = null;
    pillRoot = null;
    loading = false;
  }

  function setLoading(activeBtn) {
    loading = true;
    pillRoot.querySelectorAll('button').forEach((b) => {
      b.disabled = true;
      if (b !== activeBtn) return;
      // Lock the width so the pill doesn't shrink when the label is swapped for the spinner.
      b.style.width = `${b.offsetWidth}px`;
      b.classList.add('loading');
      b.textContent = '';
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      b.appendChild(spinner);
    });
  }

  // Replace the pill's contents with a single message line, then auto-dismiss.
  function showMessage(className, text, ms) {
    if (!pillRoot) return;
    loading = false;
    const wrap = pillRoot.querySelector('.wrap');
    wrap.textContent = '';
    const pill = document.createElement('div');
    pill.className = 'pill';
    wrap.appendChild(pill);
    const msg = document.createElement('span');
    msg.className = className;
    msg.textContent = text;
    pill.appendChild(msg);
    clearTimeout(dismissTimer);
    dismissTimer = setTimeout(removePill, ms);
  }

  function showError(message) {
    showMessage('error', message, 3000);
  }

  function showDone(tokens, mode) {
    const label = [...MODES, CUSTOM_MODE].find((m) => m.id === mode)?.label || mode;
    const count = Number.isFinite(tokens) ? `${tokens} tokens` : 'done';
    showMessage('done', `⚡ ${count} · ${label}`, 1500);
  }

  // ---------- Rewrite flow ----------

  function handleModeClick(mode, btn, { confirmed = false } = {}) {
    if (loading || !target) return;
    if (!confirmed && LONG_TEXT_WARN_MODES.includes(mode) && countWords(target.text) > LONG_TEXT_WORD_LIMIT) {
      renderLongTextConfirm(mode);
      return;
    }
    const job = target;
    setLoading(btn);

    let sent;
    try {
      sent = chrome.runtime.sendMessage({ action: 'rewrite', text: job.text, mode });
    } catch (err) {
      showError('extension was reloaded — refresh this page.');
      return;
    }

    sent
      .then((res) => {
        if (!pillHost) return; // dismissed meanwhile
        if (!res) return showError('no response from polishd.');
        if (res.error) return showError(res.error);
        const ok = replaceSelection(job, res.result);
        if (!ok) return showError('could not replace text — the input changed.');
        target = null;
        flashSuccess(job.el);
        showDone(res.tokens, mode);
      })
      .catch((err) => showError(err?.message || 'something went wrong.'));
  }

  // Briefly outline the input so the user sees the replacement happened.
  function flashSuccess(el) {
    const prev = {
      outline: el.style.getPropertyValue('outline'),
      outlinePriority: el.style.getPropertyPriority('outline'),
      offset: el.style.getPropertyValue('outline-offset'),
      transition: el.style.getPropertyValue('transition')
    };
    el.style.setProperty('transition', 'outline-color 150ms ease');
    el.style.setProperty('outline', '2px solid #FF8C00', 'important');
    el.style.setProperty('outline-offset', '2px');
    setTimeout(() => {
      el.style.setProperty('outline', prev.outline, prev.outlinePriority);
      el.style.setProperty('outline-offset', prev.offset);
      el.style.setProperty('transition', prev.transition);
    }, 200);
  }

  // Selection text, innerText and raw text nodes disagree on line breaks between
  // paragraphs, so text is compared with all whitespace removed.
  const squash = (str) => str.replace(/\s+/g, '');

  // Some sites (Google AI Mode) re-render their input while the API call is in flight.
  // If the element we captured is gone, find the live input that still holds the text.
  function findLiveInput(job) {
    if (job.el.isConnected) return job.el;
    const holdsText = (el) => squash(isTextField(el) ? el.value : el.innerText || '').includes(squash(job.text));
    const active = getDeepActiveElement();
    const activeHost = active && (isTextField(active) ? active : getEditingHost(active));
    if (activeHost && holdsText(activeHost)) return activeHost;
    const label = job.el.getAttribute('aria-label');
    const selector = label
      ? `${job.el.tagName.toLowerCase()}[aria-label="${CSS.escape(label)}"]`
      : job.el.tagName.toLowerCase();
    return [...document.querySelectorAll(selector)].find(holdsText) || null;
  }

  // Build a range covering `text` inside `host` (used when the saved range went stale).
  // Matches on non-whitespace characters so paragraph breaks don't matter.
  function findTextRange(host, text) {
    const needle = squash(text);
    if (!needle) return null;
    const chars = [];   // { node, offset } for every non-whitespace character, in order
    let hay = '';
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      for (let i = 0; i < n.data.length; i++) {
        if (/\s/.test(n.data[i])) continue;
        chars.push({ node: n, offset: i });
        hay += n.data[i];
      }
    }
    const idx = hay.indexOf(needle);
    if (idx === -1) return null;
    const first = chars[idx];
    const last = chars[idx + needle.length - 1];
    const range = document.createRange();
    range.setStart(first.node, first.offset);
    range.setEnd(last.node, last.offset + 1);
    return range;
  }

  function replaceSelection(job, newText) {
    const el = findLiveInput(job);
    if (!el) return false;
    if (el !== job.el) {
      job = { ...job, el, range: null, selRoot: el.getRootNode() };
    }
    const snapshot = {
      element: job.el,
      type: job.type,
      originalValue: job.type === 'field' ? job.el.value : job.el.innerText,
      selectionStart: job.type === 'field' ? job.start : null,
      selectionEnd: job.type === 'field' ? job.end : null
    };
    const ok = job.type === 'field'
      ? replaceInTextarea(job, newText)
      : replaceInContentEditable(job, newText);
    if (ok) armUndo(snapshot);
    return ok;
  }

  // ---------- Undo (Ctrl/Cmd+Z within 5s restores the original text) ----------

  function armUndo(snapshot) {
    clearUndo();
    lastRewrite = snapshot;
    window.addEventListener('keydown', onUndoKey, true);
    // Typing after the rewrite means the user has moved on; let normal undo handle it.
    snapshot.element.addEventListener('beforeinput', clearUndo, { once: true });
    undoTimer = setTimeout(clearUndo, UNDO_WINDOW_MS);
  }

  function clearUndo() {
    clearTimeout(undoTimer);
    window.removeEventListener('keydown', onUndoKey, true);
    if (lastRewrite) lastRewrite.element.removeEventListener('beforeinput', clearUndo);
    lastRewrite = null;
  }

  function onUndoKey(e) {
    const isUndo = (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z';
    if (!isUndo || !lastRewrite) return;
    const snap = lastRewrite;
    clearUndo();
    if (!snap.element.isConnected) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    restoreOriginal(snap);
  }

  function restoreOriginal(snap) {
    const el = snap.element;
    el.focus();
    if (snap.type === 'field') {
      el.select();
      let ok = false;
      try {
        ok = document.execCommand('insertText', false, snap.originalValue) && el.value === snap.originalValue;
      } catch (_) { ok = false; }
      if (!ok) setNativeValue(el, snap.originalValue);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.setSelectionRange(snap.selectionStart, snap.selectionEnd);
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = getSelectionFor(el);
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand('insertText', false, snap.originalValue); } catch (_) { ok = false; }
    if (!ok) {
      console.warn('[polishd] execCommand unavailable; restoring text directly.');
      el.innerText = snap.originalValue;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: snap.originalValue }));
    }
  }

  // Assign through the prototype's setter so React-style value trackers see the change.
  function setNativeValue(el, value) {
    const proto = el.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }

  // Handles <textarea> and text <input>.
  function replaceInTextarea(job, newText) {
    const ta = job.el;
    let { start, end } = job;
    // If the text shifted while we waited, locate the original selection again.
    if (ta.value.slice(start, end) !== job.text) {
      const idx = ta.value.indexOf(job.text);
      if (idx === -1) return false;
      start = idx;
      end = idx + job.text.length;
    }

    const expected = ta.value.slice(0, start) + newText + ta.value.slice(end);

    // execCommand goes through the browser's editing pipeline, so Ctrl+Z can undo it.
    ta.focus();
    ta.setSelectionRange(start, end);
    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, newText) && ta.value === expected;
    } catch (_) {
      inserted = false;
    }

    if (!inserted) {
      console.warn('[polishd] execCommand unavailable; replacing value directly (Ctrl+Z will not undo this).');
      setNativeValue(ta, expected);
      const caret = start + newText.length;
      ta.setSelectionRange(caret, caret);
    }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }

  function replaceInContentEditable(job, newText) {
    const el = job.el;
    // The saved range is stale if the editor re-rendered its nodes; re-find the text.
    let range = job.range;
    const rangeLive = range && !range.collapsed
      && range.startContainer.isConnected && range.endContainer.isConnected
      && el.contains(range.startContainer) && el.contains(range.endContainer)
      && squash(range.toString()) === squash(job.text);
    if (!rangeLive) range = findTextRange(el, job.text);
    if (!range) return false;

    el.focus();
    const sel = getSelectionFor(el);
    sel.removeAllRanges();
    sel.addRange(range);

    // execCommand fires real (trusted) beforeinput/input events, which is what editors
    // like ProseMirror and Google's input handlers listen to.
    let ok = false;
    try { ok = document.execCommand('insertText', false, newText); } catch (_) { ok = false; }
    if (ok) return true;

    // Fallback: announce the edit with beforeinput (an editor may apply it itself and
    // cancel the event), otherwise mutate the DOM and follow up with input.
    console.warn('[polishd] execCommand unavailable; replacing text directly (Ctrl+Z will not undo this).');
    const handled = !el.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, composed: true, inputType: 'insertReplacementText', data: newText
    }));
    if (!handled) {
      const r = sel.getRangeAt(0);
      r.deleteContents();
      r.insertNode(document.createTextNode(newText));
      r.collapse(false);
    }
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true, composed: true, inputType: 'insertReplacementText', data: newText
    }));
    return true;
  }

  // ---------- Event wiring ----------

  function isInsidePill(e) {
    return pillHost && e.composedPath().includes(pillHost);
  }

  function evaluateSelection() {
    if (loading) return;
    if (!isActiveOnThisPage()) {
      removePill();
      target = null;
      return;
    }
    const info = readSelection();
    if (!info || info.text.trim().length <= MIN_LENGTH) {
      removePill();
      target = null;
      return;
    }
    target = info;
    showPill(info.rect, info.el);
  }

  // Run after the browser and the site's editor have finalized the selection (clicking
  // inside an existing selection collapses it only after mouseup).
  let evaluateTimer = null;
  function scheduleEvaluate() {
    clearTimeout(evaluateTimer);
    evaluateTimer = setTimeout(evaluateSelection, 50);
  }

  // Listen for both: if a site calls preventDefault() on pointerdown, the browser never
  // fires mouseup, but pointerup still arrives.
  function onPointerUp(e) {
    if (isInsidePill(e)) return;
    scheduleEvaluate();
  }
  window.addEventListener('mouseup', onPointerUp, true);
  window.addEventListener('pointerup', onPointerUp, true);

  // Keyboard selections (Shift+arrows, Ctrl/Cmd+A) count as new selections too.
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' || e.shiftKey || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')) {
      scheduleEvaluate();
    }
  }, true);

  window.addEventListener('pointerdown', (e) => {
    if (!pillHost || isInsidePill(e) || loading) return;
    removePill();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pillHost) {
      removePill();
      target = null;
    }
  }, true);

  // Keep the fixed-position pill anchored to the selection when the page or input scrolls.
  function reposition() {
    if (!pillHost || !target || !target.el.isConnected) return;
    const rect = target.type === 'field'
      ? getTextareaSelectionRect(target.el, target.start, target.end)
      : target.range.getBoundingClientRect();
    positionPill(rect);
  }
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
})();
