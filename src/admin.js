/* ============================================================
   FIL: src/admin.js  (HEL FIL)
   PATCH: AO-QUIZ-01E (FAS 2) — “AI-flöde utan backend”
   Policy: UI-only, XSS-safe (textContent), fail-closed, inga externa libs
   Storage key: QUIZAPP_PROVS_V1
   Version: 1.1.0

   Kräver:
     - src/quiz-contract.js (validateQuiz, normalizeQuiz)
     - src/ui.js (el, setText, toast)

   NYTT I 01E:
     - Bulk-text → prompt-generator (kräver JSON enligt kontrakt)
     - AI-JSON import (validera → spara fail-closed → redo att exportera)
============================================================ */

import { validateQuiz, normalizeQuiz } from './quiz-contract.js';
import { el, setText, toast } from './ui.js';

const STORAGE_KEY = 'QUIZAPP_PROVS_V1';

const $ = (sel, root) => el(sel, root);

function safeParseJSON(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

function safeString(v) {
  return (v === null || v === undefined) ? '' : String(v);
}

function dedupeId(base, usedLower) {
  let id = safeString(base).trim();
  if (!id) id = 'quiz';
  let out = id;
  let k = 2;
  while (usedLower.has(out.toLowerCase())) {
    out = `${id}-${k}`;
    k++;
  }
  usedLower.add(out.toLowerCase());
  return out;
}

function nowId() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `quiz-${y}${m}${day}-${hh}${mm}`;
}

/* ============================================================
   State (local)
============================================================ */
const state = {
  provs: {},   // [id]: quizObj
  order: [],   // [id...]
  activeId: '',
  search: ''
};

/* ============================================================
   Storage (fail-closed)
============================================================ */
function loadStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return true;

  const p = safeParseJSON(raw);
  if (!p.ok || !p.value || typeof p.value !== 'object') return false;

  const obj = p.value;
  const provs = (obj.provs && typeof obj.provs === 'object') ? obj.provs : {};
  const order = Array.isArray(obj.order) ? obj.order.map((x) => safeString(x)).filter(Boolean) : [];

  // fail-closed: endast quiz som klarar validateQuiz får in
  const cleanProvs = {};
  const cleanOrder = [];

  for (const id of order) {
    const q = provs[id];
    const v = validateQuiz(q);
    if (!v.ok) continue;
    const norm = normalizeQuiz(q);
    cleanProvs[norm.id] = norm;
    cleanOrder.push(norm.id);
  }

  // även provs som inte ligger i order, men är ok
  for (const [k, q] of Object.entries(provs)) {
    if (cleanProvs[k]) continue;
    const v = validateQuiz(q);
    if (!v.ok) continue;
    const norm = normalizeQuiz(q);
    cleanProvs[norm.id] = norm;
    if (!cleanOrder.includes(norm.id)) cleanOrder.push(norm.id);
  }

  state.provs = cleanProvs;
  state.order = cleanOrder;
  state.activeId = cleanOrder[0] || '';
  return true;
}

