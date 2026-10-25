// Notification centre data. Two implementations behind one interface:
// - SupabaseNotificationRepository: real per-user notifications (RLS-protected).
// - DemoNotificationRepository: used when no backend is configured. Every item is
//   labelled as a sample and nothing in it describes a real event.

import { CATEGORY_INFO, type NotificationCategory } from '@apex/notifications-core'
import type { KeyValueStore } from './registration.ts'

export interface AppNotification {
  id: string
  category: NotificationCategory
  kind: string
  title: string
  body: string
  deepLink: string | null
  createdAt: string
  readAt: string | null
  isDemo: boolean
  pushState: string
  pushNote: string | null
  sourceUrl: string | null
  groupCount: number
}

export type FilterKey = 'all' | 'unread' | 'race' | 'results' | 'drivers_teams' | 'news' | 'apex_ai' | 'account'

export const FILTERS: { key: FilterKey; label: string; categories: NotificationCategory[] | null }[] = [
  { key: 'all', label: 'All', categories: null },
  { key: 'unread', label: 'Unread', categories: null },
  { key: 'race', label: 'Race weekend', categories: ['race_reminders', 'schedule_changes'] },
  { key: 'results', label: 'Results', categories: ['race_results'] },
  { key: 'drivers_teams', label: 'Drivers & teams', categories: ['driver_updates', 'team_updates'] },
  { key: 'news', label: 'News', categories: ['news_major', 'news_breaking', 'weekly_summary'] },
  { key: 'apex_ai', label: 'Apex AI', categories: ['ai_tasks', 'track_lab', 'sim_racing', 'product_updates'] },
  { key: 'account', label: 'Account', categories: ['account_security', 'system'] },
]

export interface Cursor {
  createdAt: string
  id: string
}

export interface NotificationPage {
  items: AppNotification[]
  nextCursor: Cursor | null
}

export interface NotificationRepository {
  readonly mode: 'server' | 'demo'
  list(opts: { filter: FilterKey; cursor: Cursor | null; limit: number }): Promise<NotificationPage>
  unreadCount(): Promise<number>
  markRead(id: string): Promise<void>
  markAllRead(): Promise<void>
  archive(id: string): Promise<void>
  seedSamples(): Promise<number>
  clearSamples(): Promise<number>
  /** Subscribe to changes made elsewhere (realtime, other screens). Returns an unsubscribe function. */
  subscribe(onChange: () => void): () => void
}

/** Plain-language explanation of push_state/push_note for the notification row. */
export function describePushNote(n: Pick<AppNotification, 'pushState' | 'pushNote' | 'isDemo'>): string | null {
  if (n.isDemo) return 'Sample – not sent to your device'
  if (n.pushNote === 'held_for_quiet_hours' && n.pushState === 'scheduled') return 'Held until your quiet hours end'
  switch (n.pushNote) {
    case 'quiet_hours':
    case 'quiet_hours_session_started':
      return 'Not pushed during quiet hours'
    case 'category_rate_limited':
    case 'overall_rate_limited':
      return 'Not pushed: notification limit reached'
    case 'no_device':
      return 'In-app only: no device registered'
    case 'push_disabled':
      return 'In-app only: device notifications are off'
  }
  if (n.pushState === 'failed') return 'Could not be delivered to your device'
  return null
}

export function matchesFilter(n: AppNotification, filter: FilterKey): boolean {
  if (filter === 'unread') return n.readAt === null
  const f = FILTERS.find((x) => x.key === filter)
  return !f?.categories || f.categories.includes(n.category)
}

export function iconFor(category: NotificationCategory): string {
  return CATEGORY_INFO[category]?.icon ?? 'notifications-outline'
}

// ---------------------------------------------------------------------------

const DEMO_KEY = 'apex.demo.notifications'

