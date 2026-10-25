// Per-recipient decision: should this user get a notification record, and should
// (and when should) it be pushed to their devices? Enforced server-side, so a
// preference change takes effect on the next notification, not just in the UI.

import type { NotificationCategory } from './categories.ts'
import { isCategoryEnabled, type NotificationPreferences } from './preferences.ts'
import { decideQuietHours } from './quietHours.ts'
import { evaluateRateLimit, type RecentPush } from './rateLimit.ts'
import { resolveEffectiveTimezone } from './time.ts'

export interface RecipientContext {
  prefs: NotificationPreferences
  deviceTimezone: string | null
  /** Devices with a valid token that accept server pushes. */
  activeDeviceCount: number
  recentPushes: RecentPush[]
}

export type PushPlan =
  | { action: 'send_now' }
  | { action: 'defer'; until: Date; reason: 'quiet_hours' }
  | {
      action: 'none'
      reason:
        | 'push_disabled'
        | 'no_device'
        | 'quiet_hours'
        | 'quiet_hours_session_started'
        | 'category_rate_limited'
        | 'overall_rate_limited'
    }

export type RecipientDecision =
  | { create: false; reason: 'category_disabled' }
  | { create: true; push: PushPlan; timeZone: string }

export function decideForRecipient(input: {
  category: NotificationCategory
  recipient: RecipientContext
  now: Date
  sessionStartsAt?: Date | null
}): RecipientDecision {
  const { category, recipient, now } = input
  if (!isCategoryEnabled(recipient.prefs, category)) return { create: false, reason: 'category_disabled' }

  const { timeZone } = resolveEffectiveTimezone({
    mode: recipient.prefs.timezoneMode,
    preferredTimezone: recipient.prefs.preferredTimezone,
    deviceTimezone: recipient.deviceTimezone,
  })

  const critical = category === 'account_security'
  if (!recipient.prefs.pushEnabled && !critical) return { create: true, timeZone, push: { action: 'none', reason: 'push_disabled' } }
  if (recipient.activeDeviceCount === 0) return { create: true, timeZone, push: { action: 'none', reason: 'no_device' } }

  const quiet = decideQuietHours({
    category,
    now,
    quietHours: recipient.prefs.quietHours,
    timeZone,
    sessionStartsAt: input.sessionStartsAt,
  })
  if (quiet.action === 'in_app_only') return { create: true, timeZone, push: { action: 'none', reason: quiet.reason } }

  const rate = evaluateRateLimit({ category, recentPushes: recipient.recentPushes, now })
  if (!rate.allowed) return { create: true, timeZone, push: { action: 'none', reason: rate.reason } }

  if (quiet.action === 'defer') return { create: true, timeZone, push: quiet }
  return { create: true, timeZone, push: { action: 'send_now' } }
}
