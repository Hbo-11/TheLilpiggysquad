// Locally scheduled session reminders, used only when this device is not registered
// for server push (see reminderDeliveryMode). Built from verified sessions already
// loaded in the app; re-run on start-up, on foreground, after preference/follow
// changes and when a "schedule changed" push arrives, so moved or cancelled
// sessions do not leave stale reminders behind.

import {
  limitLocalReminders,
  planSessionReminders,
  reconcileLocalReminders,
  sessionReminderText,
  type NotificationPreferences,
  type PlannedReminder,
  type SessionForReminders,
  type SessionType,
} from '@apex/notifications-core'

export interface ReminderSession extends SessionForReminders {
  name: string
  eventName: string
}

export interface ScheduledLocal {
  identifier: string
  data: Record<string, unknown> | null
}

export interface LocalScheduler {
  list(): Promise<ScheduledLocal[]>
  cancel(identifier: string): Promise<void>
  schedule(input: { identifier: string; title: string; body: string; data: Record<string, unknown>; fireAt: Date; channelId: string }): Promise<void>
}

export const LOCAL_REMINDER_TYPE = 'local_session_reminder'

/** OS identifiers must be short and safe; the dedupe key itself is kept in data. */
export function localIdentifier(dedupeKey: string): string {
  let h = 0
  for (let i = 0; i < dedupeKey.length; i++) h = (Math.imul(31, h) + dedupeKey.charCodeAt(i)) | 0
  return `apex-reminder-${(h >>> 0).toString(36)}-${dedupeKey.length}`
}

export async function syncLocalReminders(input: {
  scheduler: LocalScheduler
  sessions: ReminderSession[]
  prefs: NotificationPreferences
  timeZone: string
  now: Date
  /** When false, every local reminder is removed (server push took over, or push is off). */
  enabled: boolean
}): Promise<{ scheduled: number; cancelled: number; kept: number }> {
  const all = await input.scheduler.list()
  const ours = all.filter((n) => n.data?.type === LOCAL_REMINDER_TYPE)

  let desired: (PlannedReminder & { session: ReminderSession })[] = []
  if (input.enabled) {
    for (const session of input.sessions) {
      const plan = planSessionReminders({ session, prefs: input.prefs, now: input.now, graceMs: 0 })
      desired.push(...plan.reminders.map((r) => ({ ...r, session })))
    }
    desired = limitLocalReminders(desired) as typeof desired
  }

  const diff = reconcileLocalReminders(
    desired,
    ours.map((n) => ({ identifier: n.identifier, dedupeKey: typeof n.data?.dedupeKey === 'string' ? n.data.dedupeKey : null })),
  )
  for (const id of diff.toCancel) await input.scheduler.cancel(id)
  for (const r of diff.toSchedule as (PlannedReminder & { session: ReminderSession })[]) {
    const text = sessionReminderText({
      sessionName: r.session.name,
      sessionType: r.session.sessionType as SessionType,
      eventName: r.session.eventName,
      startsAt: new Date(r.sessionStartsAt),
      timeZone: input.timeZone,
      offsetMinutes: r.offsetMinutes,
    })
    await input.scheduler.schedule({
      identifier: localIdentifier(r.dedupeKey),
      title: text.title,
      body: text.body,
      data: { type: LOCAL_REMINDER_TYPE, dedupeKey: r.dedupeKey, url: `/events/${r.eventId}`, sessionId: r.sessionId },
      fireAt: r.fireAt,
      channelId: 'race-reminders',
    })
  }
  return { scheduled: diff.toSchedule.length, cancelled: diff.toCancel.length, kept: diff.unchanged }
}
