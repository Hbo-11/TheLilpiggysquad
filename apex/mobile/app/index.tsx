import { formatDateTimeInZone, SESSION_TYPE_LABELS } from '@apex/notifications-core'
import { useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Badge, Button, EmptyState, Notice, Row, Screen, Section } from '../src/components/ui.tsx'
import { upcomingSessions } from '../src/data/motorsport.ts'
import { backendConfigured } from '../src/lib/backend.ts'
import { friendlyZone } from '../src/lib/format.ts'
import { useNotifications } from '../src/notifications/NotificationsProvider.tsx'
import { type } from '../src/theme.ts'

type Upcoming = Awaited<ReturnType<typeof upcomingSessions>>

export default function Home() {
  const router = useRouter()
  const { timeZone, unreadCount, mode } = useNotifications()
  const [sessions, setSessions] = useState<Upcoming | null>(null)

  useEffect(() => {
    upcomingSessions({ limit: 8 }).then(setSessions).catch(() => setSessions([]))
  }, [])

  return (
    <Screen>
      <Text style={type.title}>Race weekend</Text>
      {mode === 'demo' ? (
        <Notice tone="warning" icon="flask-outline">
          <Text style={type.small}>Demo build: no Apex AI server or live motorsport data is connected. The notification centre shows labelled samples.</Text>
        </Notice>
      ) : null}
      <Section title={`Upcoming sessions · ${friendlyZone(timeZone)}`}>
        {!backendConfigured || (sessions && sessions.length === 0) ? (
          <EmptyState
            icon="calendar-outline"
            title="No verified schedule available"
            body="Session times appear here once a verified motorsport data source is connected. Apex AI never shows estimated times as official."
          />
        ) : (
          (sessions ?? []).map((s, i, all) => (
            <Pressable key={s.id} onPress={() => router.push(`/events/${s.event_id}`)} accessibilityRole="button">
              <Row last={i === all.length - 1}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={type.body}>
                    {s.events.name} · {s.name || SESSION_TYPE_LABELS[s.session_type]}
                  </Text>
                  <Text style={type.small}>{s.starts_at && s.time_status !== 'tbc' ? formatDateTimeInZone(new Date(s.starts_at), timeZone) : 'Time to be confirmed'}</Text>
                </View>
                {s.status !== 'scheduled' ? <Badge text={s.status.toUpperCase()} tone="warning" /> : s.time_status === 'provisional' ? <Badge text="PROVISIONAL" tone="warning" /> : null}
              </Row>
            </Pressable>
          ))
        )}
      </Section>
      <Section title="Notifications">
        <Row last>
          <View style={{ flex: 1, gap: 8 }}>
            <Text style={type.body}>{unreadCount ? `You have ${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}.` : 'You are all caught up.'}</Text>
            <Button label="Open notification centre" onPress={() => router.push('/notifications')} />
            <Button label="Choose what you're notified about" variant="secondary" onPress={() => router.push('/settings/notifications')} />
          </View>
        </Row>
      </Section>
    </Screen>
  )
}
