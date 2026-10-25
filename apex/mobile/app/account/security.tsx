import { useRouter } from 'expo-router'
import { useCallback, useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { Badge, Button, EmptyState, Row, Screen, Section } from '../../src/components/ui.tsx'
import { myDevices, removeDevice, type DeviceRow } from '../../src/data/motorsport.ts'
import { useAuth } from '../../src/lib/auth.tsx'
import { backendConfigured } from '../../src/lib/backend.ts'
import { timeAgo } from '../../src/lib/format.ts'
import { type } from '../../src/theme.ts'

/** Destination for account-security notifications: devices that receive pushes, and sign-out. */
export default function AccountSecurity() {
  const router = useRouter()
  const { userId, email, signOut } = useAuth()
  const [devices, setDevices] = useState<DeviceRow[]>([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    if (userId) myDevices().then(setDevices).catch(() => setDevices([]))
  }, [userId])
  useEffect(load, [load])

  if (!backendConfigured || !userId) {
    return (
      <Screen>
        <EmptyState
          icon="shield-checkmark-outline"
          title={backendConfigured ? 'Sign in to manage account security' : 'Accounts are not configured in this build'}
          body="Security alerts are sent when your password or email changes."
          action={backendConfigured ? <Button label="Sign in" onPress={() => router.push('/sign-in')} /> : undefined}
        />
      </Screen>
    )
  }

  return (
    <Screen>
      <Section title="Account">
        <Row last>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={type.body}>{email}</Text>
            <Text style={type.small}>If you received a security alert you don't recognise, change your password and remove any devices you don't know.</Text>
          </View>
        </Row>
      </Section>
      <Section title="Devices receiving notifications" footer="Removing a device stops notifications to it straight away. Signing out of Apex AI on a device also removes it.">
        {devices.length === 0 ? (
          <Row last>
            <Text style={type.small}>No devices are registered for push notifications.</Text>
          </Row>
        ) : (
          devices.map((d, i) => (
            <Row key={d.id} last={i === devices.length - 1}>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={type.body}>
                  {d.device_name ?? (d.platform === 'ios' ? 'iPhone or iPad' : 'Android device')} {d.token_hint}
                </Text>
                <Text style={type.small}>
                  {d.platform} · app {d.app_version ?? 'unknown'} · registered {timeAgo(d.last_registered_at)}
                </Text>
                {d.invalidated_at ? <Badge text={`INACTIVE: ${d.invalid_reason ?? 'unknown'}`} tone="warning" /> : null}
              </View>
              <Button label="Remove" variant="danger" onPress={() => void removeDevice(d.id).then(load)} />
            </Row>
          ))
        )}
      </Section>
      <Button
        label="Sign out on this device"
        variant="danger"
        busy={busy}
        onPress={async () => {
          setBusy(true)
          await signOut()
          setBusy(false)
          router.replace('/')
        }}
      />
    </Screen>
  )
}
