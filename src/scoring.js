/* ============================================================
   FIL: src/scoring.js  (HEL FIL)
   AO-QUIZ-SCORE-MODULE-01 (FAS 1) — Poängregler + bedömning + betyg + tips
   Policy: UI-only, XSS-safe (data-only), inga externa libs
   Version: 1.0.0

   Syfte:
   - Flytta ALL scoring/bedömning ur src/play.js
   - Play.js ska bara rendera UI + samla svar + anropa scoring-funktioner

   Innehåll:
   - isAnswered()
   - gradeQuestion() inkl:
       * mcq/multi/tf/text/match
       * text: keyword scoring (B) + stavningsfeedback
       * match: okCount/needLen + missingKeys
   - pointsForQuestion(): 0..3, match ger delpoäng
   - textPenaltyFactor(): avdrag vid stavningsfel (valfritt men aktiverat)
   - computeScoreSummary(): totalpoäng, procent, bonus, betyg, godkänd/underkänd
   - gradeLetterFromPct(): A–F (din skala)
   - gradeOmdome(): pepp/next-step
   - buildTipForQuestion(): tips per fråga

   Not:
   - “Svarade x/y” räknas här och kan visas i UI (progress).
============================================================ */

export const SCORE_CONFIG = {
  pointsPerQuestion: 3,
  bonusAllAnswered: 0.05, // +5%
  bonusAllCorrect: 0.10,  // +10%

  // Text scoring (B)
  textNeedMin: 2,
  textNeedRatio: 0.33,

  // Stavningsavdrag (om text blir “rätt men slarvigt”)
  // 1 typo => -10%, 2 => -20% ... cap 30%
  typoPenaltyPer: 0.10,
  typoPenaltyCap: 0.30
};

/* ============================================================
   Helpers
============================================================ */
function clamp01(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function fmtPoints(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return '0';
  const isInt = Math.abs(n - Math.round(n)) < 1e-9;
  return isInt ? String(Math.round(n)) : n.toFixed(2);
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
   MATCH: parse "A=..., B:..., C-..." robust newline/;
============================================================ */
export function parseMatchInput(raw) {
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
   TEXT: keyword scoring (B) + stavningsfeedback
============================================================ */
function tokenizeWords(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9åäö]+/gi, ' ')
    .trim()
    .split(/\s+/g)
    .filter(Boolean);
}

function levenshtein(a, b, maxDist) {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;

  const m = a.length;
  const n = b.length;
  const prev = new Array(n + 1);
  const cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;

  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let bestInRow = cur[0];

    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = v;
      if (v < bestInRow) bestInRow = v;
    }

    if (bestInRow > maxDist) return maxDist + 1;
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }

  return prev[n];
}

function fuzzyFindClosestWord(keyword, userWords) {
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
      if (d === 1) break;
    }
  }
  return best;
}

export function scoreTextAnswer(userText, keywords) {
  const raw = String(userText ?? '');
  const inputNorm = normalizeTextForMatch(raw);
  const userWords = tokenizeWords(raw);

  const kws = uniqLower(keywords)
    .map((k) => normalizeTextForMatch(k))
    .filter(Boolean);

  if (!kws.length) {
    return { ok: false, hits: 0, need: 0, matched: [], missing: [], typos: [] };
  }

  const need = Math.max(
    SCORE_CONFIG.textNeedMin,
    Math.ceil(kws.length * SCORE_CONFIG.textNeedRatio)
  );

  const matched = [];
  const typos = [];

  for (const k of kws) {
    if (inputNorm.includes(k)) {
      matched.push(k);
      continue;
    }

    const closest = fuzzyFindClosestWord(k, userWords);
    if (closest && closest.dist > 0) {
      // Vi räknar det som träff men loggar typo för feedback och ev avdrag.
      matched.push(k);
      typos.push({ typed: closest.word, expected: k, dist: closest.dist });
    }
  }

  const matchedUniq = Array.from(new Set(matched));
  const hits = matchedUniq.length;

  const missing = kws.filter((k) => !matchedUniq.includes(k)).slice(0, 4);

  const seenExpected = new Set();
  const typosUniq = [];
  for (const t of typos) {
    if (seenExpected.has(t.expected)) continue;
    seenExpected.add(t.expected);
    typosUniq.push(t);
  }

  return {
    ok: hits >= need,
    hits,
    need,
    matched: matchedUniq,
    missing,
    typos: typosUniq
  };
}

