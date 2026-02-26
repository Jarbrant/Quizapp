/* ============================================================
   FIL: src/play.js  (HEL FIL)
   PATCH: AO-QUIZ-TEXTGRADE-02 (FAS 1) — Text-rättning “B” + stavningsfeedback
   Policy: UI-only (GitHub Pages), XSS-safe (textContent), fail-closed, inga externa libs
   Version: 1.3.0

   ÄNDRINGAR:
   - Textfrågor rättas med tröskel B: need = max(2, ceil(33% av keywords))
   - Vid “nära match” visas feedback: “du skrev X men menade Y”
   - Hjälp är modal (facit + förklaring), som tidigare
============================================================ */

import { validateQuiz, normalizeQuiz } from './quiz-contract.js';
import { el, setText, toast } from './ui.js';

const $ = (sel, root) => el(sel, root);

/* ============================================================
   Utils
============================================================ */
function getQueryParam(name) {
  const sp = new URLSearchParams(window.location.search);
  const v = sp.get(name);
  return v ? String(v) : '';
}

function isSafeRelativePath(p) {
  const s = (p || '').trim();
  if (!s) return false;
  if (s.startsWith('http://') || s.startsWith('https://')) return false;
  if (s.startsWith('data:') || s.startsWith('javascript:')) return false;
  return true;
}

function resolveQuizUrl(relPath) {
  const clean = relPath.replace(/^\/+/, '');
  const url = new URL(`../${clean}`, window.location.href);
  return url.toString();
}

function setVisible(node, yes) {
  if (!node) return;
  node.style.display = yes ? '' : 'none';
}

function normalizeTextForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\u00A0\s]+/g, ' ')
    .trim();
}

function uniqLower(arr) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(arr) ? arr : []) {
    const s = String(v ?? '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function setsEqual(a, b) {
  const A = new Set(Array.isArray(a) ? a : []);
  const B = new Set(Array.isArray(b) ? b : []);
  if (A.size !== B.size) return false;
  for (const x of A) if (!B.has(x)) return false;
  return true;
}

/* ============================================================
   Match parsing: "A=..., B:..., C-..." robust mot newline/;
============================================================ */
function parseMatchInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return { map: {}, pairs: [] };

  const chunks = text
    .split(/[\n;]+/g)
    .map((c) => c.trim())
    .filter(Boolean);

  const map = {};
  const pairs = [];

  for (const chunk of chunks) {
    const m = chunk.match(/^([A-Za-z])\s*[:=\-]\s*(.+)$/);
    if (!m) continue;
    const key = m[1].toUpperCase();
    const val = m[2].trim();
    if (!val) continue;
    map[key] = val;
    pairs.push([key, val]);
  }

  return { map, pairs };
}

/* ============================================================
   Text scoring (B): keywords + stavningsfeedback
============================================================ */
function tokenizeWords(s) {
  // Svenska bokstäver + siffror; övrigt blir mellanrum
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9åäö]+/gi, ' ')
    .trim()
    .split(/\s+/g)
    .filter(Boolean);
}

function levenshtein(a, b, maxDist) {
  // Snabb fail om skillnad i längd redan för stor
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;

  const m = a.length;
  const n = b.length;

  // DP med två rader
  const prev = new Array(n + 1);
  const cur = new Array(n + 1);

  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let bestInRow = cur[0];

    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(
        prev[j] + 1,        // del
        cur[j - 1] + 1,     // ins
        prev[j - 1] + cost  // sub
      );
      cur[j] = v;
      if (v < bestInRow) bestInRow = v;
    }

    // tidig avbrytning
    if (bestInRow > maxDist) return maxDist + 1;

    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }

  return prev[n];
}

function fuzzyFindClosestWord(keyword, userWords) {
  // Tillåt “liten miss”:
  // korta ord: max 1
  // längre ord: max 2
  const k = String(keyword || '').toLowerCase().trim();
  if (!k) return null;

  const maxDist = k.length <= 4 ? 1 : 2;

  let best = null;
  for (const w of userWords) {
    if (!w) continue;
    if (w === k) return { word: w, dist: 0 };
    const d = levenshtein(w, k, maxDist);
    if (d <= maxDist) {
      if (!best || d < best.dist) best = { word: w, dist: d };
      if (d === 1) break; // good enough
    }
  }
  return best;
}

