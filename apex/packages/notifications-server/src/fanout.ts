// Creates notifications for a set of recipients. Every notification path
// (reminders, schedule changes, results, news, AI tasks, security, tests)
// goes through here so preferences, quiet hours, rate limits, collapsing and
// deduplication are applied consistently and server-side.

import {
  COLLAPSE_WINDOW_MS,
  RATE_LIMITS,
  decideForRecipient,
  parseDeepLink,
  preferencesFromRow,
  truncate,
  TITLE_MAX,
  BODY_MAX,
  type NotificationCategory,
  type NotificationText,
  type PreferencesRow,
  type PushPlan,
  type RecentPush,
} from '@apex/notifications-core'
import { chunk, inTransaction, type Db } from './db.ts'

export interface NotificationSpec {
  category: NotificationCategory
  kind: string
  dedupeKey: string
  /** Internal app path; validated against the deep-link allow-list. */
  deepLink: string | null
  text: (ctx: { timeZone: string }) => NotificationText
  data?: Record<string, unknown>
  sourceId?: string | null
  sourceUrl?: string | null
  /** Related updates within the collapse window update one notification instead of adding more. */
  collapseKey?: string | null
  collapsedText?: (ctx: { timeZone: string; count: number }) => NotificationText
  relatedSessionId?: string | null
  sessionStartsAt?: Date | null
}

export interface FanOutResult {
  created: number
  duplicates: number
  collapsed: number
  skipped: Record<string, number>
  pushScheduled: number
  pushSuppressed: Record<string, number>
}

const FANOUT_CHUNK = 500

function bump(map: Record<string, number>, key: string) {
  map[key] = (map[key] ?? 0) + 1
}

function pushStateFor(plan: PushPlan): { state: 'scheduled' | 'suppressed' | 'none'; note: string | null } {
  if (plan.action === 'send_now') return { state: 'scheduled', note: null }
  if (plan.action === 'defer') return { state: 'scheduled', note: 'held_for_quiet_hours' }
  if (plan.reason === 'no_device' || plan.reason === 'push_disabled') return { state: 'none', note: plan.reason }
  return { state: 'suppressed', note: plan.reason }
}

export async function fanOut(db: Db, spec: NotificationSpec, userIds: string[], opts: { now: Date }): Promise<FanOutResult> {
  if (spec.deepLink !== null && !parseDeepLink(spec.deepLink)) throw new Error(`Refusing invalid deep link ${spec.deepLink}`)
  const result: FanOutResult = { created: 0, duplicates: 0, collapsed: 0, skipped: {}, pushScheduled: 0, pushSuppressed: {} }
  const unique = [...new Set(userIds)]
  for (const ids of chunk(unique, FANOUT_CHUNK)) {
    await inTransaction(db, (tx) => fanOutChunk(tx, spec, ids, opts.now, result))
  }
  return result
}

