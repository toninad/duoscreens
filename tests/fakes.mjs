// Stand-ins for Cloudflare D1 and R2 so the server code runs under plain Node.
// D1 is emulated with node:sqlite and the real migrations; R2 with a Map.
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const prepare = (sql) => {
    const stmt = db.prepare(sql.replace(/\?(\d+)/g, '?'));
    // D1 numbers params ?1, ?2…; node:sqlite takes them positionally, so expand by index.
    const order = [...sql.matchAll(/\?(\d+)/g)].map(m => Number(m[1]) - 1);
    let args = [];
    const api = {
      bind(...a) { args = order.map(i => a[i]); return api; },
      async first() { return stmt.get(...args) ?? null; },
      async run() { const r = stmt.run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
      async all() { return { results: stmt.all(...args) }; },
    };
    return api;
  };
  return {
    raw: db,
    prepare,
    async batch(stmts) {   // D1 runs a batch as one transaction
      db.exec('BEGIN');
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}

export function fakeR2() {
  const objects = new Map();
  return {
    objects,
    async put(key, value) { objects.set(key, new Uint8Array(value instanceof ArrayBuffer ? value : await new Response(value).arrayBuffer())); },
    async get(key) { const v = objects.get(key); return v ? { body: v, async arrayBuffer() { return v.buffer; } } : null; },
    async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
    async list({ prefix = '', cursor } = {}) {
      const all = [...objects.keys()].filter(k => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0, page = all.slice(start, start + 2);   // tiny pages exercise the cursor loop
      const truncated = start + 2 < all.length;
      return { objects: page.map(key => ({ key })), truncated, cursor: truncated ? String(start + 2) : undefined };
    },
  };
}
