import postgres from 'postgres'
import type { FetchLike } from '@apex/notifications-core'
import type { Db } from '../src/index.ts'

export const DB_URL = process.env.APEX_TEST_DATABASE_URL

/** Skip message for environments without a test database (run `npm run test:db`). */
export const skipNoDb = DB_URL ? false : 'APEX_TEST_DATABASE_URL not set; run `npm run test:db`'

export function connect() {
  return postgres(DB_URL!, { prepare: false, max: 4, onnotice: () => {} })
}

export async function resetData(sql: Db) {
  await sql`truncate public.notification_deliveries, public.notifications, public.notification_jobs, public.push_devices,
            public.user_follows, public.saved_events, public.event_entries, public.event_sessions, public.events,
            public.drivers, public.teams, public.articles, public.ingest_log, public.reminder_scan_state,
            public.system_heartbeats, public.notification_preferences cascade`
  await sql`delete from auth.users`
  await sql`delete from public.data_sources`
  await sql`update public.championships set supported = false`
}

export async function createUser(sql: Db, email: string): Promise<string> {
  const [u] = await sql<{ id: string }[]>`insert into auth.users (email, encrypted_password) values (${email}, 'hash-1') returning id`
  return u.id
}

/** Run queries as a signed-in user, exactly as PostgREST would (role + JWT claims). */
export async function asUser<T>(sql: postgres.Sql, userId: string | null, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${userId ? 'authenticated' : 'anon'}`)
    const claims = JSON.stringify(userId ? { sub: userId, role: 'authenticated' } : { role: 'anon' })
    await tx`select set_config('request.jwt.claims', ${claims}, true)`
    return fn(tx)
  })) as T
}

export function token(n: number | string) {
  return `ExponentPushToken[device${String(n).padStart(6, '0')}]`
}

type Ticket = { status: 'ok'; id: string } | { status: 'error'; message: string; details: { error: string } }

/** A stand-in for the Expo push service that records every message. */
export function fakeExpo(opts: { ticket?: (msg: { to: string }) => Ticket; httpStatus?: () => number; receipts?: Record<string, unknown> } = {}) {
  const sent: { to: string; title: string; body: string; data: Record<string, unknown>; ttl?: number; channelId?: string }[] = []
  let counter = 0
  const fetch: FetchLike = async (url, init) => {
    const status = opts.httpStatus?.() ?? 200
    if (url.endsWith('/getReceipts')) {
      return { status: 200, json: async () => ({ data: opts.receipts ?? {} }), text: async () => '' }
    }
    if (status !== 200) return { status, json: async () => ({}), text: async () => 'unavailable' }
    const msgs = JSON.parse(init.body) as typeof sent
    const data = msgs.map((m) => {
      const t = opts.ticket?.(m) ?? { status: 'ok' as const, id: `ticket-${++counter}` }
      if (t.status === 'ok') sent.push(m)
      return t
    })
    return { status: 200, json: async () => ({ data }), text: async () => '' }
  }
  return { fetch, sent }
}

export const SOURCE = 'fia-test'

export async function setupOfficialSource(sql: Db, championship = 'f1') {
  await sql`insert into public.data_sources (id, name, trust_level) values (${SOURCE}, 'Official timing (test)', 'official') on conflict do nothing`
  await sql`update public.championships set supported = true where id = ${championship}`
}