function scoreTextAnswer(userText, keywords) {
  const raw = String(userText ?? '');
  const inputNorm = normalizeTextForMatch(raw);
  const userWords = tokenizeWords(raw);

  const kws = uniqLower(keywords)
    .map((k) => normalizeTextForMatch(k))
    .filter(Boolean);

  if (!kws.length) {
    return { ok: false, hits: 0, need: 0, matched: [], typos: [] };
  }

  // Tröskel B: minst max(2, 33% av keywords)
  const need = Math.max(2, Math.ceil(kws.length * 0.33));

  const matched = [];
  const typos = [];

  for (const k of kws) {
    // 1) substring-match (snabbt, “snällt”)
    if (inputNorm.includes(k)) {
      matched.push(k);
      continue;
    }

    // 2) fuzzy match mot ord i svaret
    const closest = fuzzyFindClosestWord(k, userWords);
    if (closest && closest.dist > 0) {
      // nära men felstavat: räkna som träff, men spara feedback
      matched.push(k);
      typos.push({ typed: closest.word, expected: k, dist: closest.dist });
    }
  }

  // dedupe matched
  const matchedUniq = Array.from(new Set(matched));
  const hits = matchedUniq.length;

  // dedupe typos per expected
  const seenExpected = new Set();
  const typosUniq = [];
  for (const t of typos) {
    const key = t.expected;
    if (seenExpected.has(key)) continue;
    seenExpected.add(key);
    typosUniq.push(t);
  }

  return { ok: hits >= need, hits, need, matched: matchedUniq, typos: typosUniq };
}

/* ============================================================
   State
============================================================ */
const state = {
  quiz: null,
  idx: 0,
  answers: {},
  graded: {},
  finished: false
};

/* ============================================================
   Help modal (DOM-safe)
============================================================ */
let _helpModal = null;
let _lastFocus = null;

function ensureHelpModal() {
  if (_helpModal && document.body.contains(_helpModal.overlay)) return _helpModal;
  if (!document.body) return null;

  const overlay = document.createElement('div');
  overlay.setAttribute('data-help-overlay', '1');
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.background = 'rgba(0,0,0,0.35)';
  overlay.style.display = 'none';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.padding = '16px';
  overlay.style.zIndex = '9998';

  const modal = document.createElement('div');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Hjälp');
  modal.style.width = 'min(820px, 100%)';
  modal.style.maxHeight = 'min(80vh, 720px)';
  modal.style.overflow = 'auto';
  modal.style.background = '#fff';
  modal.style.border = '1px solid rgba(0,0,0,0.10)';
  modal.style.borderRadius = '14px';
  modal.style.boxShadow = '0 20px 60px rgba(0,0,0,0.22)';
  modal.style.padding = '14px';

  const head = document.createElement('div');
  head.style.display = 'flex';
  head.style.alignItems = 'center';
  head.style.justifyContent = 'space-between';
  head.style.gap = '10px';
  head.style.marginBottom = '10px';

  const title = document.createElement('div');
  title.style.fontWeight = '700';
  title.style.fontSize = '16px';
  setText(title, 'Hjälp');

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn';
  closeBtn.style.padding = '8px 10px';
  setText(closeBtn, 'Stäng');

  const body = document.createElement('div');
  body.style.display = 'flex';
  body.style.flexDirection = 'column';
  body.style.gap = '10px';

  const qText = document.createElement('div');
  qText.className = 'muted';

  const facitBox = document.createElement('pre');
  facitBox.className = 'pre';
  facitBox.style.margin = '0';

  const expBox = document.createElement('div');
  expBox.className = 'pre';

  body.appendChild(qText);
  body.appendChild(facitBox);
  body.appendChild(expBox);

  head.appendChild(title);
  head.appendChild(closeBtn);

  modal.appendChild(head);
  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() {
    overlay.style.display = 'none';
    overlay.setAttribute('aria-hidden', 'true');
    if (_lastFocus && typeof _lastFocus.focus === 'function') _lastFocus.focus();
    _lastFocus = null;
  }

  closeBtn.addEventListener('click', close);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  window.addEventListener('keydown', (e) => {
    if (overlay.style.display !== 'flex') return;
    if (e.key === 'Escape') close();
  });

  _helpModal = { overlay, modal, qText, facitBox, expBox, close };
  return _helpModal;
}