function sample(id: number, category: NotificationCategory, title: string, body: string, minutesAgo: number, read: boolean, deepLink: string | null, now: Date): AppNotification {
  const created = new Date(now.getTime() - minutesAgo * 60_000)
  return {
    id: `demo-${id}`,
    category,
    kind: 'demo',
    title,
    body,
    deepLink,
    createdAt: created.toISOString(),
    readAt: read ? created.toISOString() : null,
    isDemo: true,
    pushState: 'none',
    pushNote: null,
    sourceUrl: null,
    groupCount: 1,
  }
}

/** Stage 1 samples. Labelled "Sample:" and never describing a real session, result or announcement. */
export function demoNotifications(now: Date): AppNotification[] {
  return [
    sample(1, 'race_reminders', 'Sample: Qualifying starts in 30 minutes', 'Demonstration only, not a real session. Real reminders use verified event times.', 5, false, '/notifications', now),
    sample(2, 'race_results', 'Sample: Official race results are available', 'Demonstration only. Real result alerts are sent when official classifications are published.', 120, false, '/notifications', now),
    sample(3, 'track_lab', 'Sample: Your circuit design is ready', 'Demonstration only. Track Lab sends this when a generation task you started finishes.', 60 * 24, true, '/notifications', now),
    sample(4, 'schedule_changes', 'Sample: Race session rescheduled', 'Demonstration only. Schedule alerts are sent only for confirmed changes from trusted sources.', 60 * 72, false, '/notifications', now),
    sample(5, 'system', 'Sample: Notification settings', 'Demonstration only. Open settings to choose what you are notified about.', 60 * 96, true, '/settings/notifications', now),
  ]
}

export class DemoNotificationRepository implements NotificationRepository {
  readonly mode = 'demo' as const
  private items: AppNotification[] | null = null
  private listeners = new Set<() => void>()
  private store: KeyValueStore
  private now: () => Date

  constructor(store: KeyValueStore, now: () => Date = () => new Date()) {
    this.store = store
    this.now = now
  }

  private async load(): Promise<AppNotification[]> {
    if (this.items) return this.items
    const raw = await this.store.get(DEMO_KEY)
    if (raw === null) {
      this.items = demoNotifications(this.now())
      await this.persist()
    } else {
      try {
        this.items = JSON.parse(raw) as AppNotification[]
      } catch {
        this.items = []
      }
    }
    return this.items
  }

  private async persist() {
    await this.store.set(DEMO_KEY, JSON.stringify(this.items ?? []))
    for (const l of this.listeners) l()
  }

  async list(opts: { filter: FilterKey; cursor: Cursor | null; limit: number }): Promise<NotificationPage> {
    const all = (await this.load())
      .filter((n) => matchesFilter(n, opts.filter))
      .sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1))
    const start = opts.cursor ? all.findIndex((n) => n.id === opts.cursor!.id) + 1 : 0
    const items = all.slice(start, start + opts.limit)
    const last = items.at(-1)
    return { items, nextCursor: start + opts.limit < all.length && last ? { createdAt: last.createdAt, id: last.id } : null }
  }

  async unreadCount() {
    return (await this.load()).filter((n) => n.readAt === null).length
  }

  async markRead(id: string) {
    const n = (await this.load()).find((x) => x.id === id)
    if (n && !n.readAt) {
      n.readAt = this.now().toISOString()
      await this.persist()
    }
  }

  async markAllRead() {
    const ts = this.now().toISOString()
    for (const n of await this.load()) n.readAt ??= ts
    await this.persist()
  }

  async archive(id: string) {
    this.items = (await this.load()).filter((n) => n.id !== id)
    await this.persist()
  }

  async seedSamples() {
    const existing = new Set((await this.load()).map((n) => n.id))
    const add = demoNotifications(this.now()).filter((n) => !existing.has(n.id))
    this.items = [...(this.items ?? []), ...add]
    await this.persist()
    return add.length
  }

  async clearSamples() {
    const before = (await this.load()).length
    this.items = (this.items ?? []).filter((n) => !n.isDemo)
    await this.persist()
    return before - this.items.length
  }

  subscribe(onChange: () => void) {
    this.listeners.add(onChange)
    return () => this.listeners.delete(onChange)
  }
}
