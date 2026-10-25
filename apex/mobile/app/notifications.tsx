// In-app notification centre: unread state, mark read / all read, dismiss,
// category filters, incremental loading, and loading/empty/error/signed-out states.

import { resolveNotificationPath } from '@apex/notifications-core'
import { useRouter } from 'expo-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { NotificationRow } from '../src/components/NotificationRow.tsx'
import { Button, Chip, EmptyState, ErrorState, Loading, Notice } from '../src/components/ui.tsx'
import { useNotifications } from '../src/notifications/NotificationsProvider.tsx'
import { FILTERS, type AppNotification, type Cursor, type FilterKey } from '../src/notifications/repository.ts'
import { colors, spacing, type } from '../src/theme.ts'

const PAGE = 20

export default function NotificationCentre() {
  const router = useRouter()
  const { repo, mode, unreadCount, refreshUnread, timeZone } = useNotifications()
  const [filter, setFilter] = useState<FilterKey>('all')
  const [items, setItems] = useState<AppNotification[]>([])
  const [cursor, setCursor] = useState<Cursor | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const request = useRef(0)

  const load = useCallback(
    async (reset: boolean) => {
      if (!repo) return
      const id = ++request.current
      try {
        const page = await repo.list({ filter, cursor: reset ? null : cursor, limit: PAGE })
        if (id !== request.current) return // a newer request (e.g. filter change) won
        setItems((prev) => (reset ? page.items : [...prev, ...page.items]))
        setCursor(page.nextCursor)
        setStatus('ready')
      } catch (e) {
        if (id !== request.current) return
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      }
    },
    [repo, filter, cursor],
  )

  useEffect(() => {
    setStatus('loading')
    setItems([])
    setCursor(null)
    void load(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, filter])

  useEffect(() => {
    if (!repo) return
    return repo.subscribe(() => void load(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, filter])

  if (!repo) {
    return (
      <View style={styles.screen}>
        <EmptyState
          icon="person-circle-outline"
          title="Sign in to see your notifications"
          body="Notifications are personal to your account. You can keep browsing Apex AI without signing in."
          action={<Button label="Sign in" onPress={() => router.push('/sign-in')} />}
        />
      </View>
    )
  }

  const update = async (fn: () => Promise<void>, optimistic: (list: AppNotification[]) => AppNotification[]) => {
    const before = items
    setItems(optimistic(items))
    try {
      await fn()
    } catch {
      setItems(before) // roll back; the row stays as it was
    }
    void refreshUnread()
  }

  const open = (n: AppNotification) => {
    if (!n.readAt) void update(() => repo.markRead(n.id), (l) => l.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)))
    const { path } = resolveNotificationPath({ url: n.deepLink })
    if (path !== '/notifications') router.push(path as never)
  }

  const header = (
    <View style={styles.header}>
      {mode === 'demo' ? (
        <Notice tone="warning" icon="flask-outline">
          <Text style={type.small}>
            Demo mode: no Apex AI server is configured in this build, so these are labelled sample notifications stored on this device. They are never pushed.
          </Text>
        </Notice>
      ) : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
        {FILTERS.map((f) => (
          <Chip key={f.key} label={f.label} selected={filter === f.key} onPress={() => setFilter(f.key)} />
        ))}
      </ScrollView>
      <View style={styles.toolbar}>
        <Text style={type.small}>{unreadCount ? `${unreadCount} unread` : 'All caught up'}</Text>
        <Pressable
          onPress={() => update(() => repo.markAllRead(), (l) => l.map((x) => ({ ...x, readAt: x.readAt ?? new Date().toISOString() })))}
          disabled={!unreadCount}
          accessibilityRole="button"
          hitSlop={8}
        >
          <Text style={[styles.link, !unreadCount && styles.linkDisabled]}>Mark all as read</Text>
        </Pressable>
      </View>
    </View>
  )

  return (
    <View style={styles.screen}>
      <FlatList
        data={status === 'ready' ? items : []}
        keyExtractor={(n) => n.id}
        ListHeaderComponent={header}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={{ height: spacing.sm }} />}
        renderItem={({ item }) => (
          <NotificationRow
            item={item}
            timeZone={timeZone}
            onOpen={() => open(item)}
            onArchive={() => update(() => repo.archive(item.id), (l) => l.filter((x) => x.id !== item.id))}
            onToggleRead={() =>
              item.readAt ? undefined : update(() => repo.markRead(item.id), (l) => l.map((x) => (x.id === item.id ? { ...x, readAt: new Date().toISOString() } : x)))
            }
          />
        )}
        ListEmptyComponent={
          status === 'loading' ? (
            <Loading label="Loading notifications" />
          ) : status === 'error' ? (
            <ErrorState message={error} onRetry={() => (setStatus('loading'), void load(true))} />
          ) : (
            <EmptyState
              icon="notifications-off-outline"
              title={filter === 'all' ? 'No notifications yet' : 'Nothing here'}
              body={
                filter === 'all'
                  ? 'Follow championships, drivers and teams, or start an Apex AI task, and updates will appear here.'
                  : 'No notifications match this filter.'
              }
              action={filter === 'all' ? <Button label="Notification settings" variant="secondary" onPress={() => router.push('/settings/notifications')} /> : undefined}
            />
          )
        }
        onEndReachedThreshold={0.4}
        onEndReached={async () => {
          if (!cursor || loadingMore || status !== 'ready') return
          setLoadingMore(true)
          await load(false)
          setLoadingMore(false)
        }}
        ListFooterComponent={loadingMore ? <Loading label="Loading more" /> : undefined}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={colors.purple}
            onRefresh={async () => {
              setRefreshing(true)
              await Promise.all([load(true), refreshUnread()])
              setRefreshing(false)
            }}
          />
        }
      />
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.lg, paddingBottom: 48, maxWidth: 720, width: '100%', alignSelf: 'center' },
  header: { gap: spacing.md, marginBottom: spacing.md },
  filters: { gap: spacing.sm, paddingRight: spacing.lg },
  toolbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  link: { color: colors.purpleBright, fontWeight: '700' },
  linkDisabled: { color: colors.textDim },
})
