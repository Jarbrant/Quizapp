/* ============================================================
   FIL: src/play.js  (HEL FIL)
   PATCH: AO-QUIZ-REF-01 (FAS 1) — Rensa play.js + flytta scoring till scoring.js + tydligare progress
   Policy: UI-only (GitHub Pages), XSS-safe (textContent), fail-closed, inga externa libs
   Version: 1.7.0

   Kräver NY FIL:
     - src/scoring.js

   Fixar:
   - Progress visar både "fråga X/Y" och "Svarade A/B"
   - Feedback för MATCH visar delresultat (x/y) + poäng
   - Text kan få poängavdrag vid stavningsfel (via scoring.js)
============================================================ */

import { validateQuiz, normalizeQuiz } from './quiz-contract.js';
import { el, setText, toast } from './ui.js';

import {
  SCORE_CONFIG,
  isAnswered,
  gradeQuestion,
  pointsForQuestion,
  computeScoreSummary,
  gradeOmdome,
  buildTipForQuestion,
  fmtPoints
} from './scoring.js';

const $ = (sel, root) => el(sel, root);

/* ============================================================
   Basic utils
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

/* ============================================================
   State
============================================================ */
const state = {
  quiz: null,
  idx: 0,
  answers: {},   // { [qid]: { type, value } }
  graded: {},    // { [qid]: { ok, detail, feedbackText? } }
  finished: false
};

/* ============================================================
   Help modal (DOM-safe) — behåll enkel, UI-only
============================================================ */
let _helpModal = null;
let _lastFocus = null;