/* ============================================================
   Answered detection
============================================================ */
export function isAnswered(q, userValue) {
  if (userValue === null || userValue === undefined) return false;

  if (q.type === 'mcq') return Number.isFinite(Number(userValue));
  if (q.type === 'tf') {
    const v = String(userValue).toLowerCase();
    return v === 'true' || v === 'false';
  }
  if (q.type === 'multi') return Array.isArray(userValue) && userValue.length > 0;
  if (q.type === 'text') return String(userValue).trim().length > 0;
  if (q.type === 'match') return String(userValue).trim().length > 0;

  return false;
}

/* ============================================================
   Grading per question
   Return:
     { ok: boolean, detail: object }
============================================================ */
export function gradeQuestion(q, userValue) {
  const type = q.type;

  if (type === 'mcq') {
    const correct = Number.isFinite(q.correct) ? q.correct : null;
    const u = (userValue === null || userValue === undefined) ? null : Number(userValue);
    const ok = (correct !== null) && (u === correct);
    return { ok, detail: { correct, user: u } };
  }

  if (type === 'multi') {
    const correct = Array.isArray(q.correctKeys)
      ? q.correctKeys.map((n) => Number(n)).filter(Number.isFinite)
      : [];
    const user = Array.isArray(userValue)
      ? userValue.map((n) => Number(n)).filter(Number.isFinite)
      : [];
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
    const missingKeys = [];

    for (let i = 0; i < needLen; i++) {
      const key = String.fromCharCode(65 + i);
      const exp = String(right[i] ?? '').trim();
      const u = String(parsed.map[key] ?? '').trim();

      if (normalizeTextForMatch(u) && normalizeTextForMatch(u) === normalizeTextForMatch(exp)) {
        okCount++;
      } else {
        missingKeys.push(key);
      }
    }

    const ok = needLen > 0 && okCount === needLen;
    return { ok, detail: { okCount, needLen, missingKeys } };
  }

  return { ok: false, detail: { error: 'Okänd frågetyp' } };
}

/* ============================================================
   Stavningsavdrag (text)
   - Om textfråga är OK men har typos => avdrag på poängen
============================================================ */
export function textPenaltyFactor(graded) {
  const typos = Array.isArray(graded?.detail?.typos) ? graded.detail.typos : [];
  if (!typos.length) return 1;

  const rawPenalty = typos.length * SCORE_CONFIG.typoPenaltyPer;
  const penalty = Math.min(SCORE_CONFIG.typoPenaltyCap, rawPenalty);

  return Math.max(0, 1 - penalty);
}

/* ============================================================
   Points per question
   - match: delpoäng
   - text: full poäng om ok, men ev stavningsavdrag
============================================================ */
export function pointsForQuestion(q, answered, graded) {
  if (!answered) return 0;

  if (q.type === 'match') {
    const okCount = Number(graded?.detail?.okCount ?? 0);
    const needLen = Number(graded?.detail?.needLen ?? 0);
    if (!needLen || needLen <= 0) return 0;
    const ratio = clamp01(okCount / needLen);
    return SCORE_CONFIG.pointsPerQuestion * ratio;
  }

  if (q.type === 'text') {
    if (!graded?.ok) return 0;
    const base = SCORE_CONFIG.pointsPerQuestion;
    return base * textPenaltyFactor(graded);
  }

  return graded?.ok ? SCORE_CONFIG.pointsPerQuestion : 0;
}

/* ============================================================
   Grade A–F (din skala)
============================================================ */
export function gradeLetterFromPct(p) {
  const pct = clamp01(p);
  if (pct < 0.35) return 'F';
  if (pct < 0.55) return 'E';
  if (pct < 0.70) return 'D';
  if (pct < 0.80) return 'C';
  if (pct < 0.90) return 'B';
  return 'A';
}

export function isPassingLetter(letter) {
  return letter !== 'F';
}

