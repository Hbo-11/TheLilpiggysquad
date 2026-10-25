import { CATEGORY_INFO, type NotificationCategory } from './categories.ts'

/**
 * Push rate limits per user. When a limit is hit the notification is still recorded
 * in the notification centre; only the device push is suppressed. Account security
 * and system messages are exempt and do not count towards the overall cap.
 */
export const RATE_LIMITS = {
  windowMs: 60 * 60_000,
  /** Total pushes per user per window across rate-limited categories. */
  overallPerWindow: 8,
  perCategoryPerWindow: {
    race_reminders: 6,
    schedule_changes: 4,
    race_results: 3,
    driver_updates: 3,
    team_updates: 3,
    news_major: 2,
    news_breaking: 3,
    ai_tasks: 5,
    track_lab: 5,
    sim_racing: 2,
    weekly_summary: 1,
    product_updates: 1,
  } as Partial<Record<NotificationCategory, number>>,
}

/** Window in which related notifications (same collapse key) update one entry instead of adding more. */
export const COLLAPSE_WINDOW_MS = 6 * 60 * 60_000

export function isRateLimitExempt(category: NotificationCategory): boolean {
  return CATEGORY_INFO[category].priority === 'critical' || category === 'system'
}

export interface RecentPush {
  category: NotificationCategory
  at: Date
}

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: 'category_rate_limited' | 'overall_rate_limited' }

export function evaluateRateLimit(input: {
  category: NotificationCategory
  recentPushes: RecentPush[]
  now: Date
  limits?: typeof RATE_LIMITS
}): RateLimitDecision {
  const limits = input.limits ?? RATE_LIMITS
  if (isRateLimitExempt(input.category)) return { allowed: true }
  const since = input.now.getTime() - limits.windowMs
  const inWindow = input.recentPushes.filter((p) => p.at.getTime() > since && !isRateLimitExempt(p.category))
  const categoryCap = limits.perCategoryPerWindow[input.category]
  if (categoryCap !== undefined && inWindow.filter((p) => p.category === input.category).length >= categoryCap) {
    return { allowed: false, reason: 'category_rate_limited' }
  }
  if (inWindow.length >= limits.overallPerWindow) return { allowed: false, reason: 'overall_rate_limited' }
  return { allowed: true }
}

/** Rate limit for user-initiated test notifications (troubleshooting). */
export const TEST_NOTIFICATION_LIMIT = { max: 3, windowMs: 10 * 60_000 }
