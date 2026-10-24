import { indexFor, ID_FORMAT } from './indexing';
import type { Env } from '../types';

export const nowIso = () => new Date().toISOString();

/** Thin repository over the `docs`, `settings` and `sequences` tables. */
export class Repo {
  constructor(public db: D1Database, public actor = 'system', public isTest = false) {}

  // ---------- documents ----------
  async get<T = any>(type: string, id: string): Promise<T | null> {
    const r = await this.db.prepare('SELECT data FROM docs WHERE type=? AND id=?').bind(type, id).first<{ data: string }>();
    return r ? JSON.parse(r.data) : null;
  }

  async getRow(type: string, id: string) {
    return this.db.prepare('SELECT * FROM docs WHERE type=? AND id=?').bind(type, id).first<any>();
  }

  async many<T = any>(type: string, where = '', binds: unknown[] = [], order = ''): Promise<T[]> {
    const sql = `SELECT data FROM docs WHERE type=?${where ? ' AND ' + where : ''}${order ? ' ORDER BY ' + order : ''}`;
    const r = await this.db.prepare(sql).bind(type, ...binds).all<{ data: string }>();
    return (r.results || []).map((x) => JSON.parse(x.data));
  }

  async count(type: string, where = '', binds: unknown[] = []): Promise<number> {
    const r = await this.db.prepare(`SELECT COUNT(*) n FROM docs WHERE type=?${where ? ' AND ' + where : ''}`).bind(type, ...binds).first<{ n: number }>();
    return r?.n ?? 0;
  }

  /** Resolve the branch of a related lead / enrollment (used when indexing child records). */
  async branchOf(type: string, id: string): Promise<string | null> {
    const r = await this.db.prepare('SELECT branch FROM docs WHERE type=? AND id=?').bind(type, id).first<{ branch: string }>();
    return r?.branch ?? null;
  }

  async putStmt(type: string, doc: any, branchHint?: Record<string, string | null>) {
    const lookups: Record<string, string | null> = { ...(branchHint || {}) };
    if (type === 'task' || type === 'call' || type === 'comm') {
      const k = 'lead:' + doc.lead;
      if (!(k in lookups)) lookups[k] = await this.branchOf('lead', doc.lead);
    }
    if (type === 'moodle_sync' || type === 'refund') {
      const k = 'enrollment:' + doc.enr;
      if (!(k in lookups)) lookups[k] = await this.branchOf('enrollment', doc.enr);
    }
    const c = indexFor(type, doc, (t, id) => lookups[t + ':' + id] ?? null);
    return this.db
      .prepare(
        `INSERT INTO docs (type,id,branch,status,owner,ref1,ref2,at,data,is_test,updated_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(type,id) DO UPDATE SET branch=excluded.branch,status=excluded.status,owner=excluded.owner,
           ref1=excluded.ref1,ref2=excluded.ref2,at=excluded.at,data=excluded.data,version=docs.version+1,
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_by=excluded.updated_by`,
      )
      .bind(type, doc.id, c.branch, c.status, c.owner, c.ref1, c.ref2, c.at, JSON.stringify(doc), this.isTest || doc.test ? 1 : 0, this.actor);
  }

  /** Insert a new server-generated record; fails instead of overwriting if the id is already taken. */
  async create(type: string, doc: any) {
    const c = indexFor(type, doc, () => null);
    const branchRel = type === 'task' || type === 'call' || type === 'comm' ? await this.branchOf('lead', doc.lead) : type === 'moodle_sync' || type === 'refund' ? await this.branchOf('enrollment', doc.enr) : c.branch;
    await this.db.prepare('INSERT INTO docs (type,id,branch,status,owner,ref1,ref2,at,data,is_test,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(type, doc.id, branchRel, c.status, c.owner, c.ref1, c.ref2, c.at, JSON.stringify(doc), this.isTest || doc.test ? 1 : 0, this.actor).run();
    return doc;
  }

  async put(type: string, doc: any) {
    await (await this.putStmt(type, doc)).run();
    return doc;
  }

  async putMany(items: { type: string; doc: any }[]) {
    if (!items.length) return;
    const hint: Record<string, string | null> = {};
    for (const it of items) if (it.type === 'lead') hint['lead:' + it.doc.id] = it.doc.branch;
    for (const it of items) if (it.type === 'enrollment') hint['enrollment:' + it.doc.id] = it.doc.branch;
    const stmts: D1PreparedStatement[] = [];
    for (const it of items) stmts.push(await this.putStmt(it.type, it.doc, hint));
    await this.db.batch(stmts);
  }

  async del(type: string, id: string) {
    await this.db.prepare('DELETE FROM docs WHERE type=? AND id=?').bind(type, id).run();
  }

  // ---------- settings ----------
  async setting<T = any>(key: string): Promise<T> {
    const r = await this.db.prepare('SELECT data FROM settings WHERE key=?').bind(key).first<{ data: string }>();
    return r ? JSON.parse(r.data) : ({} as T);
  }

  async putSetting(key: string, data: unknown) {
    await this.db
      .prepare(
        `INSERT INTO settings (key,data,updated_by) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET data=excluded.data,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_by=excluded.updated_by`,
      )
      .bind(key, JSON.stringify(data), this.actor)
      .run();
  }

  // ---------- sequences ----------
  /** Take the next value of a sequence (atomic). */
  async next(name: string): Promise<number> {
    await this.db.prepare('INSERT OR IGNORE INTO sequences (name,value) VALUES (?,1)').bind(name).run();
    const r = await this.db.prepare('UPDATE sequences SET value=value+1 WHERE name=? RETURNING value-1 AS v').bind(name).first<{ v: number }>();
    return r!.v;
  }

  /** Claim a specific value if it is still the next one; otherwise allocate the next free value. */
  async claim(name: string, expect: number): Promise<{ ok: boolean; value: number }> {
    await this.db.prepare('INSERT OR IGNORE INTO sequences (name,value) VALUES (?,1)').bind(name).run();
    const r = await this.db.prepare('UPDATE sequences SET value=value+1 WHERE name=? AND value=? RETURNING value-1 AS v').bind(name, expect).first<{ v: number }>();
    if (r) return { ok: true, value: r.v };
    return { ok: false, value: await this.next(name) };
  }

  /** Reserve a block of values; returns the first value of the block. */
  async block(name: string, size: number): Promise<number> {
    await this.db.prepare('INSERT OR IGNORE INTO sequences (name,value) VALUES (?,1)').bind(name).run();
    const r = await this.db.prepare('UPDATE sequences SET value=value+? WHERE name=? RETURNING value-? AS v').bind(size, name, size).first<{ v: number }>();
    return r!.v;
  }

  async peekAll(): Promise<Record<string, number>> {
    const r = await this.db.prepare('SELECT name,value FROM sequences').all<{ name: string; value: number }>();
    return Object.fromEntries((r.results || []).map((x) => [x.name, x.value]));
  }

  /** Test records (Testing Console) get TST- ids so business sequences stay gapless. */
  testId(seq: string): string {
    return `TST-${seq.toUpperCase()}-${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0')}`;
  }

  async newId(seq: keyof typeof ID_FORMAT | string): Promise<string> {
    if (this.isTest) return this.testId(seq);
    const n = await this.next(seq);
    return ID_FORMAT[seq](n);
  }
}

export const repoFor = (env: Env, actor = 'system', isTest = false) => new Repo(env.DB, actor, isTest);