export function gradeOmdome(letter, finalPct, summary) {
  const pct = Math.round(clamp01(finalPct) * 100);
  const answered = summary.answeredCount;
  const total = summary.total;

  if (answered < total) {
    return `Du är på väg: du har svarat på ${answered}/${total}. Gör klart provet så får du betyg och tydlig status.`;
  }

  switch (letter) {
    case 'A':
      return `Starkt! Du har riktigt bra koll (${pct}%). Nästa steg: testa ett nytt prov eller höj nivån.`;
    case 'B':
      return `Bra jobbat (${pct}%). Nästa steg: finslipa de få fel du hade och kör om för A.`;
    case 'C':
      return `Helt okej (${pct}%). Nästa steg: fokusera på de fel du fick och läs förklaringarna.`;
    case 'D':
      return `Du är nära (${pct}%). Nästa steg: repetera förklaringsrutorna på fel-frågorna och testa igen.`;
    case 'E':
      return `Godkänd (${pct}%). Nästa steg: bygg trygghet—kör om och sikta på D/C.`;
    case 'F':
    default:
      return `Inte godkänt än (${pct}%). Nästa steg: gå igenom fel-frågorna en och en och gör provet igen direkt efter.`;
  }
}

/* ============================================================
   Tips per fråga (kort)
============================================================ */
export function buildTipForQuestion(q, graded, answered) {
  if (!answered) return 'Svara på frågan för att få poäng.';

  if (q.type === 'match') {
    const miss = Array.isArray(graded?.detail?.missingKeys) ? graded.detail.missingKeys : [];
    if (miss.length) return `Fyll i fler par. Saknas: ${miss.slice(0, 6).join(', ')}${miss.length > 6 ? '…' : ''}.`;
    return '';
  }

  if (q.type === 'text') {
    if (graded?.ok) {
      const typos = Array.isArray(graded?.detail?.typos) ? graded.detail.typos : [];
      if (typos.length) return `Bra tänkt, men rätta stavningen: "${typos[0].typed}" → "${typos[0].expected}".`;
      return '';
    }
    const missing = Array.isArray(graded?.detail?.missing) ? graded.detail.missing : [];
    if (missing.length) return `Försök nämna: ${missing.join(', ')}.`;
    return 'Skriv lite mer detaljer och försök använda nyckelorden.';
  }

  if (graded?.ok) return '';
  return 'Läs förklaringen och jämför med facit, försök sedan igen.';
}

/* ============================================================
   Summary (total)
   Input:
     quiz, answers (map), gradedCache (map) — gradedCache uppdateras vid behov
   Output:
     { total, answeredCount, correctCount, earnedPoints, maxPoints,
       basePct, bonusPct, finalPct, allAnswered, allCorrect, letter, pass }
============================================================ */
export function computeScoreSummary(quiz, answers, gradedCache) {
  const total = Array.isArray(quiz?.questions) ? quiz.questions.length : 0;

  let answeredCount = 0;
  let correctCount = 0;
  let earnedPoints = 0;

  for (const q of (quiz?.questions || [])) {
    const userValue = answers?.[q.id]?.value;
    const answered = isAnswered(q, userValue);
    if (answered) answeredCount++;

    const g = answered
      ? (gradedCache?.[q.id] || gradeQuestion(q, userValue))
      : null;

    if (g && gradedCache) gradedCache[q.id] = g;

    if (answered && g?.ok) correctCount++;

    earnedPoints += pointsForQuestion(q, answered, g);
  }

  const maxPoints = total * SCORE_CONFIG.pointsPerQuestion;
  const basePct = maxPoints > 0 ? (earnedPoints / maxPoints) : 0;

  const allAnswered = answeredCount === total && total > 0;
  const allCorrect = correctCount === total && total > 0;

  let bonusPct = 0;
  if (allAnswered) bonusPct += SCORE_CONFIG.bonusAllAnswered;
  if (allCorrect) bonusPct += SCORE_CONFIG.bonusAllCorrect;

  const finalPct = Math.min(1, basePct + bonusPct);

  const letter = allAnswered ? gradeLetterFromPct(finalPct) : null;
  const pass = allAnswered ? isPassingLetter(letter) : null;

  return {
    total,
    answeredCount,
    correctCount,
    earnedPoints,
    maxPoints,
    basePct,
    bonusPct,
    finalPct,
    allAnswered,
    allCorrect,
    letter,
    pass
  };
}