function openHelpModalForQuestion(q) {
  const m = ensureHelpModal();
  if (!m) return false;

  _lastFocus = document.activeElement;

  setText(m.qText, q?.q ? `Fråga: ${q.q}` : 'Fråga: (saknas)');
  setText(m.facitBox, `Facit:\n${formatCorrectAnswer(q) || '(saknas)'}`);

  const exp = String(q?.explanation ?? '').trim();
  setText(m.expBox, exp ? `Förklaring:\n${exp}` : 'Förklaring:\n(saknas)');

  m.overlay.style.display = 'flex';
  m.overlay.removeAttribute('aria-hidden');

  const btn = m.modal.querySelector('button');
  if (btn && typeof btn.focus === 'function') btn.focus();

  return true;
}

/* ============================================================
   Boot
============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  const errorBox = $('#errorBox');
  const startBox = $('#startBox');
  const playBox = $('#playBox');
  const resultBox = $('#resultBox');

  if (!errorBox || !startBox || !playBox || !resultBox) return;

  const quizParam = getQueryParam('quiz');

  if (!quizParam) {
    showError(errorBox, 'Ingen quiz angiven.', true);
    return;
  }

  if (!isSafeRelativePath(quizParam)) {
    showError(errorBox, 'Ogiltig quiz-sökväg (endast relativ path tillåten).', true);
    return;
  }

  const url = resolveQuizUrl(quizParam);

  loadQuiz(url)
    .then((quiz) => {
      state.quiz = quiz;
      renderStart(startBox, playBox, errorBox);
    })
    .catch((err) => {
      showError(errorBox, String(err || 'Kunde inte ladda quiz.'), true);
    });
});

/* ============================================================
   Load quiz
============================================================ */
async function loadQuiz(url) {
  let res;
  try {
    res = await fetch(url, { cache: 'no-store' });
  } catch {
    throw new Error('Fetch misslyckades (offline eller fel sökväg).');
  }

  if (!res || !res.ok) throw new Error('Fetch 404/err: Kunde inte hämta quizfilen.');

  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('Ogiltig JSON (kunde inte parse).');
  }

  const v = validateQuiz(json);
  if (!v.ok) {
    const msg = v.errors && v.errors.length ? v.errors.join('\n') : 'Ogiltig quiz JSON.';
    throw new Error(`Quiz-validering FAIL:\n${msg}`);
  }

  return normalizeQuiz(json);
}

/* ============================================================
   Error UI
============================================================ */
function showError(errorBox, message, showHomeLink) {
  setText(errorBox, '');

  const wrap = document.createElement('div');
  wrap.className = 'card';

  const h = document.createElement('h2');
  setText(h, 'Fel');

  const p = document.createElement('pre');
  p.className = 'pre';
  setText(p, message);

  wrap.appendChild(h);
  wrap.appendChild(p);

  if (showHomeLink) {
    const a = document.createElement('a');
    a.href = '../index.html';
    a.className = 'btn';
    setText(a, 'Till startsidan');
    wrap.appendChild(a);
  }

  errorBox.appendChild(wrap);
  errorBox.style.display = '';
}

/* ============================================================
   Start UI
============================================================ */
function renderStart(startBox, playBox, errorBox) {
  const quiz = state.quiz;
  if (!quiz) return;

  const quizTitle = $('#quizTitle', startBox);
  const quizMeta = $('#quizMeta', startBox);
  const startBtn = $('#startBtn', startBox);

  setText(quizTitle, quiz.title || 'Quiz');
  setText(quizMeta, `${quiz.questions.length} frågor`);

  startBtn.addEventListener(
    'click',
    () => {
      setVisible(errorBox, false);
      setVisible(startBox, false);
      setVisible(playBox, true);

      state.idx = 0;
      state.finished = false;

      wirePlayUI(playBox);
      renderQuestion(playBox);
    },
    { once: true }
  );
}

