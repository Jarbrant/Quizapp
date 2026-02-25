/* ============================================================
   FIL: src/play.js  (HEL FIL)
   PATCH: AO-QUIZ-HELP-01 (FAS 1) — Hjälpknapp: visa facit + förklaring per fråga
   Policy: UI-only (GitHub Pages), XSS-safe (textContent), fail-closed, inga externa libs
   Version: 1.1.0

   Kräver:
     - src/quiz-contract.js (validateQuiz, normalizeQuiz)
     - src/ui.js (el, setText, toast)

   OBS:
   - Ingen backend. Hjälp visar facit/explanation som redan finns i quiz-JSON.
   - Hjälp påverkar inte poäng (bara visar svar).
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
  // play.html ligger i /pages/ => ../ pekar repo-root
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
   Text scoring: keywords (minst X träffar)
============================================================ */
function scoreTextAnswer(userText, keywords) {
  const input = normalizeTextForMatch(userText);
  const kws = uniqLower(keywords).map((k) => normalizeTextForMatch(k)).filter(Boolean);

  if (!kws.length) return { ok: false, hits: 0, need: 0, matched: [] };

  const need = Math.max(1, Math.ceil(kws.length * 0.5));
  const matched = [];

  for (const k of kws) {
    if (!k) continue;
    if (input.includes(k)) matched.push(k);
  }

  const hits = matched.length;
  return { ok: hits >= need, hits, need, matched };
}

/* ============================================================
   State
============================================================ */
const state = {
  quiz: null,
  idx: 0,
  answers: {}, // { [qid]: { type, value } }
  graded: {},  // { [qid]: { ok, detail } }
  finished: false
};

/* ============================================================
   Boot
============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  const app = $('#app');
  const errorBox = $('#errorBox');
  const startBox = $('#startBox');
  const playBox = $('#playBox');
  const resultBox = $('#resultBox');

  if (!app || !errorBox || !startBox || !playBox || !resultBox) return;

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

  startBtn.addEventListener('click', () => {
    setVisible(errorBox, false);
    setVisible(startBox, false);
    setVisible(playBox, true);

    state.idx = 0;
    state.finished = false;

    wirePlayUI(playBox);
    renderQuestion(playBox);
  }, { once: true });
}

/* ============================================================
   Play UI wiring
============================================================ */
function wirePlayUI(playBox) {
  const prevBtn = $('#navPrevBtn', playBox);
  const nextBtn = $('#navNextBtn', playBox);
  const checkBtn = $('#checkBtn', playBox);
  const finishBtn = $('#finishBtn', playBox);

  // NYTT: Hjälpknapp skapas om den saknas (ingen HTML-patch krävs)
  const controls = playBox.querySelector('.controls') || playBox;
  let helpBtn = $('#helpBtn', playBox);
  if (!helpBtn) {
    helpBtn = document.createElement('button');
    helpBtn.id = 'helpBtn';
    helpBtn.type = 'button';
    helpBtn.className = 'btn';
    setText(helpBtn, 'Hjälp');

    // lägg efter "Rätta" om möjligt, annars sist
    if (checkBtn && checkBtn.parentNode === controls) {
      checkBtn.insertAdjacentElement('afterend', helpBtn);
    } else {
      controls.appendChild(helpBtn);
    }
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
    showHelp(playBox);
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

  // progress
  const progressText = $('#progressText', playBox);
  const progressBarInner = $('#progressBarInner', playBox);

  setText(progressText, `${state.idx + 1}/${quiz.questions.length}`);

  const pct = Math.round(((state.idx + 1) / quiz.questions.length) * 100);
  if (progressBarInner) progressBarInner.style.width = `${pct}%`;

  // nav enable/disable
  const prevBtn = $('#navPrevBtn', playBox);
  const nextBtn = $('#navNextBtn', playBox);
  prevBtn.disabled = state.idx === 0;
  nextBtn.disabled = state.idx === quiz.questions.length - 1;

  // finish only on last
  const finishBtn = $('#finishBtn', playBox);
  finishBtn.disabled = state.idx !== quiz.questions.length - 1;

  // clear help + feedback
  const slot = $('#questionSlot', playBox);
  const feedback = $('#feedbackSlot', playBox);

  setText(feedback, '');
  setText(slot, '');

  slot.appendChild(renderQuestionCard(q));

  // restore prior feedback if graded
  const g = state.graded[q.id];
  if (g) setText(feedback, g.ok ? '✅ Rätt' : '❌ Fel');
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
  setText(hint, 'Rättning sker via keywords (visa facit i Resultat).');

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
   Hjälpknapp: visa facit + explanation (per fråga)
============================================================ */
function showHelp(playBox) {
  const quiz = state.quiz;
  if (!quiz) return;

  const q = quiz.questions[state.idx];
  if (!q) return;

  const slot = $('#questionSlot', playBox);
  if (!slot) return;

  // ta bort ev tidigare helpbox
  const old = slot.querySelector('[data-helpbox="1"]');
  if (old && old.parentNode) old.parentNode.removeChild(old);

  const help = document.createElement('div');
  help.setAttribute('data-helpbox', '1');
  help.className = 'pre'; // använder befintlig CSS

  const facit = formatCorrectAnswer(q);
  const exp = String(q.explanation ?? '').trim();

  const parts = [];
  parts.push(`Facit: ${facit || '(saknas)'}`);
  if (exp) parts.push(`\nFörklaring: ${exp}`);

  setText(help, parts.join('\n'));

  slot.appendChild(help);
  toast('Hjälp visad (facit + förklaring).', 'info');
}

/* ============================================================
   Grade current
============================================================ */
function gradeCurrent(playBox) {
  const quiz = state.quiz;
  if (!quiz) return;

  const q = quiz.questions[state.idx];
  if (!q) return;

  const a = state.answers[q.id]?.value;
  const graded = gradeQuestion(q, a);
  state.graded[q.id] = graded;

  const feedback = $('#feedbackSlot', playBox);
  setText(feedback, graded.ok ? '✅ Rätt' : '❌ Fel');

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
    const expected = {};
    const got = {};

    for (let i = 0; i < needLen; i++) {
      const key = String.fromCharCode(65 + i);
      const exp = String(right[i] ?? '').trim();
      expected[key] = exp;

      const u = String(parsed.map[key] ?? '').trim();
      got[key] = u;

      if (normalizeTextForMatch(u) && normalizeTextForMatch(u) === normalizeTextForMatch(exp)) okCount++;
    }

    const ok = needLen > 0 && okCount === needLen;
    return { ok, detail: { expected, got, okCount, needLen } };
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
    setText(extra, `Keywords: ${d.hits}/${d.need} träffar${matched ? ` (träff: ${matched})` : ''}`);
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
    return lines.length ? lines.join('; ') : '(saknas)';
  }

  return '(saknas)';
}