function saveStorage() {
  try {
    const payload = { provs: state.provs, order: state.order };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

/* ============================================================
   Boot
============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  const ok = loadStorage();
  wireUI();
  renderAll();

  if (!ok) {
    setStatus('Korrupt storage (läste inte in).', 'danger');
    toast('Korrupt localStorage: laddade inte in data.', 'error');
  } else {
    setStatus(state.order.length ? 'Redo' : 'Inga prov än', state.order.length ? 'ok' : '');
  }
});

/* ============================================================
   UI refs
============================================================ */
function refs() {
  return {
    statusPill: $('#statusPill'),

    newQuizBtn: $('#newQuizBtn'),
    quizSearch: $('#quizSearch'),
    quizList: $('#quizList'),

    noSelectionBox: $('#noSelectionBox'),
    editorBox: $('#editorBox'),

    quizTitle: $('#quizTitle'),
    quizId: $('#quizId'),
    deleteQuizBtn: $('#deleteQuizBtn'),

    newQType: $('#newQType'),
    addQBtn: $('#addQBtn'),
    questionList: $('#questionList'),
    qErrorBox: $('#qErrorBox'),

    copyJsonBtn: $('#copyJsonBtn'),

    // Manuell import
    importArea: $('#importArea'),
    importBtn: $('#importBtn'),
    importErrorBox: $('#importErrorBox'),

    // AO-QUIZ-01E — AI-flöde
    bulkQuestions: $('#bulkQuestions'),
    makePromptBtn: $('#makePromptBtn'),
    aiPromptOut: $('#aiPromptOut'),
    aiJsonArea: $('#aiJsonArea'),
    aiImportBtn: $('#aiImportBtn'),
    aiErrorBox: $('#aiErrorBox')
  };
}

function setStatus(text, mode) {
  const r = refs();
  const pill = r.statusPill;
  if (!pill) return;
  pill.className = 'pill';
  if (mode === 'danger') pill.classList.add('danger');
  if (mode === 'ok') pill.classList.add('ok');
  setText(pill, text);
}

/* ============================================================
   Wire events
============================================================ */
function wireUI() {
  const r = refs();

  r.newQuizBtn?.addEventListener('click', () => {
    createNewQuiz();
    renderAll();
  });

  r.quizSearch?.addEventListener('input', () => {
    state.search = safeString(r.quizSearch.value).trim().toLowerCase();
    renderQuizList();
  });

  r.quizTitle?.addEventListener('input', () => {
    const q = getActiveQuiz();
    if (!q) return;
    q.title = safeString(r.quizTitle.value).trim();
    saveActiveQuizFailClosed(q);
    renderQuizList();
  });

  r.quizId?.addEventListener('input', () => {
    const q = getActiveQuiz();
    if (!q) return;
    const newIdRaw = safeString(r.quizId.value).trim();
    if (!newIdRaw) return; // fail-closed: tomt = behåll
    renameActiveQuizId(newIdRaw);
    renderAll();
  });

  r.deleteQuizBtn?.addEventListener('click', () => {
    deleteActiveQuiz();
    renderAll();
  });

  r.addQBtn?.addEventListener('click', () => {
    addQuestion(safeString(r.newQType?.value).trim() || 'mcq');
    renderAll();
  });

  r.copyJsonBtn?.addEventListener('click', async () => {
    const q = getActiveQuiz();
    if (!q) return;
    const norm = normalizeQuiz(q);
    const v = validateQuiz(norm);
    if (!v.ok) {
      showErrors(v.errors, 'q');
      toast('Quiz är inte giltigt än. Fixa fel innan export.', 'error');
      return;
    }
    const text = JSON.stringify(norm, null, 2);
    const ok = await copyToClipboard(text);
    toast(ok ? 'JSON kopierad.' : 'Kunde inte kopiera (browser-block).', ok ? 'success' : 'warn');
  });

  // Manuell import
  r.importBtn?.addEventListener('click', () => {
    importFromTextarea();
  });

  // AO-QUIZ-01E — AI flow
  r.makePromptBtn?.addEventListener('click', async () => {
    clearErrors('ai');
    const bulk = safeString(r.bulkQuestions?.value);
    const draft = parseBulkQuestions(bulk);

    if (draft.items.length === 0) {
      showErrors(['Bulk-text saknar frågor. Skriv minst 1 rad med en fråga.'], 'ai');
      toast('Bulk saknar frågor.', 'error');
      return;
    }

    const qz = getActiveQuiz();
    const title = qz?.title ? safeString(qz.title).trim() : 'Nytt prov';
    const prompt = buildAiPrompt(title, draft.items);

    if (r.aiPromptOut) r.aiPromptOut.value = prompt;

    const ok = await copyToClipboard(prompt);
    toast(ok ? 'AI-prompt kopierad.' : 'AI-prompt skapad (kunde ej auto-kopiera).', ok ? 'success' : 'info');
  });

  r.aiImportBtn?.addEventListener('click', () => {
    importAiJson();
  });
}

/* ============================================================
   Core ops
============================================================ */
function getActiveQuiz() {
  const id = state.activeId;
  return id ? state.provs[id] : null;
}

function setActive(id) {
  state.activeId = id || '';
}

function createNewQuiz() {
  const used = new Set(state.order.map((x) => x.toLowerCase()));
  const id = dedupeId(nowId(), used);

  const quiz = normalizeQuiz({
    id,
    title: 'Nytt prov',
    questions: []
  });

  state.provs[quiz.id] = quiz;
  state.order.unshift(quiz.id);
  state.activeId = quiz.id;
  saveStorage();
  setStatus('Skapade nytt prov', 'ok');
}

function deleteActiveQuiz() {
  const id = state.activeId;
  if (!id || !state.provs[id]) return;

  delete state.provs[id];
  state.order = state.order.filter((x) => x !== id);

  state.activeId = state.order[0] || '';
  saveStorage();
  setStatus('Tog bort prov', 'ok');
}

function renameActiveQuizId(newIdRaw) {
  const cur = getActiveQuiz();
  if (!cur) return;

  const oldId = cur.id;
  const used = new Set(Object.keys(state.provs).map((x) => x.toLowerCase()).filter((x) => x !== oldId.toLowerCase()));
  const newId = dedupeId(newIdRaw, used);

  if (newId.toLowerCase() === oldId.toLowerCase()) return;

  const next = normalizeQuiz({ ...cur, id: newId });
  delete state.provs[oldId];
  state.provs[next.id] = next;

  state.order = state.order.map((x) => (x === oldId ? next.id : x));
  state.activeId = next.id;

  saveStorage();
  setStatus('Bytte quiz ID', 'ok');
}

function saveActiveQuizFailClosed(quizCandidate) {
  const norm = normalizeQuiz(quizCandidate);
  state.provs[norm.id] = norm;

  const v = validateQuiz(norm);
  if (!v.ok) {
    showErrors(v.errors, 'q');
    setStatus('Fel i quiz (ej exportklar)', 'danger');
  } else {
    clearErrors('q');
    setStatus('OK', 'ok');
  }
  saveStorage();
}

function addQuestion(type) {
  const qz = getActiveQuiz();
  if (!qz) return;

  const idx = Array.isArray(qz.questions) ? qz.questions.length + 1 : 1;
  const qid = `q-${String(idx).padStart(2, '0')}`;

  const base = { id: qid, type, q: '' };

  if (type === 'mcq' || type === 'multi') {
    base.options = ['Alternativ 1', 'Alternativ 2'];
    if (type === 'mcq') base.correct = 0;
    if (type === 'multi') base.correctKeys = [0];
  } else if (type === 'tf') {
    base.correctKeys = ['true'];
  } else if (type === 'text') {
    base.keywords = ['nyckelord'];
    base.answer = '';
  } else if (type === 'match') {
    base.options = ['Vänster 1', 'Vänster 2'];
    base.correctKeys = ['Höger 1', 'Höger 2'];
  }

  qz.questions = Array.isArray(qz.questions) ? qz.questions : [];
  qz.questions.push(base);

  saveActiveQuizFailClosed(qz);
}

function removeQuestion(qIndex) {
  const qz = getActiveQuiz();
  if (!qz || !Array.isArray(qz.questions)) return;
  qz.questions.splice(qIndex, 1);
  saveActiveQuizFailClosed(qz);
}

function moveQuestion(qIndex, dir) {
  const qz = getActiveQuiz();
  if (!qz || !Array.isArray(qz.questions)) return;
  const j = qIndex + dir;
  if (j < 0 || j >= qz.questions.length) return;
  const tmp = qz.questions[qIndex];
  qz.questions[qIndex] = qz.questions[j];
  qz.questions[j] = tmp;
  saveActiveQuizFailClosed(qz);
}

/* ============================================================
   Import (manual)
============================================================ */
function importFromTextarea() {
  const r = refs();
  const raw = safeString(r.importArea?.value);

  clearErrors('import');

  const p = safeParseJSON(raw);
  if (!p.ok) {
    showImportError(`JSON parse-fel: ${p.error}`);
    return;
  }

  const v = validateQuiz(p.value);
  if (!v.ok) {
    showImportError(`Validering FAIL:\n- ${v.errors.join('\n- ')}`);
    return;
  }

  const norm = normalizeQuiz(p.value);

  // Fail-closed: import ska inte skriva över om något går fel vid save
  const snapshot = {
    provs: { ...state.provs },
    order: state.order.slice(),
    activeId: state.activeId
  };

  try {
    state.provs[norm.id] = norm;
    if (!state.order.includes(norm.id)) state.order.unshift(norm.id);
    state.activeId = norm.id;

    const saved = saveStorage();
    if (!saved) throw new Error('Kunde inte spara till localStorage.');

    setStatus('Import OK', 'ok');
    toast('Import OK', 'success');
    renderAll();
  } catch (e) {
    // rollback
    state.provs = snapshot.provs;
    state.order = snapshot.order;
    state.activeId = snapshot.activeId;
    saveStorage();

    showImportError(`Import avbruten (fail-closed): ${String(e?.message || e)}`);
  }
}

function showImportError(msg) {
  const r = refs();
  if (!r.importErrorBox) return;
  r.importErrorBox.style.display = '';
  setText(r.importErrorBox, msg);
  setStatus('Import FAIL', 'danger');
  toast('Import FAIL', 'error');
}

/* ============================================================
   AO-QUIZ-01E — Bulk → AI Prompt
============================================================ */
function parseBulkQuestions(rawText) {
  const raw = safeString(rawText);

  // split på tomrad, annars radvis
  const blocks = raw
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n/g)
    .map((b) => b.trim())
    .filter(Boolean);

  const items = [];
  for (const block of blocks) {
    // om blocket är flera rader: första raden = frågan, resten som hint
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    const first = lines[0];
    const { type, text } = extractTypePrefix(first);

    const hints = lines.slice(1);
    items.push({
      type: type || 'mcq',
      q: text,
      hint: hints.length ? hints.join(' ') : ''
    });
  }

  // fallback om ingen tomrad användes: ibland blir det en block med 50 rader => dela per rad
  if (items.length === 1 && blocks.length === 1) {
    const maybeMany = raw
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    if (maybeMany.length >= 3) {
      const splitItems = [];
      for (const line of maybeMany) {
        const { type, text } = extractTypePrefix(line);
        if (!text) continue;
        splitItems.push({ type: type || 'mcq', q: text, hint: '' });
      }
      return { items: splitItems };
    }
  }

  return { items };
}

function extractTypePrefix(line) {
  const s = safeString(line).trim();
  const m = s.match(/^\[(mcq|multi|tf|text|match)\]\s*(.+)$/i);
  if (!m) return { type: '', text: s };
  return { type: m[1].toLowerCase(), text: (m[2] || '').trim() };
}

function buildAiPrompt(title, items) {
  // Prompten är “hård”: JSON ONLY, exakt kontrakt.
  // Den innehåller också inputlistan så AI kan skapa frågor i ordning.
  const lines = [];

  lines.push('DU ÄR EN JSON-GENERATOR.');
  lines.push('DU MÅSTE SVARA MED ENDAST REN JSON (ingen markdown, inga kodblock, inga kommentarer, inga extra ord).');
  lines.push('');
  lines.push('UPPGIFT: Skapa ett quiz JSON-objekt som följer detta kontrakt exakt:');
  lines.push('');
  lines.push('quiz = {');
  lines.push('  "id": string,');
  lines.push('  "title": string,');
  lines.push('  "questions": [ question, ... ]');
  lines.push('}');
  lines.push('');
  lines.push('question = {');
  lines.push('  "id": string,');
  lines.push('  "type": "mcq"|"multi"|"tf"|"text"|"match",');
  lines.push('  "q": string,');
  lines.push('  "options"?: string[],');
  lines.push('  "correct"?: number,');
  lines.push('  "correctKeys"?: (number[]|string[]),');
  lines.push('  "answer"?: string,');
  lines.push('  "explanation"?: string,');
  lines.push('  "keywords"?: string[]');
  lines.push('}');
  lines.push('');
  lines.push('REGLER:');
  lines.push('1) Du måste skapa 1 question per input-rad nedan, i samma ordning.');
  lines.push('2) Sätt unika "id" för quiz och alla frågor (t.ex. "quiz-01", "q-01", "q-02"...).');
  lines.push('3) mcq: options (min 2) + correct (index 0..n-1).');
  lines.push('4) multi: options (min 2) + correctKeys (index-array, min 1).');
  lines.push('5) tf: correctKeys = ["true"] eller ["false"].');
  lines.push('6) text: välj keywords (3–8 rimliga nyckelord) och gärna answer (kort facit).');
  lines.push('7) match: options (vänster-lista) + correctKeys (höger-lista) med samma längd. Skriv tydliga par.');
  lines.push('8) Lägg "explanation" på varje fråga (kort, saklig).');
  lines.push('9) JSON måste vara giltig och får inte innehålla trailing commas.');
  lines.push('');
  lines.push(`QUIZ TITLE: ${title || 'Nytt prov'}`);
  lines.push('');
  lines.push('INPUT (skapa frågor av detta):');
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const hint = it.hint ? ` | hint: ${it.hint}` : '';
    lines.push(`${i + 1}. [${it.type}] ${it.q}${hint}`);
  }
  lines.push('');
  lines.push('SVARA NU MED ENDAST JSON-OBJEKTET.');

  return lines.join('\n');
}

