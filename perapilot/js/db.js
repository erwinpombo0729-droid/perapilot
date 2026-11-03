/*
 * PeraPilot — local persistence (IndexedDB).
 * The app keeps the state in memory and sends every change here as a list of ops.
 * All ops of one user action are written in ONE IndexedDB transaction, so a
 * refresh/crash can never leave half of a transfer or half of a payment saved.
 * If IndexedDB is unavailable (e.g. some private modes) it falls back to memory
 * and the app tells the user that data will not be kept.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./logic.js'));
  else { root.PP = root.PP || {}; root.PP.DB = factory(root.PP.Logic); }
})(typeof self !== 'undefined' ? self : this, function (L) {
  'use strict';
  const DB_VERSION = 1;
  const STORES = L.COLLECTIONS.concat(['meta']);

  function reqP(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }
  function txP(tx) { return new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error || new Error('Transaction aborted')); }); }

  function stateFromRows(rows) {
    const st = L.emptyState();
    // IndexedDB returns rows ordered by random id; restore the order the user created them in.
    const key = (r) => (r.order !== undefined ? String(r.order).padStart(6, '0') + '|' : '') + (r.createdAt || '');
    L.COLLECTIONS.forEach((c) => { st[c] = (rows[c] || []).slice().sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)); });
    const meta = rows.meta || [];
    const settings = meta.find((m) => m.id === 'settings');
    st.settings = settings ? Object.assign(L.defaultSettings(), settings) : L.defaultSettings();
    return { state: st, app: meta.find((m) => m.id === 'app') || null, hasSettings: !!settings };
  }

  /** Open the real IndexedDB-backed store. */
  async function openIndexedDB(name) {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available');
    const db = await new Promise((res, rej) => {
      const req = indexedDB.open(name || 'perapilot-db', DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        STORES.forEach((s) => { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
      req.onblocked = () => rej(new Error('Database is blocked by another tab. Close other PeraPilot tabs and reload.'));
    });
    return {
      kind: 'indexeddb', persistent: true,
      async loadAll() {
        const tx = db.transaction(STORES, 'readonly');
        const rows = {};
        await Promise.all(STORES.map(async (s) => { rows[s] = await reqP(tx.objectStore(s).getAll()); }));
        await txP(tx);
        return stateFromRows(rows);
      },
      async commit(ops) {
        if (!ops.length) return;
        const stores = Array.from(new Set(ops.map((o) => o.store)));
        const tx = db.transaction(stores, 'readwrite');
        for (const o of ops) {
          const os = tx.objectStore(o.store);
          if (o.op === 'put') os.put(JSON.parse(JSON.stringify(o.value)));
          else os.delete(o.id);
        }
        await txP(tx);
      },
      async replaceAll(state, app) {
        const tx = db.transaction(STORES, 'readwrite');
        STORES.forEach((s) => tx.objectStore(s).clear());
        L.COLLECTIONS.forEach((c) => state[c].forEach((r) => tx.objectStore(c).put(JSON.parse(JSON.stringify(r)))));
        tx.objectStore('meta').put(JSON.parse(JSON.stringify(Object.assign({}, state.settings, { id: 'settings' }))));
        if (app) tx.objectStore('meta').put(Object.assign({ id: 'app' }, app));
        await txP(tx);
      },
      close() { db.close(); }
    };
  }

  /** Fallback when IndexedDB cannot be used. Nothing survives a reload. */
  function openMemory() {
    const rows = {}; STORES.forEach((s) => { rows[s] = []; });
    return {
      kind: 'memory', persistent: false,
      async loadAll() { return stateFromRows(JSON.parse(JSON.stringify(rows))); },
      async commit(ops) {
        for (const o of ops) {
          const arr = rows[o.store]; const id = o.op === 'put' ? o.value.id : o.id;
          const i = arr.findIndex((x) => x.id === id);
          if (o.op === 'put') { const v = JSON.parse(JSON.stringify(o.value)); if (i >= 0) arr[i] = v; else arr.push(v); } else if (i >= 0) arr.splice(i, 1);
        }
      },
      async replaceAll(state, app) {
        STORES.forEach((s) => { rows[s] = []; });
        L.COLLECTIONS.forEach((c) => { rows[c] = JSON.parse(JSON.stringify(state[c])); });
        rows.meta = [Object.assign({}, state.settings, { id: 'settings' })];
        if (app) rows.meta.push(Object.assign({ id: 'app' }, app));
      },
      close() {}
    };
  }

  async function open(name) {
    try { return await openIndexedDB(name); } catch (e) { const m = openMemory(); m.error = e; return m; }
  }

  /** JSON backup file (a local download — not a cloud backup). */
  function exportJSON(state) {
    const data = { app: 'PeraPilot', version: 1, exportedAt: new Date().toISOString() };
    L.COLLECTIONS.forEach((c) => { data[c] = state[c]; });
    data.settings = state.settings;
    return JSON.stringify(data, null, 2);
  }
  /** Parse + sanity check a backup. Returns {state} or {error}. */
  function parseBackup(text) {
    let d;
    try { d = JSON.parse(text); } catch (e) { return { error: 'That file is not valid JSON.' }; }
    if (!d || d.app !== 'PeraPilot') return { error: 'That does not look like a PeraPilot backup file.' };
    const st = L.emptyState();
    for (const c of L.COLLECTIONS) {
      if (d[c] === undefined) continue;
      if (!Array.isArray(d[c]) || d[c].some((r) => !r || typeof r.id !== 'string')) return { error: `The backup has a problem in "${c}".` };
      st[c] = d[c];
    }
    st.settings = Object.assign(L.defaultSettings(), d.settings || {}, { id: 'settings', demo: false });
    for (const t of st.transactions) {
      if (!Number.isInteger(t.amount) || t.amount <= 0 || !L.isISO(t.date)) return { error: 'The backup contains an invalid transaction.' };
    }
    const errs = L.validateLedger(st);
    if (errs.length) return { error: 'The backup does not balance: ' + errs[0] };
    return { state: st };
  }

  return { open, openIndexedDB, openMemory, exportJSON, parseBackup, STORES };
});
