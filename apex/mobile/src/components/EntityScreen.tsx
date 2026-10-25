import { Stack } from 'expo-router'
import { useEffect, useState } from 'react'
import { Text } from 'react-native'
import { getEntity, type NamedEntity } from '../data/motorsport.ts'
import { backendConfigured } from '../lib/backend.ts'
import { useNotifications } from '../notifications/NotificationsProvider.tsx'
import { type } from '../theme.ts'
import { EmptyState, Loading, Screen, Section, ToggleRow } from './ui.tsx'

const VALID_ID = /^[A-Za-z0-9_-]{1,64}$/

/** Driver and team profile destination (opened from driver/team notifications). */
export function EntityScreen({ kind, id }: { kind: 'driver' | 'team'; id: string }) {
  const { follows, toggleFollow } = useNotifications()
  const [entity, setEntity] = useState<NamedEntity | null | undefined>(undefined)

  useEffect(() => {
    if (!VALID_ID.test(id)) return setEntity(null)
    getEntity(kind === 'driver' ? 'drivers' : 'teams', id).then(setEntity).catch(() => setEntity(null))
  }, [kind, id])

  if (!backendConfigured) {
    return (
      <Screen>
        <EmptyState icon="person-outline" title="Live motorsport data isn't connected" body={`This build has no Apex AI server, so ${kind} profiles are unavailable.`} />
      </Screen>
    )
  }
  if (entity === undefined) return <Loading label={`Loading ${kind}`} />
  if (entity === null) {
    return (
      <Screen>
        <EmptyState icon="help-circle-outline" title={`${kind === 'driver' ? 'Driver' : 'Team'} not found`} body="It may have been removed by the data provider." />
      </Screen>
    )
  }
  const following = follows.some((f) => f.entity_type === kind && f.entity_id === entity.id)
  return (
    <Screen>
      <Stack.Screen options={{ title: entity.name }} />
      <Text style={type.title}>{entity.name}</Text>
      <Section title="Notifications" footer="You'll be notified about confirmed announcements, penalties, results and sessions. Rumours are never sent.">
        <ToggleRow icon="star-outline" label={`Follow ${entity.name}`} value={following} onChange={(v) => void toggleFollow(kind, entity.id, v)} last />
      </Section>
    </Screen>
  )
}

/** Destination for Apex AI / Track Lab notifications whose viewer is not part of this build. */
export function ModuleDestination({ title, module, id }: { title: string; module: string; id: string }) {
  const valid = VALID_ID.test(id)
  return (
    <Screen>
      <Stack.Screen options={{ title }} />
      <EmptyState
        icon="sparkles-outline"
        title={valid ? title : 'Item not found'}
        body={
          valid
            ? `You opened this from a notification (reference ${id}). The ${module} viewer is a separate Apex AI module that isn't included in this build, so the item can't be displayed here yet.`
            : 'This link is not valid.'
        }
      />
    </Screen>
  )
}