/* ============================================================
   AO-QUIZ-01E — AI JSON Import (fail-closed)
============================================================ */
function importAiJson() {
  const r = refs();
  clearErrors('ai');

  const raw = safeString(r.aiJsonArea?.value);
  if (!raw.trim()) {
    showErrors(['AI-JSON är tomt. Klistra in JSON först.'], 'ai');
    toast('AI-JSON saknas.', 'error');
    return;
  }

  const p = safeParseJSON(raw);
  if (!p.ok) {
    showAiError(`JSON parse-fel: ${p.error}`);
    return;
  }

  const v = validateQuiz(p.value);
  if (!v.ok) {
    showAiError(`Validering FAIL:\n- ${v.errors.join('\n- ')}`);
    return;
  }

  const norm = normalizeQuiz(p.value);

  // Fail-closed: import ska inte skriva över om något går fel vid save
  const snapshot = {
    provs: { ...state.provs },
    order: state.order.slice(),
    activeId: state.activeId
  };

  try {
    state.provs[norm.id] = norm;
    if (!state.order.includes(norm.id)) state.order.unshift(norm.id);
    state.activeId = norm.id;

    const saved = saveStorage();
    if (!saved) throw new Error('Kunde inte spara till localStorage.');

    setStatus('AI-import OK', 'ok');
    toast('AI-import OK', 'success');

    // Smidig UX: fyll manuell import-ruta också (valfritt)
    if (r.importArea) r.importArea.value = JSON.stringify(norm, null, 2);

    renderAll();
  } catch (e) {
    // rollback
    state.provs = snapshot.provs;
    state.order = snapshot.order;
    state.activeId = snapshot.activeId;
    saveStorage();
    showAiError(`AI-import avbruten (fail-closed): ${String(e?.message || e)}`);
  }
}

