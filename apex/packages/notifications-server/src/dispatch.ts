// Sends due push deliveries through Expo and records the outcome of every attempt.

import {
  CATEGORY_INFO,
  RETRY_POLICY,
  getExpoReceipts,
  isCategoryEnabled,
  preferencesFromRow,
  retryDelayMs,
  sendExpoPush,
  type ExpoPushMessage,
  type FetchLike,
  type NotificationCategory,
  type PreferencesRow,
} from '@apex/notifications-core'
import { heartbeat, type Db } from './db.ts'

/** A send whose outcome was never recorded (worker crashed) is not retried, to avoid duplicates. */
const STUCK_SENDING_MS = 15 * 60_000
/** Expo recommends waiting before reading receipts. */
const RECEIPT_DELAY_MS = 15 * 60_000
const RECEIPT_GIVE_UP_MS = 24 * 60 * 60_000

export interface PushTransport {
  fetch: FetchLike
  /** Expo access token, required if "enhanced push security" is enabled for the project. */
  accessToken?: string
}

export interface DispatchSummary {
  claimed: number
  sent: number
  retrying: number
  failed: number
  cancelled: number
  invalidatedDevices: number
}

interface ClaimedDelivery {
  id: string
  notification_id: string
  user_id: string
  device_id: string
  category: NotificationCategory
  attempts: number
  token: string
  device_invalidated: boolean
  title: string
  body: string
  deep_link: string | null
  kind: string
  data: Record<string, unknown>
  read_at: Date | null
  archived_at: Date | null
  prefs: PreferencesRow | null
}

function ttlSeconds(d: ClaimedDelivery, now: Date): number {
  const startsAt = typeof d.data.sessionStartsAt === 'string' ? new Date(d.data.sessionStartsAt) : null
  if (d.kind === 'session_reminder' && startsAt) {
    // A reminder that arrives after the session has started is useless.
    return Math.max(60, Math.round((startsAt.getTime() - now.getTime()) / 1000) + 5 * 60)
  }
  return d.category === 'account_security' ? 7 * 86_400 : 86_400
}

function toMessage(d: ClaimedDelivery, now: Date): ExpoPushMessage {
  const info = CATEGORY_INFO[d.category]
  const timeSensitive = info.priority === 'critical' || info.priority === 'time_sensitive'
  return {
    to: d.token,
    title: d.title,
    body: d.body,
    // Only what the app needs to route the tap. No personal data.
    data: { notificationId: d.notification_id, url: d.deep_link ?? '/notifications', category: d.category, kind: d.kind, ...(d.kind === 'schedule_change' ? { reconcileReminders: true } : {}) },
    sound: 'default',
    channelId: info.androidChannel,
    priority: timeSensitive ? 'high' : 'default',
    ttl: ttlSeconds(d, now),
    threadId: d.category,
    interruptionLevel: timeSensitive ? 'time-sensitive' : 'active',
  }
}

export async function dispatchDeliveries(
  db: Db,
  opts: { now: Date; transport: PushTransport; limit?: number; notificationIds?: string[]; random?: () => number },
): Promise<DispatchSummary> {
  const { now } = opts
  const summary: DispatchSummary = { claimed: 0, sent: 0, retrying: 0, failed: 0, cancelled: 0, invalidatedDevices: 0 }

  await db`
    update public.notification_deliveries
       set status = 'failed', error_code = 'UNKNOWN_OUTCOME', error_message = 'Worker stopped before recording the send result'
     where status = 'sending' and last_attempt_at < ${new Date(now.getTime() - STUCK_SENDING_MS)}`

  const onlyIds = opts.notificationIds ?? null
  const claimed = await db<ClaimedDelivery[]>`
    with c as (
      select id from public.notification_deliveries
       where status = 'pending' and send_after <= ${now}
         and (${onlyIds}::uuid[] is null or notification_id = any(${onlyIds}::uuid[]))
       order by send_after
       limit ${opts.limit ?? 500}
       for update skip locked
    ), u as (
      update public.notification_deliveries d
         set status = 'sending', attempts = d.attempts + 1, last_attempt_at = ${now}
        from c where d.id = c.id
      returning d.*
    )
    select u.id, u.notification_id, u.user_id, u.device_id, u.category, u.attempts,
           pd.expo_push_token as token, (pd.invalidated_at is not null) as device_invalidated,
           n.title, n.body, n.deep_link, n.kind, n.data, n.read_at, n.archived_at,
           to_jsonb(p.*) as prefs
      from u
      join public.push_devices pd on pd.id = u.device_id
      join public.notifications n on n.id = u.notification_id
      left join public.notification_preferences p on p.user_id = u.user_id`
  summary.claimed = claimed.length

  // Re-check at send time: preferences may have changed while a push was held for
  // quiet hours, the user may have read or dismissed it in the app, or the device
  // may have been signed out.
  const sendable: ClaimedDelivery[] = []
  for (const d of claimed) {
    let reason: string | null = null
    if (d.device_invalidated) reason = 'DEVICE_INVALIDATED'
    else if (d.archived_at) reason = 'DISMISSED'
    else if (d.read_at) reason = 'ALREADY_READ'
    else if (d.category !== 'account_security' && d.category !== 'system') {
      const prefs = preferencesFromRow(d.prefs).preferences
      if (!prefs.pushEnabled) reason = 'PUSH_DISABLED'
      else if (!isCategoryEnabled(prefs, d.category)) reason = 'CATEGORY_DISABLED'
    }
    if (reason) {
      await db`update public.notification_deliveries set status = 'cancelled', error_code = ${reason} where id = ${d.id}`
      summary.cancelled++
    } else sendable.push(d)
  }

  const results = sendable.length ? await sendExpoPush(sendable.map((d) => toMessage(d, now)), opts.transport) : []
  for (let i = 0; i < sendable.length; i++) {
    const d = sendable[i]
    const r = results[i]
    if (r.status === 'ok') {
      await db`update public.notification_deliveries set status = 'sent', ticket_id = ${r.ticketId}, error_code = null, error_message = null where id = ${d.id}`
      summary.sent++
      continue
    }
    if (r.invalidToken) {
      await invalidateDevice(db, d.device_id, r.errorCode)
      summary.invalidatedDevices++
    }
    if (r.retryable && d.attempts < RETRY_POLICY.maxAttempts) {
      const sendAfter = new Date(now.getTime() + retryDelayMs(d.attempts, opts.random))
      await db`
        update public.notification_deliveries
           set status = 'pending', send_after = ${sendAfter}, error_code = ${r.errorCode}, error_message = ${r.message}
         where id = ${d.id}`
      summary.retrying++
    } else {
      await db`update public.notification_deliveries set status = 'failed', error_code = ${r.errorCode}, error_message = ${r.message} where id = ${d.id}`
      summary.failed++
    }
  }

  const touched = [...new Set(claimed.map((d) => d.notification_id))]
  if (touched.length) await refreshPushState(db, touched)
  await heartbeat(db, 'dispatch', { ...summary, pushConfigured: true }, now)
  return summary
}

