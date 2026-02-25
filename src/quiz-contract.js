/* ============================================================
   FIL: src/quiz-contract.js  (HEL FIL)
   AO-QUIZ-01A (FAS 1) — Datakontrakt + validering/normalisering
   Policy: UI-only (GitHub Pages), XSS-safe, fail-closed, inga externa libs
   Version: 1.0.0

   Export:
     - validateQuiz(quiz) -> { ok:boolean, errors:string[] }
     - normalizeQuiz(quiz) -> normalizedQuiz (sätter defaults, trim, dedupe ids)

   Quiz-format (målbild):
     quiz = {
       id: string,
       title: string,
       questions: [
         {
           id: string,
           type: 'mcq'|'multi'|'tf'|'text'|'match',
           q: string,
           options?: string[],              // mcq/multi
           correct?: number,                // mcq (index)
           correctKeys?: number[]|string[], // multi (index[]), match (keys[]), tf (['true'] etc)
           answer?: string,                 // text (fallback)
           explanation?: string,
           keywords?: string[]              // text (valfritt)
           // match: options = left items, correctKeys = array of right-item keys (eller mapping i senare AO)
         }
       ]
     }
============================================================ */

const ALLOWED_TYPES = new Set(['mcq', 'multi', 'tf', 'text', 'match']);

/* ============================================================
   Helpers (internal)
============================================================ */
function _isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function _asStr(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

function _trimStr(v) {
  return _asStr(v).trim();
}

function _path(p) {
  return p ? `${p}: ` : '';
}

function _uniqNonEmptyStrings(arr) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(arr) ? arr : []) {
    const s = _trimStr(raw);
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function _makeId(prefix, n) {
  const safe = _trimStr(prefix) || 'id';
  return `${safe}-${String(n).padStart(2, '0')}`;
}

function _coerceType(t) {
  const s = _trimStr(t).toLowerCase();
  return ALLOWED_TYPES.has(s) ? s : '';
}

function _asInt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

function _dedupeQuestionIds(questions, quizId) {
  const used = new Set();
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    let id = _trimStr(q.id);
    if (!id) id = _makeId(`${quizId || 'q'}`, i + 1);
    let base = id;
    let k = 2;
    while (used.has(id.toLowerCase())) {
      id = `${base}-${k}`;
      k++;
    }
    used.add(id.toLowerCase());
    q.id = id;
  }
}

/* ============================================================
   PUBLIC: normalizeQuiz
   - Skapar en ny, stabil struktur (ingen mutation av input)
   - Sätter defaults
   - Trim + dedupe ids
============================================================ */
export function normalizeQuiz(inputQuiz) {
  const quiz = _isObj(inputQuiz) ? inputQuiz : {};

  const out = {
    id: _trimStr(quiz.id) || 'quiz-01',
    title: _trimStr(quiz.title) || 'Quiz',
    questions: [],
  };

  const rawQs = Array.isArray(quiz.questions) ? quiz.questions : [];
  for (let i = 0; i < rawQs.length; i++) {
    const raw = _isObj(rawQs[i]) ? rawQs[i] : {};
    const type = _coerceType(raw.type) || 'mcq';

    const qOut = {
      id: _trimStr(raw.id), // dedup + default senare
      type,
      q: _trimStr(raw.q),
    };

    // Gemensamt (valfritt)
    const explanation = _trimStr(raw.explanation);
    if (explanation) qOut.explanation = explanation;

    // keywords för text (valfritt)
    if (Array.isArray(raw.keywords)) {
      const kw = _uniqNonEmptyStrings(raw.keywords);
      if (kw.length) qOut.keywords = kw;
    }

    if (type === 'mcq' || type === 'multi') {
      const opts = Array.isArray(raw.options) ? raw.options.map(_trimStr).filter(Boolean) : [];
      qOut.options = opts;

      if (type === 'mcq') {
        const ci = _asInt(raw.correct);
        if (ci !== null) qOut.correct = ci;
      } else {
        // multi: correctKeys som index-array
        const ck = Array.isArray(raw.correctKeys) ? raw.correctKeys : [];
        const idx = [];
        for (const v of ck) {
          const n = _asInt(v);
          if (n === null) continue;
          idx.push(n);
        }
        if (idx.length) qOut.correctKeys = Array.from(new Set(idx));
      }
    }

    if (type === 'tf') {
      // Tillåt: correctKeys ['true'] eller correct true/false
      const b = raw.correct;
      if (typeof b === 'boolean') {
        qOut.correctKeys = [b ? 'true' : 'false'];
      } else if (Array.isArray(raw.correctKeys) && raw.correctKeys.length) {
        qOut.correctKeys = raw.correctKeys.map((x) => _trimStr(x).toLowerCase()).filter(Boolean);
      }
    }

    if (type === 'text') {
      const ans = _trimStr(raw.answer);
      if (ans) qOut.answer = ans;
      // keywords redan hanterat ovan
    }

    if (type === 'match') {
      // Enkel baseline:
      // - options: vänster-lista
      // - correctKeys: höger-nycklar (samma längd som options)
      const left = Array.isArray(raw.options) ? raw.options.map(_trimStr).filter(Boolean) : [];
      qOut.options = left;

      const right = Array.isArray(raw.correctKeys) ? raw.correctKeys.map(_trimStr).filter(Boolean) : [];
      if (right.length) qOut.correctKeys = right;
    }

    out.questions.push(qOut);
  }

  // Dedup + defaults för fråga-id
  _dedupeQuestionIds(out.questions, out.id);

  // Trim title/id en gång till (för säkerhet)
  out.id = _trimStr(out.id) || 'quiz-01';
  out.title = _trimStr(out.title) || 'Quiz';

  return out;
}

