/* ============================================================
   FIL: src/ui.js  (HEL FIL)
   AO-QUIZ-01A (FAS 1) — UI helpers (DOM-safe)
   Policy: UI-only, XSS-safe (textContent), fail-closed, inga externa libs
   Version: 1.0.0

   Export:
     - el(sel, root?)
     - setText(node, text)
     - escapeSafeText(text)   // för text i attribut/URL-delar vid behov
     - toast(msg, type)       // type: 'info'|'success'|'error'|'warn'
============================================================ */

let _toastHost = null;
let _toastTimer = null;

export function el(sel, root) {
  const r = root && root.querySelector ? root : document;
  return r.querySelector(sel);
}

export function setText(node, text) {
  if (!node) return;
  node.textContent = text === null || text === undefined ? '' : String(text);
}

/**
 * Minimal “escape” om du måste stoppa text i attribut/URL-delar.
 * OBS: För vanlig rendering: använd alltid setText/textContent.
 */
export function escapeSafeText(text) {
  const s = text === null || text === undefined ? '' : String(text);
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function _ensureToastHost() {
  if (_toastHost && document.body.contains(_toastHost)) return _toastHost;

  const host = document.createElement('div');
  host.setAttribute('data-ui-toast-host', '1');

  // Inline styles (ingen extern css krävs)
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
  // Inga färgtokens här (AO senare kan lägga tokens i CSS).
  // Vi håller det stabilt med lätt kontrast.
  const t = (type || 'info').toLowerCase();

  const base = {
    padding: '10px 12px',
    borderRadius: '12px',
    boxShadow: '0 8px 20px rgba(0,0,0,0.18)',
    border: '1px solid rgba(0,0,0,0.10)',
    background: '#111827', // near-slate
    color: '#ffffff',
    fontSize: '14px',
    lineHeight: '1.25',
    display: 'flex',
    gap: '10px',
    alignItems: 'flex-start',
  };

  const badge = {
    width: '10px',
    height: '10px',
    borderRadius: '999px',
    marginTop: '4px',
    flex: '0 0 auto',
  };

  if (t === 'success') badge.background = '#22c55e';
  else if (t === 'error') badge.background = '#ef4444';
  else if (t === 'warn' || t === 'warning') badge.background = '#f59e0b';
  else badge.background = '#60a5fa';

  return { base, badge };
}

export function toast(msg, type = 'info') {
  try {
    const host = _ensureToastHost();

    const { base, badge } = _toastStyleByType(type);

    const wrap = document.createElement('div');
    for (const [k, v] of Object.entries(base)) wrap.style[k] = v;

    const dot = document.createElement('div');
    for (const [k, v] of Object.entries(badge)) dot.style[k] = v;

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
    });

    wrap.appendChild(dot);
    wrap.appendChild(text);
    wrap.appendChild(closeBtn);

    host.appendChild(wrap);

    // Auto-dismiss (senaste toast styr timer)
    if (_toastTimer) window.clearTimeout(_toastTimer);
    _toastTimer = window.setTimeout(() => {
      // Ta bort äldsta om många (fail-safe)
      const nodes = host.querySelectorAll('[data-ui-toast]');
      // vi märker inte varje, så vi tar första child om finns
      if (host.firstChild) host.removeChild(host.firstChild);
      // om tomt: städa host
      if (!host.childNodes.length && host.parentNode) host.parentNode.removeChild(host);
    }, 3500);

    return true;
  } catch {
    // Fail-closed: inga exceptions ut i appen
    return false;
  }
}

/* ============================================================
   Ändringslogg (≤8)
   - Skapad: el(), setText() (XSS-safe)
   - Skapad: escapeSafeText() för attribut/URL-fall
   - Skapad: toast() utan externa beroenden (inline styles)
============================================================ */

/* ============================================================
   Testnoteringar
   [ ] Kör toast('Hej', 'info') i console → syns, går att stänga
   [ ] setText() med null/undefined → kraschar inte
   [ ] el() med root → hittar element korrekt
============================================================ */

/* ============================================================
   Risk / edge cases
   - Toast-stilar är inline (AO senare kan flytta till CSS tokens)
   - Om sidan saknar <body> vid tidig körning: toast() kan faila (return false)
============================================================ */
