// Event page (opened by race reminders, schedule changes and results notifications).
// Shows each session in the user's timezone and the venue's local time, and is
// explicit about unconfirmed times and changes.

import { formatDateTimeInZone, SESSION_TYPE_LABELS } from '@apex/notifications-core'
import { Stack, useLocalSearchParams } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import { Badge, EmptyState, ErrorState, Loading, Notice, Row, Screen, Section, ToggleRow } from '../../src/components/ui.tsx'
import { getEvent, isEventSaved, setEventSaved, type EventRow, type SessionRow } from '../../src/data/motorsport.ts'
import { useAuth } from '../../src/lib/auth.tsx'
import { backendConfigured } from '../../src/lib/backend.ts'
import { friendlyZone, timeAgo } from '../../src/lib/format.ts'
import { useNotifications } from '../../src/notifications/NotificationsProvider.tsx'
import { spacing, type } from '../../src/theme.ts'

const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/

function SessionLine({ s, event, timeZone, last }: { s: SessionRow; event: EventRow; timeZone: string; last: boolean }) {
  const venueZone = s.timezone ?? event.timezone
  const start = s.starts_at ? new Date(s.starts_at) : null
  return (
    <Row last={last}>
      <View style={styles.grow}>
        <View style={styles.inline}>
          <Text style={type.body}>{s.name || SESSION_TYPE_LABELS[s.session_type]}</Text>
          {s.status === 'live' ? <Badge text="LIVE" tone="success" /> : null}
          {s.status === 'cancelled' ? <Badge text="CANCELLED" tone="danger" /> : null}
          {s.status === 'postponed' ? <Badge text="POSTPONED" tone="warning" /> : null}
          {s.status === 'finished' ? <Badge text="FINISHED" tone="muted" /> : null}
          {s.time_status === 'provisional' ? <Badge text="PROVISIONAL TIME" tone="warning" /> : null}
        </View>
        {start && s.time_status !== 'tbc' ? (
          <>
            <Text style={type.small}>{formatDateTimeInZone(start, timeZone)} (your time)</Text>
            {venueZone !== timeZone ? <Text style={type.tiny}>{formatDateTimeInZone(start, venueZone)} at the circuit</Text> : null}
          </>
        ) : (
          <Text style={type.small}>Time to be confirmed. No reminder will be sent until the time is confirmed.</Text>
        )}
        {s.time_status === 'provisional' ? <Text style={type.tiny}>Provisional times are not used for reminders.</Text> : null}
        {s.results_published_at ? <Text style={type.tiny}>Official results published {timeAgo(s.results_published_at)}</Text> : null}
        {s.results_url ? (
          <Text style={styles.link} onPress={() => void Linking.openURL(s.results_url!)} accessibilityRole="link">
            View official classification
          </Text>
        ) : null}
      </View>
    </Row>
  )
}

export default function EventScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { userId } = useAuth()
  const { timeZone } = useNotifications()
  const [event, setEvent] = useState<EventRow | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'error'>('loading')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const load = useCallback(async () => {
    if (!VALID_ID.test(String(id))) return setState('missing')
    setState('loading')
    try {
      const e = await getEvent(String(id))
      setEvent(e)
      setState(e ? 'ready' : 'missing')
      if (e && userId) setSaved(await isEventSaved(e.id))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setState('error')
    }
  }, [id, userId])

  useEffect(() => void load(), [load])

  if (!backendConfigured) {
    return (
      <Screen>
        <EmptyState icon="flag-outline" title="Live motorsport data isn't connected" body="This build has no Apex AI server, so there are no event schedules to show." />
      </Screen>
    )
  }
  if (state === 'loading') return <Loading label="Loading event" />
  if (state === 'error') return <ErrorState message={error} onRetry={load} />
  if (state === 'missing' || !event) {
    return (
      <Screen>
        <EmptyState icon="help-circle-outline" title="Event not found" body="It may have been removed by the data provider." />
      </Screen>
    )
  }

  const sessions = [...event.event_sessions].sort((a, b) => (a.starts_at ?? '9').localeCompare(b.starts_at ?? '9'))
  return (
    <Screen>
      <Stack.Screen options={{ title: event.name }} />
      <View style={styles.headerBlock}>
        <Text style={type.title}>{event.name}</Text>
        <Text style={type.small}>{[event.circuit_name, event.country].filter(Boolean).join(' · ')}</Text>
        {event.status !== 'scheduled' ? <Badge text={event.status.toUpperCase()} tone="warning" /> : null}
      </View>
      <Notice icon="time-outline">
        <Text style={type.small}>
          Times are shown in {friendlyZone(timeZone)}. Source: {event.data_sources?.name ?? event.source_id}.
        </Text>
      </Notice>
      <Section title="Sessions">
        {sessions.length ? (
          sessions.map((s, i) => <SessionLine key={s.id} s={s} event={event} timeZone={timeZone} last={i === sessions.length - 1} />)
        ) : (
          <Row last>
            <Text style={type.small}>The session schedule has not been published yet.</Text>
          </Row>
        )}
      </Section>
      {userId ? (
        <Section title="Reminders" footer="Reminder timings and session types come from Settings > Notifications.">
          <ToggleRow
            icon="alarm-outline"
            label="Remind me about this event"
            description="Even if you don't follow this championship."
            value={saved}
            onChange={async (v) => {
              setSaved(v)
              await setEventSaved(userId, event.id, v).catch(() => setSaved(!v))
            }}
            last
          />
        </Section>
      ) : null}
    </Screen>
  )
}

const styles = StyleSheet.create({
  headerBlock: { gap: spacing.xs },
  grow: { flex: 1, gap: 3 },
  inline: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', flexWrap: 'wrap' },
  link: { color: '#C084FC', fontWeight: '700', marginTop: 4 },
})
