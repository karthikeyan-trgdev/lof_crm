// Minimal Cloudflare D1 implementation on Node's built-in SQLite, so the real Worker code runs
// unchanged in Vitest (same SQL, same migrations, no mocks of the data layer).
import { DatabaseSync } from 'node:sqlite';

const norm = (v: unknown) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

class Stmt {
  constructor(private db: DatabaseSync, private sql: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) { return new Stmt(this.db, this.sql, args.map(norm)); }
  private s() { return this.db.prepare(this.sql); }
  async first<T = any>(col?: string): Promise<T | null> {
    const r: any = this.s().get(...(this.args as any[]));
    if (!r) return null;
    return (col ? r[col] : { ...r }) as T;
  }
  async all<T = any>() {
    const results = this.s().all(...(this.args as any[])).map((r: any) => ({ ...r })) as T[];
    return { results, success: true, meta: { changes: 0 } };
  }
  async run() {
    // Like D1, run() on a query (or RETURNING) gives its rows – batch() of SELECTs relies on this
    if (/^\s*(select|with)\b/i.test(this.sql) || /\breturning\b/i.test(this.sql)) {
      const results = this.s().all(...(this.args as any[]));
      return { success: true, results, meta: { changes: results.length, last_row_id: 0 } };
    }
    const r = this.s().run(...(this.args as any[]));
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async raw() { return this.s().all(...(this.args as any[])).map((r: any) => Object.values(r)); }
}

export class TestD1 {
  db: DatabaseSync;
  constructor() { this.db = new DatabaseSync(':memory:'); }
  prepare(sql: string) { return new Stmt(this.db, sql); }
  async exec(sql: string) { this.db.exec(sql); return { count: 0, duration: 0 }; }
  async batch(stmts: Stmt[]) {
    this.db.exec('BEGIN');
    try {
      const out: any[] = [];
      for (const s of stmts) out.push(await s.run());
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  dump() { return this.db; }
}
