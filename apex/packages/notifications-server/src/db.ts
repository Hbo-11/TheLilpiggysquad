import type { Sql, TransactionSql } from 'postgres'

/** A postgres.js client or an open transaction. */
export type Db = Sql | TransactionSql

export async function heartbeat(db: Db, name: string, detail: Record<string, unknown>, now: Date): Promise<void> {
  await db`
    insert into public.system_heartbeats (name, last_run_at, detail)
    values (${name}, ${now}, ${db.json(detail as never)})
    on conflict (name) do update set last_run_at = excluded.last_run_at, detail = excluded.detail`
}

/** Run `fn` in a transaction (or the current one). */
export async function inTransaction<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  if ('begin' in db && typeof db.begin === 'function') {
    return (await db.begin((tx) => fn(tx as unknown as Db))) as T
  }
  return fn(db)
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