/* ============================================================
   Play UI wiring
============================================================ */
function wirePlayUI(playBox) {
  const prevBtn = $('#navPrevBtn', playBox);
  const nextBtn = $('#navNextBtn', playBox);
  const checkBtn = $('#checkBtn', playBox);
  const finishBtn = $('#finishBtn', playBox);

  const controls = playBox.querySelector('.controls') || playBox;
  let helpBtn = $('#helpBtn', playBox);
  if (!helpBtn) {
    helpBtn = document.createElement('button');
    helpBtn.id = 'helpBtn';
    helpBtn.type = 'button';
    helpBtn.className = 'btn';
    setText(helpBtn, 'Hjälp');
    if (checkBtn && checkBtn.parentNode === controls) checkBtn.insertAdjacentElement('afterend', helpBtn);
    else controls.appendChild(helpBtn);
  }

  prevBtn.addEventListener('click', () => {
    if (!state.quiz) return;
    if (state.idx <= 0) return;
    state.idx--;
    renderQuestion(playBox);
  });

  nextBtn.addEventListener('click', () => {
    if (!state.quiz) return;
    if (state.idx >= state.quiz.questions.length - 1) return;
    state.idx++;
    renderQuestion(playBox);
  });

  checkBtn.addEventListener('click', () => {
    if (!state.quiz) return;
    gradeCurrent(playBox);
  });

  helpBtn.addEventListener('click', () => {
    if (!state.quiz) return;
    const q = state.quiz.questions[state.idx];
    if (!q) return;
    const ok = openHelpModalForQuestion(q);
    toast(ok ? 'Hjälp öppnad.' : 'Kunde inte öppna hjälp.', ok ? 'info' : 'error');
  });

  finishBtn.addEventListener('click', () => {
    if (!state.quiz) return;
    state.finished = true;
    renderResults();
  });
}

/* ============================================================
   Render question
============================================================ */
function renderQuestion(playBox) {
  const quiz = state.quiz;
  if (!quiz) return;

  const q = quiz.questions[state.idx];
  if (!q) return;

  const progressText = $('#progressText', playBox);
  const progressBarInner = $('#progressBarInner', playBox);

  setText(progressText, `${state.idx + 1}/${quiz.questions.length}`);

  const pct = Math.round(((state.idx + 1) / quiz.questions.length) * 100);
  if (progressBarInner) progressBarInner.style.width = `${pct}%`;

  const prevBtn = $('#navPrevBtn', playBox);
  const nextBtn = $('#navNextBtn', playBox);
  prevBtn.disabled = state.idx === 0;
  nextBtn.disabled = state.idx === quiz.questions.length - 1;

  const finishBtn = $('#finishBtn', playBox);
  finishBtn.disabled = state.idx !== quiz.questions.length - 1;

  const slot = $('#questionSlot', playBox);
  const feedback = $('#feedbackSlot', playBox);

  setText(feedback, '');
  setText(slot, '');

  slot.appendChild(renderQuestionCard(q));

  const g = state.graded[q.id];
  if (g) setText(feedback, g.feedbackText || (g.ok ? '✅ Rätt' : '❌ Fel'));
}

function renderQuestionCard(q) {
  const wrap = document.createElement('div');
  wrap.className = 'card';

  const h = document.createElement('h2');
  setText(h, q.q || 'Fråga');
  wrap.appendChild(h);

  const body = document.createElement('div');
  body.className = 'cardBody';

  const ans = state.answers[q.id] || { type: q.type, value: null };

  if (q.type === 'mcq') body.appendChild(renderMCQ(q, ans));
  else if (q.type === 'multi') body.appendChild(renderMulti(q, ans));
  else if (q.type === 'tf') body.appendChild(renderTF(q, ans));
  else if (q.type === 'text') body.appendChild(renderText(q, ans));
  else if (q.type === 'match') body.appendChild(renderMatch(q, ans));
  else {
    const p = document.createElement('p');
    setText(p, 'Okänd frågetyp.');
    body.appendChild(p);
  }

  wrap.appendChild(body);
  return wrap;
}

/* ============================================================
   Inputs
============================================================ */
function saveAnswer(qid, type, value) {
  state.answers[qid] = { type, value };
}