function showAiError(msg) {
  const r = refs();
  if (!r.aiErrorBox) return;
  r.aiErrorBox.style.display = '';
  setText(r.aiErrorBox, msg);
  setStatus('AI-import FAIL', 'danger');
  toast('AI-import FAIL', 'error');
}

/* ============================================================
   Error boxes
============================================================ */
function showErrors(errors, which) {
  const r = refs();

  let box = null;
  if (which === 'q') box = r.qErrorBox;
  else if (which === 'import') box = r.importErrorBox;
  else if (which === 'ai') box = r.aiErrorBox;

  if (!box) return;

  box.style.display = '';
  const list = Array.isArray(errors) ? errors : [safeString(errors)];
  setText(box, `Fel:\n- ${list.join('\n- ')}`);
}

function clearErrors(which) {
  const r = refs();

  let box = null;
  if (which === 'q') box = r.qErrorBox;
  else if (which === 'import') box = r.importErrorBox;
  else if (which === 'ai') box = r.aiErrorBox;

  if (!box) return;

  box.style.display = 'none';
  setText(box, '');
}

/* ============================================================
   Render
============================================================ */
function renderAll() {
  renderQuizList();
  renderEditor();
}

function renderQuizList() {
  const r = refs();
  const list = r.quizList;

  setText(list, '');

  const items = state.order
    .map((id) => state.provs[id])
    .filter(Boolean)
    .filter((q) => {
      if (!state.search) return true;
      return safeString(q.title).toLowerCase().includes(state.search) || safeString(q.id).toLowerCase().includes(state.search);
    });

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    setText(empty, 'Inga prov matchar.');
    list.appendChild(empty);
    return;
  }

  for (const q of items) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn itemBtn';
    btn.style.justifyContent = 'space-between';

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.flexDirection = 'column';
    left.style.alignItems = 'flex-start';
    left.style.gap = '4px';

    const title = document.createElement('div');
    setText(title, q.title || 'Quiz');

    const meta = document.createElement('div');
    meta.className = 'muted mono';
    const cnt = Array.isArray(q.questions) ? q.questions.length : 0;
    setText(meta, `${q.id} • ${cnt} frågor`);

    left.appendChild(title);
    left.appendChild(meta);

    const right = document.createElement('div');
    right.className = 'pill';
    setText(right, q.id === state.activeId ? 'Vald' : 'Välj');

    btn.appendChild(left);
    btn.appendChild(right);

    btn.addEventListener('click', () => {
      setActive(q.id);
      renderEditor();
      renderQuizList();
    });

    list.appendChild(btn);
  }
}

