(() => {
  const MIN_LENGTH = 10;
  const MAX_WORDS = 500;
  const MODES = [
    { id: 'touchup', label: 'Touch up' },
    { id: 'improve', label: 'Improve' },
    { id: 'rewrite', label: 'Rewrite' }
  ];

  let pillHost = null;   // element in the page that hosts the pill's shadow root
  let pillRoot = null;   // shadow root (isolates pill styles from the site's CSS)
  let target = null;     // { type: 'textarea' | 'contenteditable', el, start, end, range, text }
  let loading = false;
  let dismissTimer = null;

  // ---------- Selection detection ----------

  function isEditable(el) {
    if (el.isContentEditable) return true;
    const attr = el.getAttribute('contenteditable');
    return attr !== null && attr !== 'false';
  }

  // Walk up the whole ancestor chain (Claude/ChatGPT nest the text many levels deep inside
  // the editor) and return the outermost editable element that contains the node.
  function getEditingHost(node) {
    let el = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
    let host = null;
    while (el) {
      if (el.tagName === 'TEXTAREA') return el;
      if (isEditable(el)) host = el;
      else if (host) break;
      el = el.parentElement;
    }
    return host;
  }

  // Returns a description of the current selection if it's inside an editable prompt input.
  function readSelection() {
    // Textareas don't expose their selection through window.getSelection() ranges,
    // so check the focused element first.
    const active = document.activeElement;
    if (active && active.tagName === 'TEXTAREA' && active.selectionStart !== active.selectionEnd) {
      const start = active.selectionStart;
      const end = active.selectionEnd;
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
    if (!host || host.tagName === 'TEXTAREA' || !host.contains(sel.focusNode)) return null;

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
      background: #FF8C00;
      color: #000;
      border-radius: 999px;
      padding: 6px 10px;
      box-shadow: 0 2px 12px rgba(255, 140, 0, 0.4);
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
      border-right: 1px solid rgba(0, 0, 0, 0.18);
      color: #000;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      padding: 4px 8px;
      line-height: 1.2;
      border-radius: 6px;
      transition: background 120ms ease;
    }
    button:last-child { border-right: none; }
    button:hover { background: #E07B00; }
    button:disabled { cursor: default; opacity: 0.7; }
    button:disabled:hover { background: none; }
    button.loading { display: inline-flex; align-items: center; justify-content: center; opacity: 1; }
    .spinner {
      width: 10px;
      height: 10px;
      border: 1.5px solid rgba(0, 0, 0, 0.25);
      border-top-color: #000;
      border-radius: 50%;
      animation: pp-spin 600ms linear infinite;
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
    .pill.tall {
      flex-direction: column;
      border-radius: 14px;
      padding: 8px 14px;
      gap: 4px;
    }
    .notice { font-size: 11px; }
    .link {
      font-size: 11px;
      font-weight: 600;
      text-decoration: underline;
      cursor: pointer;
      color: #000;
    }
    .link:hover { color: #3a1f00; }
  `;

  function countWords(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  function showPill(rect, wordCount) {
    removePill();

    pillHost = document.createElement('div');
    Object.assign(pillHost.style, {
      position: 'fixed',
      zIndex: '2147483647',
      top: '0px',
      left: '0px'
    });
    pillRoot = pillHost.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = PILL_CSS;
    const pill = document.createElement('div');
    pill.className = 'pill';
    pillRoot.append(style, pill);
    (document.body || document.documentElement).appendChild(pillHost);

    if (wordCount > MAX_WORDS) renderLongTextWarning(pill, rect);
    else renderButtons(pill);
    positionPill(rect);
  }

  function renderButtons(pill) {
    pill.className = 'pill';
    pill.textContent = '';
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
  }

  function renderLongTextWarning(pill, rect) {
    pill.className = 'pill tall';
    pill.textContent = '';
    const notice = document.createElement('span');
    notice.className = 'notice';
    notice.textContent = `Best for short prompts (${MAX_WORDS} words max)`;
    const link = document.createElement('span');
    link.className = 'link';
    link.textContent = 'Rewrite anyway';
    link.addEventListener('mousedown', (e) => e.preventDefault());
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      renderButtons(pill);
      positionPill(rect);
    });
    pill.append(notice, link);
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
    const pill = pillRoot.querySelector('.pill');
    pill.className = 'pill';
    pill.textContent = '';
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
    const label = MODES.find((m) => m.id === mode)?.label || mode;
    const count = Number.isFinite(tokens) ? `${tokens} tokens` : 'Done';
    showMessage('done', `⚡ ${count} · ${label}`, 1500);
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
        if (!res) return showError('No response from Polishd.');
        if (res.error) return showError(res.error);
        const ok = replaceSelection(job, res.result);
        if (!ok) return showError('Could not replace text — the input changed.');
        target = null;
        flashSuccess(job.el);
        showDone(res.tokens, mode);
      })
      .catch((err) => showError(err?.message || 'Something went wrong.'));
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
      console.warn('[Polishd] execCommand unavailable; replacing value directly (Ctrl+Z will not undo this).');
      // Use the native setter so React's value tracker notices the change.
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, expected);
      const caret = start + newText.length;
      ta.setSelectionRange(caret, caret);
    }
    ta.dispatchEvent(new Event('input', { bubbles: true }));
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
    console.warn('[Polishd] execCommand unavailable; replacing text directly (Ctrl+Z will not undo this).');
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
    showPill(info.rect, countWords(info.text));
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
    const rect = target.type === 'textarea'
      ? getTextareaSelectionRect(target.el, target.start, target.end)
      : target.range.getBoundingClientRect();
    positionPill(rect);
  }
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
})();
