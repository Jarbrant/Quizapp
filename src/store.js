/* ============================================================
   FIL: src/store.js  (HEL FIL)
   AO-QUIZ-01A (FAS 1) — Minimal in-memory store (pub/sub)
   Policy: UI-only, fail-closed, inga externa libs
   Version: 1.0.0

   Syfte:
     - Ge en enkel, stabil state-container för kommande AO
     - INGEN persistence (inga nya storage keys)

   Export:
     - createStore(initialState?) -> store
       store.getState()
       store.setState(nextState, meta?)
       store.update(mutatorFn, meta?)  // mutatorFn får (draftClone) och ska returnera draft eller void
       store.subscribe(listener) -> unsubscribe
============================================================ */

function _isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function _cloneShallow(state) {
  // Shallow clone för att minska risk för oavsiktlig mutation.
  // (Djup-immutable kan bli för tungt; vi håller det enkelt och stabilt.)
  if (Array.isArray(state)) return state.slice();
  if (_isObj(state)) return { ...state };
  return state;
}

function _safeCall(fn, ...args) {
  try {
    fn(...args);
  } catch {
    // fail-closed: listeners får aldrig krascha appen
  }
}

export function createStore(initialState = {}) {
  const init = _isObj(initialState) ? initialState : {};

  let _state = _cloneShallow(init);
  const _listeners = new Set();

  function getState() {
    // Returnera en shallow clone för att minska muteringsrisk.
    return _cloneShallow(_state);
  }

  function _emit(meta) {
    const snapshot = getState();
    _listeners.forEach((fn) => _safeCall(fn, snapshot, meta));
  }

  function setState(nextState, meta = {}) {
    // Fail-closed: ogiltig state => behåll tidigare och emit error-meta
    if (!_isObj(nextState) && !Array.isArray(nextState)) {
      _emit({ ...meta, error: 'setState: nextState måste vara object/array.' });
      return false;
    }

    _state = _cloneShallow(nextState);
    _emit(meta);
    return true;
  }

  function update(mutatorFn, meta = {}) {
    if (typeof mutatorFn !== 'function') {
      _emit({ ...meta, error: 'update: mutatorFn måste vara function.' });
      return false;
    }

    // Arbeta på en clone för att minimera direkt mutation av _state
    const draft = _cloneShallow(_state);

    let result;
    try {
      result = mutatorFn(draft);
    } catch (e) {
      _emit({ ...meta, error: `update: mutatorFn throw: ${String(e?.message || e)}` });
      return false;
    }

    // Om mutator returnerar något, använd det. Annars använd draft.
    const next = (result !== undefined) ? result : draft;

    return setState(next, meta);
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {};

    _listeners.add(listener);

    // Returnera unsubscribe
    return () => {
      _listeners.delete(listener);
    };
  }

  return {
    getState,
    setState,
    update,
    subscribe
  };
}

/* ============================================================
   Ändringslogg (≤8)
   - Skapad: createStore() med get/set/update/subscribe
   - Fail-closed: listeners/mutator kraschar inte appen
   - Ingen persistence (inga storage keys)
============================================================ */

/* ============================================================
   Testnoteringar
   [ ] const s = createStore({ a: 1 })
   [ ] s.subscribe((st)=>console.log(st))
   [ ] s.update(d=>{ d.a = 2 })
   [ ] s.setState({ a: 3 })
   [ ] s.update(()=>{ throw new Error('x') }) => ingen crash, meta.error emit
============================================================ */

/* ============================================================
   Risk / edge cases
   - Shallow clone: nested objekt kan fortfarande muteras om man tar referenser
     (hanteras i senare AO via tydliga update-kontrakt)
============================================================ */
