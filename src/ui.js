/* ============================================================
   FIL: src/ui.js  (HEL FIL)
   PATCH: AO-QUIZ-01A (FAS 1) — UI helpers (DOM-safe) — FIX
   Policy: UI-only, XSS-safe (textContent), fail-closed, inga externa libs
   Version: 1.0.1

   FIXAR (P0):
     - Tar bort syntaxfel i tidigare version
     - escapeSafeText() escaper korrekt (om den behövs för attribut/URL-delar)
     - toast() är robust och kraschar inte appen

   Export:
     - el(sel, root?)
     - setText(node, text)
     - escapeSafeText(text)
     - toast(msg,type)  // type: 'info'|'success'|'error'|'warn'
============================================================ */

let _toastHost = null;
let _toastTimer = null;

export function el(sel, root) {
  const r = (root && root.querySelector) ? root : document;
  return r.querySelector(sel);
}

export function setText(node, text) {
  if (!node) return;
  node.textContent = (text === null || text === undefined) ? '' : String(text);
}

/**
 * Minimal HTML-escaping (för fall där du måste sätta text i attribut/URL-delar).
 * OBS: För normal rendering i DOM: använd alltid setText()/textContent.
 */
export function escapeSafeText(text) {
  const s = (text === null || text === undefined) ? '' : String(text);
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function _ensureToastHost() {
  if (_toastHost && document.body && document.body.contains(_toastHost)) return _toastHost;
  if (!document.body) return null; // fail-closed om body saknas

  const host = document.createElement('div');
  host.setAttribute('data-ui-toast-host', '1');

  // Inline baseline styles (ingen extern CSS krävs)
  host.style.position = 'fixed';
  host.style.top = '16px';
  host.style.right = '16px';
  host.style.zIndex = '9999';
  host.style.display = 'flex';
  host.style.flexDirection = 'column';
  host.style.gap = '8px';
  host.style.maxWidth = 'min(420px, calc(100vw - 32px))';

  document.body.appendChild(host);
  _toastHost = host;
  return host;
}

function _toastStyleByType(type) {
  const t = String(type || 'info').toLowerCase();

  const base = {
    padding: '10px 12px',
    borderRadius: '12px',
    boxShadow: '0 8px 20px rgba(0,0,0,0.18)',
    border: '1px solid rgba(0,0,0,0.10)',
    background: '#111827',
    color: '#ffffff',
    fontSize: '14px',
    lineHeight: '1.25',
    display: 'flex',
    gap: '10px',
    alignItems: 'flex-start'
  };

  const dot = {
    width: '10px',
    height: '10px',
    borderRadius: '999px',
    marginTop: '4px',
    flex: '0 0 auto',
    background: '#60a5fa'
  };

  if (t === 'success') dot.background = '#22c55e';
  else if (t === 'error') dot.background = '#ef4444';
  else if (t === 'warn' || t === 'warning') dot.background = '#f59e0b';

  return { base, dot };
}

export function toast(msg, type = 'info') {
  try {
    const host = _ensureToastHost();
    if (!host) return false;

    const { base, dot } = _toastStyleByType(type);

    const wrap = document.createElement('div');
    wrap.setAttribute('data-ui-toast', '1');
    for (const [k, v] of Object.entries(base)) wrap.style[k] = v;

    const dotEl = document.createElement('div');
    for (const [k, v] of Object.entries(dot)) dotEl.style[k] = v;

    const text = document.createElement('div');
    text.style.flex = '1 1 auto';
    text.style.wordBreak = 'break-word';
    setText(text, msg);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Stäng');
    closeBtn.style.border = '0';
    closeBtn.style.background = 'transparent';
    closeBtn.style.color = 'rgba(255,255,255,0.85)';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.padding = '0';
    closeBtn.style.lineHeight = '1';
    closeBtn.style.fontSize = '18px';
    setText(closeBtn, '×');

    closeBtn.addEventListener('click', () => {
      if (wrap && wrap.parentNode) wrap.parentNode.removeChild(wrap);
      if (host.childNodes.length === 0 && host.parentNode) host.parentNode.removeChild(host);
    });

    wrap.appendChild(dotEl);
    wrap.appendChild(text);
    wrap.appendChild(closeBtn);

    host.appendChild(wrap);

    // Auto-dismiss (påverkar endast senaste timer)
    if (_toastTimer) window.clearTimeout(_toastTimer);
    _toastTimer = window.setTimeout(() => {
      // ta bort äldsta toast först
      const first = host.querySelector('[data-ui-toast]');
      if (first && first.parentNode) first.parentNode.removeChild(first);
      if (host.childNodes.length === 0 && host.parentNode) host.parentNode.removeChild(host);
    }, 3500);

    return true;
  } catch {
    return false; // fail-closed
  }
}

/* ============================================================
   Ändringslogg (≤8)
   - P0: Fixad syntax i ui.js
   - P0: escapeSafeText escaper korrekt
   - P1: toast() robust, fail-closed om body saknas
============================================================ */

/* ============================================================
   Testnoteringar
   [ ] I console: toast('Hej', 'info') → syns
   [ ] setText(el, null) → kraschar inte
   [ ] escapeSafeText('<x>&') → &lt;x&gt;&amp;
============================================================ */
