// Deterministic deduplication keys. The database enforces UNIQUE (user_id, dedupe_key)
// on notifications, so creating the same notification twice (a retried job, a second
// matching follow, a re-run of the reminder scan) is a no-op.

const SAFE = /^[A-Za-z0-9_.@-]{1,100}$/

/** FNV-1a, two seeds (64 bits): enough to keep distinct ids apart in a key. */
function hash(value: string): string {
  let a = 0x811c9dc5
  let b = 0x01000193 ^ value.length
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193)
    b = Math.imul(b ^ c, 0x5bd1e995)
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36)
}

/**
 * Key component. Safe values up to 100 characters are used as-is; anything else
 * (unusual characters, long values) gets a hash so different ids never collide.
 */
function part(value: string | number): string {
  const v = String(value)
  if (SAFE.test(v)) return v
  return `${v.replace(/[^A-Za-z0-9_.@-]/g, '').slice(0, 40)}~${hash(v)}`
}

export const dedupeKeys = {
  /**
   * Includes the session start, so a rescheduled session gets fresh reminders while
   * reminders for the obsolete time can be cancelled.
   */
  sessionReminder(sessionId: string, startsAtIso: string, offsetMinutes: number): string {
    return `reminder:${part(sessionId)}:${new Date(startsAtIso).getTime()}:${offsetMinutes}`
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