async function fanOutChunk(db: Db, spec: NotificationSpec, ids: string[], now: Date, result: FanOutResult): Promise<void> {
  const prefsRows = await db<(PreferencesRow & { user_id: string; device_timezone: string | null })[]>`
    select * from public.notification_preferences where user_id = any(${ids}::uuid[])`
  const prefsByUser = new Map(prefsRows.map((r) => [r.user_id, r]))

  const devices = await db<{ id: string; user_id: string }[]>`
    select id, user_id from public.push_devices
     where user_id = any(${ids}::uuid[]) and invalidated_at is null`
  const devicesByUser = new Map<string, string[]>()
  for (const d of devices) devicesByUser.set(d.user_id, [...(devicesByUser.get(d.user_id) ?? []), d.id])

  const since = new Date(now.getTime() - RATE_LIMITS.windowMs)
  const recent = await db<{ user_id: string; category: NotificationCategory; at: Date }[]>`
    select user_id, category, min(created_at) as at from public.notification_deliveries
     where user_id = any(${ids}::uuid[]) and created_at > ${since}
       and status in ('pending', 'sending', 'sent', 'delivered')
     group by user_id, notification_id, category`
  const recentByUser = new Map<string, RecentPush[]>()
  for (const r of recent) recentByUser.set(r.user_id, [...(recentByUser.get(r.user_id) ?? []), { category: r.category, at: r.at }])

  // Existing notifications to collapse into.
  const collapseTargets = new Map<string, { id: string; group_count: number; merged: string[] }>()
  if (spec.collapseKey) {
    const windowStart = new Date(now.getTime() - COLLAPSE_WINDOW_MS)
    const rows = await db<{ id: string; user_id: string; group_count: number; dedupe_key: string; merged: string[] | null }[]>`
      select distinct on (user_id) id, user_id, group_count, dedupe_key,
             array(select jsonb_array_elements_text(coalesce(data -> 'mergedKeys', '[]'::jsonb))) as merged
        from public.notifications
       where user_id = any(${ids}::uuid[]) and collapse_key = ${spec.collapseKey}
         and created_at > ${windowStart} and archived_at is null
       order by user_id, created_at desc`
    for (const r of rows) collapseTargets.set(r.user_id, { id: r.id, group_count: r.group_count, merged: [r.dedupe_key, ...(r.merged ?? [])] })
  }

  const inserts: Record<string, unknown>[] = []
  const plans = new Map<string, PushPlan>()
  for (const userId of ids) {
    const row = prefsByUser.get(userId)
    if (!row) {
      bump(result.skipped, 'no_preferences')
      continue
    }
    const prefs = preferencesFromRow(row).preferences
    const decision = decideForRecipient({
      category: spec.category,
      now,
      sessionStartsAt: spec.sessionStartsAt ?? null,
      recipient: {
        prefs,
        deviceTimezone: row.device_timezone,
        activeDeviceCount: devicesByUser.get(userId)?.length ?? 0,
        recentPushes: recentByUser.get(userId) ?? [],
      },
    })
    if (!decision.create) {
      bump(result.skipped, decision.reason)
      continue
    }

    const target = collapseTargets.get(userId)
    if (target) {
      if (target.merged.includes(spec.dedupeKey)) {
        result.duplicates++
        continue
      }
      const count = target.group_count + 1
      const text = (spec.collapsedText ?? spec.text)({ timeZone: decision.timeZone, count })
      // A collapsed update refreshes the existing entry and marks it unread, without a new push.
      await db`
        update public.notifications
           set group_count = ${count},
               title = ${truncate(text.title, TITLE_MAX)},
               body = ${truncate(text.body, BODY_MAX)},
               read_at = null,
               data = jsonb_set(data, '{mergedKeys}', coalesce(data -> 'mergedKeys', '[]'::jsonb) || to_jsonb(${spec.dedupeKey}::text))
         where id = ${target.id}`
      result.collapsed++
      continue
    }

    const text = spec.text({ timeZone: decision.timeZone })
    const { state, note } = pushStateFor(decision.push)
    plans.set(userId, decision.push)
    inserts.push({
      user_id: userId,
      category: spec.category,
      kind: spec.kind,
      title: truncate(text.title, TITLE_MAX),
      body: truncate(text.body, BODY_MAX),
      deep_link: spec.deepLink,
      data: { ...(spec.data ?? {}), timeZone: decision.timeZone },
      source_id: spec.sourceId ?? null,
      source_url: spec.sourceUrl ?? null,
      dedupe_key: spec.dedupeKey,
      collapse_key: spec.collapseKey ?? null,
      related_session_id: spec.relatedSessionId ?? null,
      push_state: state,
      push_note: note,
      created_at: now,
    })
  }
  if (inserts.length === 0) return

  const created = await db<{ id: string; user_id: string }[]>`
    insert into public.notifications ${db(
      inserts as never,
      'user_id',
      'category',
      'kind',
      'title',
      'body',
      'deep_link',
      'data',
      'source_id',
      'source_url',
      'dedupe_key',
      'collapse_key',
      'related_session_id',
      'push_state',
      'push_note',
      'created_at',
    )}
    on conflict (user_id, dedupe_key) do nothing
    returning id, user_id`
  result.created += created.length
  result.duplicates += inserts.length - created.length

  const deliveries: Record<string, unknown>[] = []
  for (const n of created) {
    const plan = plans.get(n.user_id)!
    if (plan.action === 'none') {
      bump(result.pushSuppressed, plan.reason)
      continue
    }
    const sendAfter = plan.action === 'defer' ? plan.until : now
    for (const deviceId of devicesByUser.get(n.user_id) ?? []) {
      deliveries.push({ notification_id: n.id, user_id: n.user_id, device_id: deviceId, category: spec.category, send_after: sendAfter, created_at: now })
    }
    result.pushScheduled++
  }
  if (deliveries.length) {
    await db`
      insert into public.notification_deliveries ${db(deliveries as never, 'notification_id', 'user_id', 'device_id', 'category', 'send_after', 'created_at')}
      on conflict (notification_id, device_id) do nothing`
  }
}