async function invalidateDevice(db: Db, deviceId: string, reason: string) {
  await db`update public.push_devices set invalidated_at = now(), invalid_reason = ${reason} where id = ${deviceId} and invalidated_at is null`
  await db`
    update public.notification_deliveries set status = 'cancelled', error_code = 'DEVICE_INVALIDATED'
     where device_id = ${deviceId} and status = 'pending'`
}

/** Summarise per-device delivery state on the notification (shown in the app). */
async function refreshPushState(db: Db, notificationIds: string[]) {
  await db`
    update public.notifications n
       set push_state = case
             when s.sent > 0 then 'sent'
             when s.open > 0 then 'scheduled'
             when s.failed > 0 then 'failed'
             else 'cancelled' end
      from (
        select notification_id,
               count(*) filter (where status in ('sent', 'delivered')) as sent,
               count(*) filter (where status in ('pending', 'sending')) as open,
               count(*) filter (where status = 'failed') as failed
          from public.notification_deliveries
         where notification_id = any(${notificationIds}::uuid[])
         group by notification_id
      ) s
     where n.id = s.notification_id`
}

export interface ReceiptSummary {
  checked: number
  delivered: number
  failed: number
  pending: number
  invalidatedDevices: number
  errors: Record<string, number>
}

/** Read Expo delivery receipts for sent pushes and act on permanent failures. */
export async function checkReceipts(db: Db, opts: { now: Date; transport: PushTransport; limit?: number }): Promise<ReceiptSummary> {
  const { now } = opts
  const summary: ReceiptSummary = { checked: 0, delivered: 0, failed: 0, pending: 0, invalidatedDevices: 0, errors: {} }
  const rows = await db<{ id: string; ticket_id: string; device_id: string; last_attempt_at: Date }[]>`
    select id, ticket_id, device_id, last_attempt_at from public.notification_deliveries
     where status = 'sent' and receipt_checked_at is null and ticket_id is not null
       and last_attempt_at < ${new Date(now.getTime() - RECEIPT_DELAY_MS)}
     order by last_attempt_at limit ${opts.limit ?? 1000}`
  if (rows.length === 0) {
    await heartbeat(db, 'receipts', { ...summary }, now)
    return summary
  }
  const receipts = await getExpoReceipts(rows.map((r) => r.ticket_id), opts.transport)
  for (const row of rows) {
    const r = receipts.get(row.ticket_id) ?? { status: 'pending' as const }
    summary.checked++
    if (r.status === 'ok') {
      await db`update public.notification_deliveries set status = 'delivered', receipt_checked_at = ${now} where id = ${row.id}`
      summary.delivered++
    } else if (r.status === 'error') {
      // e.g. InvalidCredentials means the APNs/FCM setup in EAS is wrong: logged for monitoring.
      await db`
        update public.notification_deliveries
           set status = 'failed', receipt_checked_at = ${now}, error_code = ${r.errorCode}, error_message = ${r.message}
         where id = ${row.id}`
      summary.failed++
      summary.errors[r.errorCode] = (summary.errors[r.errorCode] ?? 0) + 1
      if (r.invalidToken) {
        await invalidateDevice(db, row.device_id, r.errorCode)
        summary.invalidatedDevices++
      }
    } else {
      summary.pending++
      if (now.getTime() - row.last_attempt_at.getTime() > RECEIPT_GIVE_UP_MS) {
        await db`update public.notification_deliveries set receipt_checked_at = ${now}, error_code = 'RECEIPT_UNAVAILABLE' where id = ${row.id}`
      }
    }
  }
  await heartbeat(db, 'receipts', { ...summary }, now)
  return summary
}