function ensureHelpModal() {
  if (_helpModal && document.body.contains(_helpModal.overlay)) return _helpModal;
  if (!document.body) return null;

  const overlay = document.createElement('div');
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
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  window.addEventListener('keydown', (e) => { if (overlay.style.display === 'flex' && e.key === 'Escape') close(); });

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
   Start
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
   UI wiring
============================================================ */
function wirePlayUI(playBox) {
  const prevBtn = $('#navPrevBtn', playBox);
  const nextBtn = $('#navNextBtn', playBox);
  const checkBtn = $('#checkBtn', playBox);
  const finishBtn = $('#finishBtn', playBox);

  // Hjälpknapp om saknas
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
   Progress helpers (NYTT)
============================================================ */
function getAnsweredCount(quiz) {
  let n = 0;
  for (const q of quiz.questions) {
    const userValue = state.answers[q.id]?.value;
    if (isAnswered(q, userValue)) n++;
  }
  return n;
}

function updateProgress(playBox) {
  const quiz = state.quiz;
  if (!quiz) return;

  const progressText = $('#progressText', playBox);
  const progressBarInner = $('#progressBarInner', playBox);

  const total = quiz.questions.length;
  const answered = getAnsweredCount(quiz);

  setText(progressText, `${state.idx + 1}/${total} • Svarade ${answered}/${total}`);

  const pct = Math.round(((state.idx + 1) / total) * 100);
  if (progressBarInner) progressBarInner.style.width = `${pct}%`;

  const prevBtn = $('#navPrevBtn', playBox);
  const nextBtn = $('#navNextBtn', playBox);
  if (prevBtn) prevBtn.disabled = state.idx === 0;
  if (nextBtn) nextBtn.disabled = state.idx === total - 1;

  const finishBtn = $('#finishBtn', playBox);
  if (finishBtn) finishBtn.disabled = state.idx !== total - 1;
}

/* ============================================================
   Render question
============================================================ */
function renderQuestion(playBox) {
  const quiz = state.quiz;
  if (!quiz) return;

  const q = quiz.questions[state.idx];
  if (!q) return;

  updateProgress(playBox);

  const slot = $('#questionSlot', playBox);
  const feedback = $('#feedbackSlot', playBox);

  setText(slot, '');
  setText(feedback, '');

  slot.appendChild(renderQuestionCard(q));

  // visa senaste feedback om den finns
  const g = state.graded[q.id];
  if (g?.feedbackText) setText(feedback, g.feedbackText);
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
   Answer saving
============================================================ */
function saveAnswer(qid, type, value, playBox) {
  state.answers[qid] = { type, value };
  if (playBox) updateProgress(playBox);
}

/* ============================================================
   Input renderers
============================================================ */
function renderMCQ(q, ans) {
  const wrap = document.createElement('div');
  const opts = Array.isArray(q.options) ? q.options : [];
  const name = `mcq-${q.id}`;

  const playBox = $('#playBox');

  for (let i = 0; i < opts.length; i++) {
    const row = document.createElement('label');
    row.className = 'row';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = String(i);
    input.checked = String(ans.value ?? '') === String(i);
    input.addEventListener('change', () => saveAnswer(q.id, 'mcq', i, playBox));

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

  const playBox = $('#playBox');

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
      saveAnswer(q.id, 'multi', Array.from(cur), playBox);
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
  const playBox = $('#playBox');

  const make = (labelText, val) => {
    const row = document.createElement('label');
    row.className = 'row';

    const input = document.createElement('input');
    input.type = 'radio';
    input.name = name;
    input.value = val;
    input.checked = cur === val;
    input.addEventListener('change', () => saveAnswer(q.id, 'tf', val, playBox));

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
  const playBox = $('#playBox');

  const t = document.createElement('textarea');
  t.rows = 6;
  t.className = 'input';
  t.placeholder = 'Skriv ditt svar...';
  t.value = String(ans.value ?? '');
  t.addEventListener('input', () => saveAnswer(q.id, 'text', t.value, playBox));

  const hint = document.createElement('div');
  hint.className = 'muted';
  setText(hint, 'Text rättas via keywords. Stavningsfel kan ge poängavdrag.');

  wrap.appendChild(t);
  wrap.appendChild(hint);
  return wrap;
}

function renderMatch(q, ans) {
  const wrap = document.createElement('div');
  const playBox = $('#playBox');

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
  t.addEventListener('input', () => saveAnswer(q.id, 'match', t.value, playBox));

  const hint = document.createElement('div');
  hint.className = 'muted';
  setText(hint, 'Delpoäng ges per rätt par (A, B, C...).');

  wrap.appendChild(list);
  wrap.appendChild(t);
  wrap.appendChild(hint);
  return wrap;
}

/* ============================================================
   Grade current (NYTT: poäng + tydlig feedback)
============================================================ */
function gradeCurrent(playBox) {
  const quiz = state.quiz;
  if (!quiz) return;

  const q = quiz.questions[state.idx];
  if (!q) return;

  const userValue = state.answers[q.id]?.value;
  const answered = isAnswered(q, userValue);

  if (!answered) {
    const msg = 'Ej svarad — fyll i ett svar först.';
    setText($('#feedbackSlot', playBox), msg);
    toast(msg, 'info');
    return;
  }

  const g = gradeQuestion(q, userValue);
  state.graded[q.id] = g;

  const p = pointsForQuestion(q, true, g);
  const maxP = SCORE_CONFIG.pointsPerQuestion;

  let fb = '';

  if (q.type === 'match') {
    const okCount = Number(g?.detail?.okCount ?? 0);
    const needLen = Number(g?.detail?.needLen ?? 0);
    if (needLen > 0 && okCount === needLen) fb = `✅ Helt rätt (${okCount}/${needLen}) • Poäng ${fmtPoints(p)}/${maxP}`;
    else if (needLen > 0 && okCount > 0) fb = `🟨 Delvis rätt (${okCount}/${needLen}) • Poäng ${fmtPoints(p)}/${maxP}`;
    else fb = `❌ Fel (0/${needLen || 0}) • Poäng 0/${maxP}`;
  } else if (q.type === 'text') {
    const typos = Array.isArray(g?.detail?.typos) ? g.detail.typos : [];
    const typoMsg = typos.length ? ` • stavning: "${typos[0].typed}" → "${typos[0].expected}"` : '';
    fb = (g.ok ? '✅ Rätt' : '❌ Inte helt rätt') + ` • Poäng ${fmtPoints(p)}/${maxP}` + typoMsg;
  } else {
    fb = (g.ok ? '✅ Rätt' : '❌ Fel') + ` • Poäng ${fmtPoints(p)}/${maxP}`;
  }

  g.feedbackText = fb;

  setText($('#feedbackSlot', playBox), fb);
  updateProgress(playBox);

  toast(g.ok ? 'Rätt!' : (q.type === 'match' && (g.detail?.okCount ?? 0) > 0 ? 'Delvis rätt.' : 'Fel.'), g.ok ? 'success' : 'info');
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

  const s = computeScoreSummary(quiz, state.answers, state.graded);

  const resultSummary = $('#resultSummary', resultBox);

  const basePctTxt = `${Math.round(s.basePct * 100)}%`;
  const bonusTxt = s.bonusPct > 0 ? ` (+${Math.round(s.bonusPct * 100)}%)` : '';
  const finalPctTxt = `${Math.round(s.finalPct * 100)}%`;

  const headline =
    `Poäng: ${fmtPoints(s.earnedPoints)}/${fmtPoints(s.maxPoints)} • ` +
    `Rätt: ${s.correctCount}/${s.total} • ` +
    `Svarade: ${s.answeredCount}/${s.total}`;

  let statusLine = '';
  if (!s.allAnswered) {
    statusLine = `Status: Ej färdig • Procent (bas): ${basePctTxt}${bonusTxt}`;
  } else {
    statusLine = `Betyg: ${s.letter} • ${s.pass ? 'GODKÄND' : 'UNDERKÄND'} • Procent: ${finalPctTxt}${bonusTxt}`;
  }

  const omdome = gradeOmdome(s.letter || 'F', s.finalPct, s);
  setText(resultSummary, `${headline}\n${statusLine}\nOmdöme: ${omdome}`);

  const list = $('#resultList', resultBox);
  setText(list, '');

  for (let i = 0; i < quiz.questions.length; i++) {
    const q = quiz.questions[i];
    const userValue = state.answers[q.id]?.value;
    const answered = isAnswered(q, userValue);

    const g = answered ? (state.graded[q.id] || gradeQuestion(q, userValue)) : { ok: false, detail: { unanswered: true } };
    if (answered) state.graded[q.id] = g;

    list.appendChild(renderResultItem(i, q, g, userValue, answered));
  }

  const restartLink = $('#restartLink', resultBox);
  if (restartLink) {
    const sp = new URLSearchParams(window.location.search);
    const qp = sp.get('quiz') || '';
    restartLink.href = qp ? `./play.html?quiz=${encodeURIComponent(qp)}` : './play.html';
  }
}

function renderResultItem(i, q, graded, userValue, answered) {
  const item = document.createElement('div');
  item.className = 'card';

  const h = document.createElement('h3');
  setText(h, `${i + 1}. ${q.q || 'Fråga'}`);
  item.appendChild(h);

  const status = document.createElement('div');
  if (!answered) {
    status.className = 'badge';
    setText(status, 'Ej svarad');
  } else if (q.type === 'match') {
    const okCount = Number(graded?.detail?.okCount ?? 0);
    const needLen = Number(graded?.detail?.needLen ?? 0);
    status.className = (needLen > 0 && okCount === needLen) ? 'badge ok' : (okCount > 0 ? 'badge' : 'badge bad');
    setText(status, needLen > 0 ? `${okCount === needLen ? 'Rätt' : okCount > 0 ? 'Delvis' : 'Fel'} (${okCount}/${needLen})` : 'Fel');
  } else {
    status.className = graded?.ok ? 'badge ok' : 'badge bad';
    setText(status, graded?.ok ? 'Rätt' : 'Fel');
  }
  item.appendChild(status);

  const points = document.createElement('div');
  points.className = 'muted';
  const p = pointsForQuestion(q, answered, graded);
  setText(points, `Poäng: ${fmtPoints(p)}/${fmtPoints(SCORE_CONFIG.pointsPerQuestion)}`);
  item.appendChild(points);

  const your = document.createElement('div');
  your.className = 'muted';
  setText(your, `Ditt svar: ${formatUserAnswer(q, userValue)}`);
  item.appendChild(your);

  const facit = document.createElement('div');
  facit.className = 'muted';
  setText(facit, `Facit: ${formatCorrectAnswer(q)}`);
  item.appendChild(facit);

  const tip = buildTipForQuestion(q, graded, answered);
  if (tip) {
    const tipEl = document.createElement('div');
    tipEl.className = 'muted';
    setText(tipEl, `Tips: ${tip}`);
    item.appendChild(tipEl);
  }

  if (q.explanation) {
    const exp = document.createElement('div');
    exp.className = 'pre';
    setText(exp, q.explanation);
    item.appendChild(exp);
  }

  return item;
}

/* ============================================================
   Format helpers (UI-only)
============================================================ */
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