function renderEditor() {
  const r = refs();
  const qz = getActiveQuiz();

  if (!qz) {
    r.noSelectionBox.style.display = '';
    r.editorBox.style.display = 'none';
    return;
  }

  r.noSelectionBox.style.display = 'none';
  r.editorBox.style.display = '';

  if (r.quizTitle) r.quizTitle.value = safeString(qz.title);
  if (r.quizId) r.quizId.value = safeString(qz.id);

  // validera och visa status
  const v = validateQuiz(qz);
  if (!v.ok) {
    showErrors(v.errors, 'q');
    setStatus('Fel i quiz (ej exportklar)', 'danger');
  } else {
    clearErrors('q');
    setStatus('OK', 'ok');
  }

  renderQuestions();
}

function renderQuestions() {
  const r = refs();
  const list = r.questionList;
  setText(list, '');

  const qz = getActiveQuiz();
  if (!qz) return;

  const qs = Array.isArray(qz.questions) ? qz.questions : [];
  if (qs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    setText(empty, 'Inga frågor ännu. Lägg till en fråga eller använd AI-flödet.');
    list.appendChild(empty);
    return;
  }

  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    list.appendChild(renderQuestionCard(i, q));
  }
}

function renderQuestionCard(index, q) {
  const card = document.createElement('div');
  card.className = 'qCard';

  const head = document.createElement('div');
  head.className = 'qHead';

  const left = document.createElement('div');
  left.className = 'qHeadLeft';

  const title = document.createElement('div');
  title.className = 'pill mono';
  setText(title, `#${index + 1} • ${safeString(q.type) || 'mcq'}`);

  const id = document.createElement('div');
  id.className = 'pill mono';
  setText(id, safeString(q.id) || 'q');

  left.appendChild(title);
  left.appendChild(id);

  const right = document.createElement('div');
  right.className = 'row';

  const up = document.createElement('button');
  up.type = 'button';
  up.className = 'btn mini';
  setText(up, '↑');
  up.disabled = index === 0;
  up.addEventListener('click', () => { moveQuestion(index, -1); renderAll(); });

  const down = document.createElement('button');
  down.type = 'button';
  down.className = 'btn mini';
  setText(down, '↓');
  down.disabled = index === (Array.isArray(getActiveQuiz()?.questions) ? getActiveQuiz().questions.length - 1 : false);
  down.addEventListener('click', () => { moveQuestion(index, +1); renderAll(); });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'btn mini';
  setText(del, 'Ta bort');
  del.addEventListener('click', () => { removeQuestion(index); renderAll(); });

  right.appendChild(up);
  right.appendChild(down);
  right.appendChild(del);

  head.appendChild(left);
  head.appendChild(right);

  const body = document.createElement('div');
  body.className = 'stack';
  body.style.marginTop = '10px';

  // q.id
  body.appendChild(field('Fråge-ID', q.id, (val) => {
    q.id = safeString(val).trim();
    saveActiveQuizFailClosed(getActiveQuiz());
    renderQuizList();
  }, { mono: true }));

  // type
  body.appendChild(typeSelect(q, () => {
    saveActiveQuizFailClosed(getActiveQuiz());
    renderAll();
  }));

  // q text
  body.appendChild(textAreaField('Frågetext (q)', q.q, (val) => {
    q.q = safeString(val);
    saveActiveQuizFailClosed(getActiveQuiz());
  }, 3));

  // type-specific
  if (q.type === 'mcq' || q.type === 'multi') {
    body.appendChild(textAreaField('Options (en per rad)', (Array.isArray(q.options) ? q.options.join('\n') : ''), (val) => {
      q.options = safeString(val).split('\n').map((s) => s.trim()).filter(Boolean);
      saveActiveQuizFailClosed(getActiveQuiz());
    }, 4));

    if (q.type === 'mcq') {
      body.appendChild(field('Correct index (0..)', safeString(q.correct ?? ''), (val) => {
        const n = Number(val);
        q.correct = Number.isFinite(n) ? Math.trunc(n) : 0;
        saveActiveQuizFailClosed(getActiveQuiz());
      }, { mono: true }));
    } else {
      body.appendChild(field('Correct indexar (komma) ex: 0,2', (Array.isArray(q.correctKeys) ? q.correctKeys.join(',') : ''), (val) => {
        const parts = safeString(val).split(',').map((x) => x.trim()).filter(Boolean);
        q.correctKeys = parts.map((x) => Number(x)).filter((n) => Number.isFinite(n)).map((n) => Math.trunc(n));
        saveActiveQuizFailClosed(getActiveQuiz());
      }, { mono: true }));
    }
  }

  if (q.type === 'tf') {
    body.appendChild(tfSelect(q, () => {
      saveActiveQuizFailClosed(getActiveQuiz());
    }));
  }

  if (q.type === 'text') {
    body.appendChild(textAreaField('Keywords (en per rad)', (Array.isArray(q.keywords) ? q.keywords.join('\n') : ''), (val) => {
      q.keywords = safeString(val).split('\n').map((s) => s.trim()).filter(Boolean);
      saveActiveQuizFailClosed(getActiveQuiz());
    }, 4));

    body.appendChild(textAreaField('Answer (valfritt facit)', safeString(q.answer ?? ''), (val) => {
      q.answer = safeString(val);
      saveActiveQuizFailClosed(getActiveQuiz());
    }, 3));
  }

  if (q.type === 'match') {
    body.appendChild(textAreaField('Vänster (options) en per rad', (Array.isArray(q.options) ? q.options.join('\n') : ''), (val) => {
      q.options = safeString(val).split('\n').map((s) => s.trim()).filter(Boolean);
      saveActiveQuizFailClosed(getActiveQuiz());
    }, 4));

    body.appendChild(textAreaField('Höger (correctKeys) en per rad (samma antal)', (Array.isArray(q.correctKeys) ? q.correctKeys.join('\n') : ''), (val) => {
      q.correctKeys = safeString(val).split('\n').map((s) => s.trim()).filter(Boolean);
      saveActiveQuizFailClosed(getActiveQuiz());
    }, 4));
  }

  // explanation
  body.appendChild(textAreaField('Explanation (valfritt)', safeString(q.explanation ?? ''), (val) => {
    q.explanation = safeString(val);
    saveActiveQuizFailClosed(getActiveQuiz());
  }, 3));

  card.appendChild(head);
  card.appendChild(body);

  return card;
}

