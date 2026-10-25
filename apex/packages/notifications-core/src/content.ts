// Notification copy. Concise, factual, no clickbait, minimal emoji.
// Lock-screen safety: notifications never include passwords, tokens, email
// addresses, or the user's own project/chat content; Apex AI and Track Lab
// notifications use generic wording and the details are shown in the app.

import { SESSION_TYPE_LABELS, type SessionType } from './categories.ts'
import { formatDateTimeInZone, describeLeadTime } from './time.ts'

export const TITLE_MAX = 65
export const BODY_MAX = 178

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return clean.slice(0, max - 1).trimEnd() + '…'
}

export interface NotificationText {
  title: string
  body: string
}

function finish(t: NotificationText): NotificationText {
  return { title: truncate(t.title, TITLE_MAX), body: truncate(t.body, BODY_MAX) }
}

export interface SessionTextInput {
  sessionName: string
  sessionType: SessionType
  eventName: string
  startsAt: Date
  /** The timezone the user sees times in; always named in the text. */
  timeZone: string
}

function sessionLabel(s: { sessionName: string; sessionType: SessionType }): string {
  return s.sessionName || SESSION_TYPE_LABELS[s.sessionType]
}

export function sessionReminderText(s: SessionTextInput & { offsetMinutes: number }): NotificationText {
  const name = sessionLabel(s)
  const title = s.offsetMinutes === 0 ? `${name} is starting now` : `${name} starts ${describeLeadTime(s.offsetMinutes)}`
  return finish({ title, body: `${s.eventName} • ${formatDateTimeInZone(s.startsAt, s.timeZone)} • Open event schedule` })
}

export function scheduleChangeText(
  s: Omit<SessionTextInput, 'startsAt'> & {
    change: 'rescheduled' | 'postponed' | 'cancelled' | 'time_confirmed'
    previousStartsAt: Date | null
    startsAt: Date | null
  },
): NotificationText {
  const name = sessionLabel(s)
  switch (s.change) {
    case 'rescheduled': {
      const now = s.startsAt ? formatDateTimeInZone(s.startsAt, s.timeZone) : 'a time to be confirmed'
      const was = s.previousStartsAt ? ` (was ${formatDateTimeInZone(s.previousStartsAt, s.timeZone)})` : ''
      return finish({
        title: `${name} rescheduled`,
        body: `${s.eventName}: now ${now}${was}. Check the updated time before the session begins.`,
      })
    }
    case 'time_confirmed':
      return finish({
        title: `${name} time confirmed`,
        body: `${s.eventName}: ${s.startsAt ? formatDateTimeInZone(s.startsAt, s.timeZone) : ''}. Open the event schedule.`,
      })
    case 'postponed':
      return finish({ title: `${name} postponed`, body: `${s.eventName}: a new time has not been confirmed yet. We'll update you.` })
    case 'cancelled':
      return finish({ title: `${name} cancelled`, body: `${s.eventName}: the organisers have confirmed this session will not run.` })
  }
}

export function sessionLiveText(s: { sessionName: string; sessionType: SessionType; eventName: string }): NotificationText {
  return finish({ title: `${sessionLabel(s)} has started`, body: `${s.eventName} • Open the event page` })
}

export function resultsText(s: { sessionName: string; sessionType: SessionType; eventName: string }): NotificationText {
  const name = sessionLabel(s)
  return finish({
    title: `Official ${name.toLowerCase()} results are available`,
    body: `${s.eventName} • View the confirmed classification and championship standings.`,
  })
}

export function articleText(a: { headline: string; summary: string; sourceName: string }): NotificationText {
  return finish({ title: a.headline, body: `${a.summary} • Source: ${a.sourceName}` })
}

export function collapsedArticleText(a: { headline: string; count: number; sourceName: string }): NotificationText {
  return finish({ title: a.headline, body: `${a.count} updates on this story • Latest from ${a.sourceName}` })
}

export const APP_EVENT_KINDS = [
  'race_summary_ready',
  'analysis_completed',
  'report_ready',
  'export_ready',
  'ai_job_failed',
  'track_design_ready',
  'track_export_ready',
  'track_job_failed',
] as const
export type AppEventKind = (typeof APP_EVENT_KINDS)[number]

export function appEventText(kind: AppEventKind): NotificationText {
  const texts: Record<AppEventKind, NotificationText> = {
    race_summary_ready: { title: 'Your race summary is ready', body: 'Open Apex AI to read the summary you requested.' },
    analysis_completed: { title: 'Your analysis is ready', body: 'Open Apex AI to review the saved analysis.' },
    report_ready: { title: 'Your report is ready', body: 'Open Apex AI to view or download the saved report.' },
    export_ready: { title: 'Your export is ready', body: 'Open Apex AI to download the export you requested.' },
    ai_job_failed: { title: 'An Apex AI task needs attention', body: 'A task you started could not finish. Open it to see what happened and retry.' },
    track_design_ready: { title: 'Your circuit design is ready', body: 'Open Track Lab to review and export your saved design.' },
    track_export_ready: { title: 'Your Track Lab export is ready', body: 'Open Track Lab to download the export.' },
    track_job_failed: { title: 'A Track Lab task needs attention', body: 'A track-generation task could not finish. Open the project to retry.' },
  }
  return finish(texts[kind])
}

export const SECURITY_EVENT_KINDS = ['password_changed', 'email_changed', 'new_sign_in', 'mfa_changed'] as const
export type SecurityEventKind = (typeof SECURITY_EVENT_KINDS)[number]

export function securityText(kind: SecurityEventKind): NotificationText {
  const what: Record<SecurityEventKind, string> = {
    password_changed: 'Your password was changed',
    email_changed: 'Your account email was changed',
    new_sign_in: 'New sign-in to your account',
    mfa_changed: 'Your sign-in security settings changed',
  }
  return finish({ title: what[kind], body: "If this wasn't you, open Apex AI and review your account security." })
}

export function testNotificationText(): NotificationText {
  return { title: 'Test notification', body: 'Push delivery to this device is working.' }
}
