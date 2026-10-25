// Local saving: boards and their images in the browser's IndexedDB. Nothing here leaves the
// browser; sync.js copies boards to the server (encrypted) for Pro, if it's turned on.
//
//   boards  id   -> { id, name, doc, createdAt, updatedAt, remoteVersion, dirty, deleted }
//   images  hash -> { hash, blob, bytes }   (hash = SHA-256 of the stored file, so each is kept once)
//   meta    key  -> value                   (current board, sync settings)

const DB_NAME = 'hhstudio';
let dbp = null;

const req = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/** Opens the database; resolves to false where IndexedDB isn't available (some private windows). */
export function openStore() {
  if (dbp) return dbp.then(Boolean, () => false);
  dbp = new Promise((resolve, reject) => {
    let open;
    try { open = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains('boards')) db.createObjectStore('boards', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'hash' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    open.onsuccess = () => {
      const db = open.result;
      db.onversionchange = () => db.close();   // a newer version of the app in another tab
      resolve(db);
    };
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('Storage is busy in another tab.'));
  });
  return dbp.then(Boolean, () => false);
}

async function tx(store, mode, fn) {
  const db = await dbp;
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    let out;
    Promise.resolve(fn(t.objectStore(store))).then(v => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Saving was interrupted.'));
  });
}

export const boards = {
  all: () => tx('boards', 'readonly', s => req(s.getAll())),
  get: (id) => tx('boards', 'readonly', s => req(s.get(id))),
  put: (rec) => tx('boards', 'readwrite', s => req(s.put(rec))),
  delete: (id) => tx('boards', 'readwrite', s => req(s.delete(id))),
  /** Read-modify-write in one transaction, so a save and a sync can't overwrite each other's fields. */
  update: (id, fn) => tx('boards', 'readwrite', async s => {
    const cur = await req(s.get(id));
    const next = fn(cur);
    if (next) await req(s.put(next));
    return next;
  }),
};

export const images = {
  get: (hash) => tx('images', 'readonly', s => req(s.get(hash))),
  has: (hash) => tx('images', 'readonly', s => req(s.getKey(hash))).then(k => k !== undefined),
  put: (hash, blob) => tx('images', 'readwrite', s => req(s.put({ hash, blob, bytes: blob.size }))),
  keys: () => tx('images', 'readonly', s => req(s.getAllKeys())),
  delete: (hashes) => tx('images', 'readwrite', s => Promise.all([].concat(hashes).map(h => req(s.delete(h))))),
};

export const meta = {
  get: (k) => tx('meta', 'readonly', s => req(s.get(k))),
  set: (k, v) => tx('meta', 'readwrite', s => req(s.put(v, k))),
};

/** Deletes stored images no board uses any more (replaced captures, deleted boards). */
export async function cleanupImages(keep = new Set()) {
  const used = new Set(keep);
  for (const b of await boards.all()) for (const h of imageHashesOf(b.doc)) used.add(h);
  const unused = (await images.keys()).filter(h => !used.has(h));
  if (unused.length) await images.delete(unused);
  return unused.length;
}

/** Every image hash a saved board refers to. */
export function imageHashesOf(doc) {
  const out = new Set();
  for (const g of doc?.groups || []) for (const s of g.shots || []) for (const h of Object.values(s.images || {})) if (h) out.add(h);
  return [...out];
}

/** Asks the browser not to clear our storage when space runs low (honoured by some browsers). */
export async function askPersistence() {
  try { return navigator.storage?.persist ? await navigator.storage.persist() : false; } catch { return false; }
}