/* ============================================================
   UI field helpers (DOM-safe)
============================================================ */
function field(labelText, value, onInput, opts = {}) {
  const wrap = document.createElement('div');

  const lab = document.createElement('label');
  setText(lab, labelText);

  const inp = document.createElement('input');
  inp.className = 'input' + (opts.mono ? ' mono' : '');
  inp.type = 'text';
  inp.value = safeString(value);

  inp.addEventListener('input', () => onInput(inp.value));

  wrap.appendChild(lab);
  wrap.appendChild(inp);
  return wrap;
}

function textAreaField(labelText, value, onInput, rows) {
  const wrap = document.createElement('div');

  const lab = document.createElement('label');
  setText(lab, labelText);

  const ta = document.createElement('textarea');
  ta.className = 'input mono';
  ta.rows = rows || 4;
  ta.value = safeString(value);

  ta.addEventListener('input', () => onInput(ta.value));

  wrap.appendChild(lab);
  wrap.appendChild(ta);
  return wrap;
}

function typeSelect(q, onChange) {
  const wrap = document.createElement('div');
  const lab = document.createElement('label');
  setText(lab, 'Typ');

  const sel = document.createElement('select');
  sel.className = 'input';
  const types = ['mcq', 'multi', 'tf', 'text', 'match'];

  for (const t of types) {
    const o = document.createElement('option');
    o.value = t;
    setText(o, t);
    if (t === q.type) o.selected = true;
    sel.appendChild(o);
  }

  sel.addEventListener('change', () => {
    q.type = safeString(sel.value).trim();

    // Reset fields per type (fail-closed, robust defaults)
    if (q.type === 'mcq') {
      q.options = Array.isArray(q.options) && q.options.length ? q.options : ['Alternativ 1', 'Alternativ 2'];
      q.correct = Number.isFinite(q.correct) ? q.correct : 0;
      delete q.correctKeys;
      delete q.answer;
      delete q.keywords;
    } else if (q.type === 'multi') {
      q.options = Array.isArray(q.options) && q.options.length ? q.options : ['Alternativ 1', 'Alternativ 2'];
      q.correctKeys = Array.isArray(q.correctKeys) && q.correctKeys.length ? q.correctKeys : [0];
      delete q.correct;
      delete q.answer;
      delete q.keywords;
    } else if (q.type === 'tf') {
      q.correctKeys = ['true'];
      delete q.options;
      delete q.correct;
      delete q.answer;
      delete q.keywords;
    } else if (q.type === 'text') {
      q.keywords = Array.isArray(q.keywords) && q.keywords.length ? q.keywords : ['nyckelord'];
      q.answer = safeString(q.answer ?? '');
      delete q.options;
      delete q.correct;
      delete q.correctKeys;
    } else if (q.type === 'match') {
      q.options = Array.isArray(q.options) && q.options.length ? q.options : ['Vänster 1', 'Vänster 2'];
      q.correctKeys = Array.isArray(q.correctKeys) && q.correctKeys.length ? q.correctKeys : ['Höger 1', 'Höger 2'];
      delete q.correct;
      delete q.answer;
      delete q.keywords;
    }

    onChange();
  });

  wrap.appendChild(lab);
  wrap.appendChild(sel);
  return wrap;
}

