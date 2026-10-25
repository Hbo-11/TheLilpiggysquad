import type { SupabaseClient } from '@supabase/supabase-js'
import { FILTERS, type AppNotification, type Cursor, type FilterKey, type NotificationPage, type NotificationRepository } from './repository.ts'

interface Row {
  id: string
  category: AppNotification['category']
  kind: string
  title: string
  body: string
  deep_link: string | null
  created_at: string
  read_at: string | null
  is_demo: boolean
  push_state: string
  push_note: string | null
  source_url: string | null
  group_count: number
}

const COLUMNS = 'id, category, kind, title, body, deep_link, created_at, read_at, is_demo, push_state, push_note, source_url, group_count'

function toNotification(r: Row): AppNotification {
  return {
    id: r.id,
    category: r.category,
    kind: r.kind,
    title: r.title,
    body: r.body,
    deepLink: r.deep_link,
    createdAt: r.created_at,
    readAt: r.read_at,
    isDemo: r.is_demo,
    pushState: r.push_state,
    pushNote: r.push_note,
    sourceUrl: r.source_url,
    groupCount: r.group_count,
  }
}

/** Reads the signed-in user's notifications. RLS guarantees only their rows are visible. */
export class SupabaseNotificationRepository implements NotificationRepository {
  readonly mode = 'server' as const
  private client: SupabaseClient
  private userId: string

  constructor(client: SupabaseClient, userId: string) {
    this.client = client
    this.userId = userId
  }

  async list(opts: { filter: FilterKey; cursor: Cursor | null; limit: number }): Promise<NotificationPage> {
    let q = this.client
      .from('notifications')
      .select(COLUMNS)
      .is('archived_at', null)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(opts.limit + 1)
    const categories = FILTERS.find((f) => f.key === opts.filter)?.categories
    if (categories) q = q.in('category', categories)
    if (opts.filter === 'unread') q = q.is('read_at', null)
    if (opts.cursor) {
      // Keyset pagination: stable while new notifications arrive.
      q = q.or(`created_at.lt.${opts.cursor.createdAt},and(created_at.eq.${opts.cursor.createdAt},id.lt.${opts.cursor.id})`)
    }
    const { data, error } = await q
    if (error) throw new Error(error.message)
    const rows = (data as Row[]).map(toNotification)
    const items = rows.slice(0, opts.limit)
    const last = items.at(-1)
    return { items, nextCursor: rows.length > opts.limit && last ? { createdAt: last.createdAt, id: last.id } : null }
  }

  async unreadCount(): Promise<number> {
    const { count, error } = await this.client
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null)
      .is('archived_at', null)
    if (error) throw new Error(error.message)
    return count ?? 0
  }

  async markRead(id: string) {
    const { error } = await this.client.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id).is('read_at', null)
    if (error) throw new Error(error.message)
  }

  async markAllRead() {
    const { error } = await this.client.rpc('mark_all_notifications_read')
    if (error) throw new Error(error.message)
  }

  async archive(id: string) {
    const { error } = await this.client.from('notifications').update({ archived_at: new Date().toISOString() }).eq('id', id)
    if (error) throw new Error(error.message)
  }

  async seedSamples() {
    const { data, error } = await this.client.rpc('seed_demo_notifications')
    if (error) throw new Error(error.message)
    return Number(data)
  }

  async clearSamples() {
    const { data, error } = await this.client.rpc('clear_demo_notifications')
    if (error) throw new Error(error.message)
    return Number(data)
  }

  subscribe(onChange: () => void) {
    const channel = this.client
      .channel(`notifications:${this.userId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${this.userId}` }, onChange)
      .subscribe()
    return () => {
      void this.client.removeChannel(channel)
    }
  }
}