/* ============================================================
   PUBLIC: validateQuiz
   - Fail-closed: aldrig throw
   - Returnerar samlad fel-lista
============================================================ */
export function validateQuiz(inputQuiz) {
  const errors = [];

  try {
    if (!_isObj(inputQuiz)) {
      errors.push('quiz: Måste vara ett objekt.');
      return { ok: false, errors };
    }

    const quiz = normalizeQuiz(inputQuiz);

    if (!quiz.id) errors.push('quiz.id: Saknas.');
    if (!quiz.title) errors.push('quiz.title: Saknas.');

    if (!Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      errors.push('quiz.questions: Måste finnas minst 1 fråga.');
      return { ok: false, errors };
    }

    // ID-unikhet
    const seen = new Set();
    for (let i = 0; i < quiz.questions.length; i++) {
      const q = quiz.questions[i];
      const p = `questions[${i}]`;

      const id = _trimStr(q.id);
      if (!id) errors.push(`${p}.id: Saknas.`);
      const key = id.toLowerCase();
      if (seen.has(key)) errors.push(`${p}.id: Dubblett id "${id}".`);
      seen.add(key);

      const type = _coerceType(q.type);
      if (!type) errors.push(`${p}.type: Ogiltig type "${_asStr(q.type)}".`);

      if (!_trimStr(q.q)) errors.push(`${p}.q: Frågetext saknas.`);

      if (type === 'mcq') {
        const opts = Array.isArray(q.options) ? q.options : [];
        if (opts.length < 2) errors.push(`${p}.options: mcq kräver minst 2 alternativ.`);
        const ci = _asInt(q.correct);
        if (ci === null) errors.push(`${p}.correct: mcq kräver "correct" (index).`);
        else if (ci < 0 || ci >= opts.length) errors.push(`${p}.correct: Index utanför options.`);
      }

      if (type === 'multi') {
        const opts = Array.isArray(q.options) ? q.options : [];
        if (opts.length < 2) errors.push(`${p}.options: multi kräver minst 2 alternativ.`);
        const ck = Array.isArray(q.correctKeys) ? q.correctKeys : [];
        if (ck.length === 0) errors.push(`${p}.correctKeys: multi kräver minst 1 korrekt index.`);
        for (const v of ck) {
          const n = _asInt(v);
          if (n === null) {
            errors.push(`${p}.correctKeys: innehåller ogiltigt index "${_asStr(v)}".`);
            continue;
          }
          if (n < 0 || n >= opts.length) errors.push(`${p}.correctKeys: index ${n} utanför options.`);
        }
      }

      if (type === 'tf') {
        const ck = Array.isArray(q.correctKeys) ? q.correctKeys : [];
        if (ck.length === 0) errors.push(`${p}.correctKeys: tf kräver true/false.`);
        else {
          const v = _trimStr(ck[0]).toLowerCase();
          if (v !== 'true' && v !== 'false') errors.push(`${p}.correctKeys: måste vara 'true' eller 'false'.`);
        }
      }

      if (type === 'text') {
        const ans = _trimStr(q.answer);
        const kw = Array.isArray(q.keywords) ? q.keywords : [];
        if (!ans && kw.length === 0) errors.push(`${p}: text kräver "answer" eller "keywords".`);
      }

      if (type === 'match') {
        const left = Array.isArray(q.options) ? q.options : [];
        const right = Array.isArray(q.correctKeys) ? q.correctKeys : [];
        if (left.length < 2) errors.push(`${p}.options: match kräver minst 2 vänster-objekt.`);
        if (right.length !== left.length) errors.push(`${p}.correctKeys: måste ha samma längd som options.`);
      }
    }
  } catch (e) {
    errors.push(`quiz: Internt valideringsfel (fail-closed). ${_asStr(e?.message || e)}`);
  }

  return { ok: errors.length === 0, errors };
}
