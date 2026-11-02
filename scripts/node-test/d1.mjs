/** In-memory D1 stand-in for `node --test`, backed by node:sqlite with every migration applied in order. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(new URL(f, DIR), 'utf8')).join('\n');

export class TestD1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys = ON;' + MIGRATIONS); }
  prepare(sql) {
    const statement = this.sqlite.prepare(sql);
    return { bind(...args) {
      return {
        run: async () => ({ meta: { changes: statement.run(...args).changes } }),
        first: async () => statement.get(...args) ?? null,
        all: async () => ({ results: statement.all(...args) }),
      };
    } };
  }
  close() { this.sqlite.close(); }
}

/** Minimal Workers KV stand-in: get (text/json), put (expirationTtl, metadata), delete, list (prefix, cursor). */
export class TestKV {
  constructor(now = () => Date.now()) { this.map = new Map(); this.now = now; }
  #live(key) {
    const e = this.map.get(key);
    if (e && e.expiresAt !== undefined && e.expiresAt <= this.now()) { this.map.delete(key); return undefined; }
    return e;
  }
  async get(key, options) {
    const e = this.#live(key);
    if (!e) return null;
    const type = typeof options === 'string' ? options : options?.type;
    return type === 'json' ? JSON.parse(e.value) : e.value;
  }
  async getWithMetadata(key, options) {
    const e = this.#live(key);
    return { value: e ? await this.get(key, options) : null, metadata: e?.metadata ?? null };
  }
  async put(key, value, options = {}) {
    let expiresAt;
    if (options.expirationTtl !== undefined) expiresAt = this.now() + options.expirationTtl * 1000;
    if (options.expiration !== undefined) expiresAt = options.expiration * 1000;
    this.map.set(key, { value: typeof value === 'string' ? value : String(value), metadata: options.metadata, expiresAt });
  }
  async delete(key) { this.map.delete(key); }
  async list({ prefix = '', limit = 1000, cursor } = {}) {
    const names = [...this.map.keys()].filter((k) => k.startsWith(prefix) && this.#live(k)).sort();
    const start = cursor ? Number(cursor) : 0;
    const page = names.slice(start, start + limit);
    const done = start + limit >= names.length;
    return {
      keys: page.map((name) => ({ name, metadata: this.map.get(name).metadata,
        ...(this.map.get(name).expiresAt ? { expiration: Math.floor(this.map.get(name).expiresAt / 1000) } : {}) })),
      list_complete: done, ...(done ? {} : { cursor: String(start + limit) }),
    };
  }
}