function renderMCQ(q, ans) {
  const wrap = document.createElement('div');
  const opts = Array.isArray(q.options) ? q.options : [];
  const name = `mcq-${q.id}`;

  for (let i = 0; i < opts.length; i++) {
    const row = document.createElement('label');
    row.className = 'row';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = String(i);
    input.checked = String(ans.value ?? '') === String(i);
    input.addEventListener('change', () => saveAnswer(q.id, 'mcq', i));

    const txt = document.createElement('span');
    setText(txt, opts[i]);

    row.appendChild(input);
    row.appendChild(txt);
    wrap.appendChild(row);
  }

  return wrap;
}

function renderMulti(q, ans) {
  const wrap = document.createElement('div');
  const opts = Array.isArray(q.options) ? q.options : [];
  const selected = new Set(Array.isArray(ans.value) ? ans.value : []);

  for (let i = 0; i < opts.length; i++) {
    const row = document.createElement('label');
    row.className = 'row';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = String(i);
    input.checked = selected.has(i);

    input.addEventListener('change', () => {
      const cur = new Set(Array.isArray(state.answers[q.id]?.value) ? state.answers[q.id].value : []);
      if (input.checked) cur.add(i);
      else cur.delete(i);
      saveAnswer(q.id, 'multi', Array.from(cur));
    });

    const txt = document.createElement('span');
    setText(txt, opts[i]);

    row.appendChild(input);
    row.appendChild(txt);
    wrap.appendChild(row);
  }

  return wrap;
}

function renderTF(q, ans) {
  const wrap = document.createElement('div');
  const name = `tf-${q.id}`;
  const cur = String(ans.value ?? '');

  const make = (labelText, val) => {
    const row = document.createElement('label');
    row.className = 'row';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = val;
    input.checked = cur === val;
    input.addEventListener('change', () => saveAnswer(q.id, 'tf', val));

    const txt = document.createElement('span');
    setText(txt, labelText);

    row.appendChild(input);
    row.appendChild(txt);
    return row;
  };

  wrap.appendChild(make('Sant', 'true'));
  wrap.appendChild(make('Falskt', 'false'));
  return wrap;
}

function renderText(q, ans) {
  const wrap = document.createElement('div');

  const t = document.createElement('textarea');
  t.rows = 6;
  t.className = 'input';
  t.placeholder = 'Skriv ditt svar...';
  t.value = String(ans.value ?? '');
  t.addEventListener('input', () => saveAnswer(q.id, 'text', t.value));

  const hint = document.createElement('div');
  hint.className = 'muted';
  setText(hint, 'Rättning sker via keywords (snällare, och ger stavningsfeedback).');

  wrap.appendChild(t);
  wrap.appendChild(hint);
  return wrap;
}

function renderMatch(q, ans) {
  const wrap = document.createElement('div');

  const left = Array.isArray(q.options) ? q.options : [];
  const list = document.createElement('div');
  list.className = 'matchList';

  for (let i = 0; i < left.length; i++) {
    const row = document.createElement('div');
    row.className = 'matchRow';

    const key = document.createElement('div');
    key.className = 'matchKey';
    setText(key, String.fromCharCode(65 + i));

    const txt = document.createElement('div');
    txt.className = 'matchLeft';
    setText(txt, left[i]);

    row.appendChild(key);
    row.appendChild(txt);
    list.appendChild(row);
  }

  const t = document.createElement('textarea');
  t.rows = 6;
  t.className = 'input';
  t.placeholder = 'Skriv t.ex:\nA=...\nB=...\nC=...\n(eller semikolon-separerat)';
  t.value = String(ans.value ?? '');
  t.addEventListener('input', () => saveAnswer(q.id, 'match', t.value));

  const hint = document.createElement('div');
  hint.className = 'muted';
  setText(hint, 'Rättning: robust parsing av A=... med radbryt/semikolon.');

  wrap.appendChild(list);
  wrap.appendChild(t);
  wrap.appendChild(hint);
  return wrap;
}

