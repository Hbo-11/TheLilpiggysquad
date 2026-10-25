// Deterministic deduplication keys. The database enforces UNIQUE (user_id, dedupe_key)
// on notifications, so creating the same notification twice (a retried job, a second
// matching follow, a re-run of the reminder scan) is a no-op.

const SAFE = /[^A-Za-z0-9_.:@-]/g

function part(value: string | number): string {
  return String(value).replace(SAFE, '_').slice(0, 80)
}

export const dedupeKeys = {
  /**
   * Includes the session start, so a rescheduled session gets fresh reminders while
   * reminders for the obsolete time can be cancelled.
   */
  sessionReminder(sessionId: string, startsAtIso: string, offsetMinutes: number): string {
    return `reminder:${part(sessionId)}:${part(new Date(startsAtIso).toISOString())}:${offsetMinutes}`
  },
  scheduleChange(sessionId: string, scheduleVersion: number): string {
    return `schedule:${part(sessionId)}:v${scheduleVersion}`
  },
  sessionStatus(sessionId: string, status: string): string {
    return `status:${part(sessionId)}:${part(status)}`
  },
  resultsPublished(sessionId: string): string {
    return `results:${part(sessionId)}`
  },
  article(sourceId: string, externalRef: string): string {
    return `article:${part(sourceId)}:${part(externalRef)}`
  },
  appEvent(kind: string, resourceId: string): string {
    return `app:${part(kind)}:${part(resourceId)}`
  },
  security(kind: string, eventId: string): string {
    return `security:${part(kind)}:${part(eventId)}`
  },
  test(requestId: string): string {
    return `test:${part(requestId)}`
  },
}

/** Collapse keys group related updates (the same story, the same job) into one notification. */
export const collapseKeys = {
  story(storyKey: string): string {
    return `story:${part(storyKey)}`
  },
  session(sessionId: string): string {
    return `session:${part(sessionId)}`
  },
}