function tfSelect(q, onChange) {
  const wrap = document.createElement('div');
  const lab = document.createElement('label');
  setText(lab, 'Facit (Sant/Falskt)');

  const sel = document.createElement('select');
  sel.className = 'input';

  const a = document.createElement('option');
  a.value = 'true';
  setText(a, 'Sant');

  const b = document.createElement('option');
  b.value = 'false';
  setText(b, 'Falskt');

  const cur = Array.isArray(q.correctKeys) ? safeString(q.correctKeys[0]).toLowerCase() : 'true';
  if (cur === 'false') b.selected = true;
  else a.selected = true;

  sel.appendChild(a);
  sel.appendChild(b);

  sel.addEventListener('change', () => {
    q.correctKeys = [safeString(sel.value).toLowerCase() === 'false' ? 'false' : 'true'];
    onChange();
  });

  wrap.appendChild(lab);
  wrap.appendChild(sel);
  return wrap;
}

/* ============================================================
   Clipboard
============================================================ */
async function copyToClipboard(text) {
  const s = safeString(text);
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch { /* ignore */ }

  // fallback
  try {
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

/* ============================================================
   Ändringslogg (≤8)
   - AO-QUIZ-01E: Bulk-text → AI-prompt (copy + auto-copy)
   - AO-QUIZ-01E: AI-JSON import (validera → spara fail-closed + rollback)
   - UI: aiErrorBox stöd
============================================================ */

/* ============================================================
   Testnoteringar
   [ ] Skapa prov → klistra frågor i Bulk → “Skapa AI-prompt”
   [ ] Klistra prompt i AI → få JSON (utan kodblock) → klistra i AI-JSON → Importera
   [ ] Export “Kopiera JSON” → validering OK → testa i play.html (manualt via data-fil)
============================================================ */

/* ============================================================
   Risk / edge cases
   - AI kan svara med extra text/kodblock → import FAIL (det är avsiktligt fail-closed)
   - localStorage kan vara fullt/blockerat → import/export kan faila (rollback skyddar)
============================================================ */