/* ============================================================
   Grade current + feedback text
============================================================ */
function gradeCurrent(playBox) {
  const quiz = state.quiz;
  if (!quiz) return;

  const q = quiz.questions[state.idx];
  if (!q) return;

  const a = state.answers[q.id]?.value;
  const graded = gradeQuestion(q, a);

  // bygg feedback-text (speciellt för text)
  let fb = graded.ok ? '✅ Rätt' : '❌ Fel';

  if (q.type === 'text' && graded.detail) {
    const d = graded.detail;
    const typos = Array.isArray(d.typos) ? d.typos : [];
    const typoMsg = typos.length
      ? ` (stavning: du skrev "${typos[0].typed}" men menade "${typos[0].expected}")`
      : '';

    if (graded.ok) {
      fb = `✅ Rätt${typoMsg}`;
    } else {
      fb = `❌ Inte helt rätt än (${d.hits}/${d.need} träffar)${typoMsg}`;
    }
  }

  graded.feedbackText = fb;
  state.graded[q.id] = graded;

  const feedback = $('#feedbackSlot', playBox);
  setText(feedback, fb);

  toast(graded.ok ? 'Rätt!' : 'Fel.', graded.ok ? 'success' : 'error');
}

function gradeQuestion(q, userValue) {
  const type = q.type;

  if (type === 'mcq') {
    const correct = Number.isFinite(q.correct) ? q.correct : null;
    const u = (userValue === null || userValue === undefined) ? null : Number(userValue);
    const ok = (correct !== null) && (u === correct);
    return { ok, detail: { correct, user: u } };
  }

  if (type === 'multi') {
    const correct = Array.isArray(q.correctKeys) ? q.correctKeys.map((n) => Number(n)).filter(Number.isFinite) : [];
    const user = Array.isArray(userValue) ? userValue.map((n) => Number(n)).filter(Number.isFinite) : [];
    const ok = setsEqual(correct, user);
    return { ok, detail: { correct, user } };
  }

  if (type === 'tf') {
    const ck = Array.isArray(q.correctKeys) ? q.correctKeys : [];
    const correct = String(ck[0] ?? '').toLowerCase();
    const user = String(userValue ?? '').toLowerCase();
    const ok = (correct === 'true' || correct === 'false') && user === correct;
    return { ok, detail: { correct, user } };
  }

  if (type === 'text') {
    const kw = Array.isArray(q.keywords) ? q.keywords : [];
    const s = scoreTextAnswer(String(userValue ?? ''), kw);
    return { ok: s.ok, detail: s };
  }

  if (type === 'match') {
    const left = Array.isArray(q.options) ? q.options : [];
    const right = Array.isArray(q.correctKeys) ? q.correctKeys : [];
    const needLen = Math.min(left.length, right.length);

    const parsed = parseMatchInput(String(userValue ?? ''));
    let okCount = 0;

    for (let i = 0; i < needLen; i++) {
      const key = String.fromCharCode(65 + i);
      const exp = String(right[i] ?? '').trim();
      const u = String(parsed.map[key] ?? '').trim();
      if (normalizeTextForMatch(u) && normalizeTextForMatch(u) === normalizeTextForMatch(exp)) okCount++;
    }

    const ok = needLen > 0 && okCount === needLen;
    return { ok, detail: { okCount, needLen } };
  }

  return { ok: false, detail: { error: 'Okänd frågetyp' } };
}

/* ============================================================
   Results
============================================================ */
function renderResults() {
  const startBox = $('#startBox');
  const playBox = $('#playBox');
  const resultBox = $('#resultBox');

  setVisible(startBox, false);
  setVisible(playBox, false);
  setVisible(resultBox, true);

  const quiz = state.quiz;
  if (!quiz) return;

  const total = quiz.questions.length;
  let correct = 0;

  for (const q of quiz.questions) {
    const g = state.graded[q.id] || gradeQuestion(q, state.answers[q.id]?.value);
    if (g.ok) correct++;
    state.graded[q.id] = g;
  }

  const resultSummary = $('#resultSummary', resultBox);
  setText(resultSummary, `Resultat: ${correct}/${total}`);

  const list = $('#resultList', resultBox);
  setText(list, '');

  for (let i = 0; i < quiz.questions.length; i++) {
    const q = quiz.questions[i];
    const g = state.graded[q.id];
    const a = state.answers[q.id]?.value;
    list.appendChild(renderResultItem(i, q, g, a));
  }

  const restartLink = $('#restartLink', resultBox);
  if (restartLink) {
    const sp = new URLSearchParams(window.location.search);
    const qp = sp.get('quiz') || '';
    restartLink.href = qp ? `./play.html?quiz=${encodeURIComponent(qp)}` : './play.html';
  }
}

