(() => {
  const MIN_LENGTH = 10;
  const MODES = [
    { id: 'preserve', label: 'Preserve' },
    { id: 'improve', label: 'Improve' },
    { id: 'rewrite', label: 'Rewrite' }
  ];

  let pillHost = null;   // element in the page that hosts the pill's shadow root
  let pillRoot = null;   // shadow root (isolates pill styles from the site's CSS)
  let target = null;     // { type: 'textarea' | 'contenteditable', el, start, end, range, text }
  let loading = false;
  let errorTimer = null;

  // ---------- Selection detection ----------

  function getEditingHost(node) {
    let el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    if (!el || !el.isContentEditable) return null;
    while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement;
    return el;
  }

  // Returns a description of the current selection if it's inside an editable prompt input.
  function readSelection() {
    // Textareas don't expose their selection through window.getSelection() ranges,
    // so check the focused element first.
    const active = document.activeElement;
    if (active && active.tagName === 'TEXTAREA') {
      const start = active.selectionStart;
      const end = active.selectionEnd;
      if (start === end) return null;
      const text = active.value.slice(start, end);
      return {
        type: 'textarea',
        el: active,
        start,
        end,
        text,
        rect: getTextareaSelectionRect(active, start, end)
      };
    }

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const host = getEditingHost(sel.anchorNode);
    if (!host || !host.contains(sel.focusNode)) return null;

    const range = sel.getRangeAt(0);
    let rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) rect = host.getBoundingClientRect();
    return {
      type: 'contenteditable',
      el: host,
      range: range.cloneRange(),
      text: sel.toString(),
      rect
    };
  }

  // Approximate the on-screen rect of a textarea selection using a mirror div.
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
      whiteSpace: 'pre-wrap',
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
    .pill {
      display: flex;
      align-items: center;
      background: #1a1a1a;
      border-radius: 999px;
      padding: 6px 10px;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.22), 0 0 0 1px rgba(255, 255, 255, 0.06);
      font-family: system-ui, -apple-system, sans-serif;
      user-select: none;
      animation: pp-fade-in 150ms ease-out;
    }
    @keyframes pp-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    button {
      background: none;
      border: none;
      border-right: 1px solid #333;
      color: #fff;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      padding: 4px 8px;
      line-height: 1.2;
      transition: background 120ms ease;
    }
    button:last-child { border-right: none; }
    button:hover { background: #333; }
    button:disabled { cursor: default; opacity: 0.7; }
    button:disabled:hover { background: none; }
    button.loading { display: inline-flex; align-items: center; justify-content: center; opacity: 1; }
    .spinner {
      width: 10px;
      height: 10px;
      border: 1.5px solid #555;
      border-top-color: #fff;
      border-radius: 50%;
      animation: pp-spin 600ms linear infinite;
    }
    @keyframes pp-spin {
      to { transform: rotate(360deg); }
    }
    .error {
      color: #ef4444;
      font-size: 11px;
      padding: 2px 6px;
      max-width: 320px;
    }
  `;

  function showPill(rect) {
    removePill();

    pillHost = document.createElement('div');
    Object.assign(pillHost.style, {
      position: 'fixed',
      zIndex: '999999',
      top: '0px',
      left: '0px'
    });
    pillRoot = pillHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = PILL_CSS;
    const pill = document.createElement('div');
    pill.className = 'pill';

    MODES.forEach(({ id, label }) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.dataset.mode = id;
      // Prevent the click from stealing focus / collapsing the selection in the input.
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        handleModeClick(id, btn);
      });
      pill.appendChild(btn);
    });

    pillRoot.append(style, pill);
    document.documentElement.appendChild(pillHost);
    positionPill(rect);
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
    clearTimeout(errorTimer);
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

  function showError(message) {
    if (!pillRoot) return;
    loading = false;
    const pill = pillRoot.querySelector('.pill');
    pill.textContent = '';
    const msg = document.createElement('span');
    msg.className = 'error';
    msg.textContent = message;
    pill.appendChild(msg);
    errorTimer = setTimeout(removePill, 3000);
  }

  // ---------- Rewrite flow ----------

  function handleModeClick(mode, btn) {
    if (loading || !target) return;
    const job = target;
    setLoading(btn);

    let sent;
    try {
      sent = chrome.runtime.sendMessage({ action: 'rewrite', text: job.text, mode });
    } catch (err) {
      showError('Extension was reloaded — refresh this page.');
      return;
    }

    sent
      .then((res) => {
        if (!pillHost) return; // dismissed meanwhile
        if (!res) return showError('No response from PromptPolish.');
        if (res.error) return showError(res.error);
        const ok = replaceSelection(job, res.result);
        if (!ok) return showError('Could not replace text — the input changed.');
        removePill();
        flashSuccess(job.el);
        target = null;
      })
      .catch((err) => showError(err?.message || 'Something went wrong.'));
  }

  // Briefly outline the input in green so the user sees the replacement happened.
  function flashSuccess(el) {
    const prev = {
      outline: el.style.getPropertyValue('outline'),
      outlinePriority: el.style.getPropertyPriority('outline'),
      offset: el.style.getPropertyValue('outline-offset'),
      transition: el.style.getPropertyValue('transition')
    };
    el.style.setProperty('transition', 'outline-color 150ms ease');
    el.style.setProperty('outline', '2px solid #22c55e', 'important');
    el.style.setProperty('outline-offset', '2px');
    setTimeout(() => {
      el.style.setProperty('outline', prev.outline, prev.outlinePriority);
      el.style.setProperty('outline-offset', prev.offset);
      el.style.setProperty('transition', prev.transition);
    }, 200);
  }

  function replaceSelection(job, newText) {
    if (!job.el.isConnected) return false;
    return job.type === 'textarea'
      ? replaceInTextarea(job, newText)
      : replaceInContentEditable(job, newText);
  }

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

    const value = ta.value.slice(0, start) + newText + ta.value.slice(end);
    // Use the native setter so React's value tracker notices the change.
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));

    ta.focus();
    const caret = start + newText.length;
    ta.setSelectionRange(caret, caret);
    return true;
  }

  function replaceInContentEditable(job, newText) {
    const el = job.el;
    el.focus();
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(job.range);

    if (document.execCommand('insertText', false, newText)) return true;

    // Fallback: plain DOM replacement + input event.
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(newText));
    range.collapse(false);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: newText }));
    return true;
  }

  // ---------- Event wiring ----------

  function isInsidePill(e) {
    return pillHost && e.composedPath().includes(pillHost);
  }

  function evaluateSelection() {
    if (loading) return;
    const info = readSelection();
    if (!info || info.text.trim().length <= MIN_LENGTH) {
      removePill();
      target = null;
      return;
    }
    target = info;
    showPill(info.rect);
  }

  // Run after the browser has finalized the selection (clicking inside an existing
  // selection collapses it only after mouseup).
  function scheduleEvaluate() {
    setTimeout(evaluateSelection, 10);
  }

  document.addEventListener('mouseup', (e) => {
    if (isInsidePill(e)) return;
    scheduleEvaluate();
  }, true);

  // Keyboard selections (Shift+arrows, Ctrl/Cmd+A) count as new selections too.
  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' || e.shiftKey || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')) {
      scheduleEvaluate();
    }
  }, true);

  document.addEventListener('mousedown', (e) => {
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
    const rect = target.type === 'textarea'
      ? getTextareaSelectionRect(target.el, target.start, target.end)
      : target.range.getBoundingClientRect();
    positionPill(rect);
  }
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
})();
