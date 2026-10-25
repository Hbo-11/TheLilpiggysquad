import { TEST_NOTIFICATION_LIMIT, dedupeKeys, testNotificationText } from '@apex/notifications-core'
import type { Db } from './db.ts'
import { dispatchDeliveries, type DispatchSummary, type PushTransport } from './dispatch.ts'
import { fanOut } from './fanout.ts'

export type TestNotificationResult =
  | { status: 'sent'; notificationId: string; dispatch: DispatchSummary }
  | { status: 'no_device' | 'push_disabled' | 'rate_limited' | 'failed'; notificationId?: string; dispatch?: DispatchSummary }

/**
 * Troubleshooting: send a test push to the signed-in user's own devices only.
 * It is delivered immediately (not via the scheduled dispatcher) so the result can
 * be shown in Settings.
 */
export async function sendTestNotification(
  db: Db,
  opts: { userId: string; now: Date; transport: PushTransport; requestId: string },
): Promise<TestNotificationResult> {
  const since = new Date(opts.now.getTime() - TEST_NOTIFICATION_LIMIT.windowMs)
  const [{ count }] = await db<{ count: number }[]>`
    select count(*)::int as count from public.notifications where user_id = ${opts.userId} and kind = 'test' and created_at > ${since}`
  if (count >= TEST_NOTIFICATION_LIMIT.max) return { status: 'rate_limited' }

  const fan = await fanOut(
    db,
    {
      category: 'system',
      kind: 'test',
      dedupeKey: dedupeKeys.test(opts.requestId),
      deepLink: '/settings/notifications',
      data: { type: 'test' },
      text: () => testNotificationText(),
    },
    [opts.userId],
    { now: opts.now },
  )
  const [n] = await db<{ id: string; push_note: string | null }[]>`
    select id, push_note from public.notifications where user_id = ${opts.userId} and dedupe_key = ${dedupeKeys.test(opts.requestId)}`
  if (!n) return { status: 'failed' }
  if (fan.pushScheduled === 0) return { status: n.push_note === 'push_disabled' ? 'push_disabled' : 'no_device', notificationId: n.id }
  const dispatch = await dispatchDeliveries(db, { now: opts.now, transport: opts.transport, notificationIds: [n.id] })
  return { status: dispatch.sent > 0 ? 'sent' : 'failed', notificationId: n.id, dispatch }
}