function renderResultItem(i, q, graded, userValue) {
  const item = document.createElement('div');
  item.className = 'card';

  const h = document.createElement('h3');
  setText(h, `${i + 1}. ${q.q || 'Fråga'}`);
  item.appendChild(h);

  const status = document.createElement('div');
  status.className = graded?.ok ? 'badge ok' : 'badge bad';
  setText(status, graded?.ok ? 'Rätt' : 'Fel');
  item.appendChild(status);

  const your = document.createElement('div');
  your.className = 'muted';
  setText(your, `Ditt svar: ${formatUserAnswer(q, userValue)}`);
  item.appendChild(your);

  const facit = document.createElement('div');
  facit.className = 'muted';
  setText(facit, `Facit: ${formatCorrectAnswer(q)}`);
  item.appendChild(facit);

  if (q.type === 'text' && graded?.detail) {
    const d = graded.detail;
    const extra = document.createElement('div');
    extra.className = 'muted';
    const matched = Array.isArray(d.matched) ? d.matched.join(', ') : '';
    const typos = Array.isArray(d.typos) ? d.typos : [];
    const typoTxt = typos.length ? ` • stavning: "${typos[0].typed}"→"${typos[0].expected}"` : '';
    setText(extra, `Keywords: ${d.hits}/${d.need} träffar${matched ? ` (träff: ${matched})` : ''}${typoTxt}`);
    item.appendChild(extra);
  }

  if (q.explanation) {
    const exp = document.createElement('div');
    exp.className = 'pre';
    setText(exp, q.explanation);
    item.appendChild(exp);
  }

  return item;
}

function formatUserAnswer(q, userValue) {
  if (userValue === null || userValue === undefined) return '(tomt)';

  if (q.type === 'mcq') {
    const i = Number(userValue);
    const opts = Array.isArray(q.options) ? q.options : [];
    return Number.isFinite(i) && opts[i] ? opts[i] : String(userValue);
  }

  if (q.type === 'multi') {
    const opts = Array.isArray(q.options) ? q.options : [];
    const arr = Array.isArray(userValue) ? userValue : [];
    const labels = arr.map((n) => opts[Number(n)] ?? `#${n}`);
    return labels.length ? labels.join(', ') : '(tomt)';
  }

  if (q.type === 'tf') {
    const v = String(userValue).toLowerCase();
    return v === 'true' ? 'Sant' : v === 'false' ? 'Falskt' : String(userValue);
  }

  if (q.type === 'text') {
    const s = String(userValue).trim();
    return s ? s : '(tomt)';
  }

  if (q.type === 'match') {
    const s = String(userValue).trim();
    return s ? s : '(tomt)';
  }

  return String(userValue);
}

function formatCorrectAnswer(q) {
  if (!q) return '';

  if (q.type === 'mcq') {
    const opts = Array.isArray(q.options) ? q.options : [];
    const i = Number.isFinite(q.correct) ? q.correct : null;
    if (i === null) return '(saknas)';
    return opts[i] ?? `Index ${i}`;
  }

  if (q.type === 'multi') {
    const opts = Array.isArray(q.options) ? q.options : [];
    const ck = Array.isArray(q.correctKeys) ? q.correctKeys : [];
    const labels = ck.map((n) => opts[Number(n)] ?? `#${n}`);
    return labels.length ? labels.join(', ') : '(saknas)';
  }

  if (q.type === 'tf') {
    const ck = Array.isArray(q.correctKeys) ? q.correctKeys : [];
    const v = String(ck[0] ?? '').toLowerCase();
    return v === 'true' ? 'Sant' : v === 'false' ? 'Falskt' : '(saknas)';
  }

  if (q.type === 'text') {
    const a = String(q.answer ?? '').trim();
    if (a) return a;
    const kw = Array.isArray(q.keywords) ? q.keywords : [];
    return kw.length ? `Keywords: ${kw.join(', ')}` : '(saknas)';
  }

  if (q.type === 'match') {
    const right = Array.isArray(q.correctKeys) ? q.correctKeys : [];
    const lines = [];
    for (let i = 0; i < right.length; i++) {
      const key = String.fromCharCode(65 + i);
      lines.push(`${key}=${right[i]}`);
    }
    return lines.length ? lines.join('\n') : '(saknas)';
  }

  return '(saknas)';
}
