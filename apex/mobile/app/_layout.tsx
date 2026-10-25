import { resolveNotificationPath } from '@apex/notifications-core'
import * as Notifications from 'expo-notifications'
import { Stack, useRouter } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useRef } from 'react'
import { View } from 'react-native'
import { HeaderBell, HeaderSettings } from '../src/components/HeaderBell.tsx'
import { AuthProvider } from '../src/lib/auth.tsx'
import { configureForegroundHandling, ensureAndroidChannels, isNativePlatform } from '../src/notifications/expoPlatform.ts'
import { NotificationsProvider, useNotifications } from '../src/notifications/NotificationsProvider.tsx'
import { colors } from '../src/theme.ts'

configureForegroundHandling()
void ensureAndroidChannels()

/** Opens the right screen when a notification is tapped, including from a cold start. */
function NotificationRouting() {
  const router = useRouter()
  const { repo, refreshUnread } = useNotifications()
  const handled = useRef(new Set<string>())

  useEffect(() => {
    if (!isNativePlatform) return
    const open = (response: Notifications.NotificationResponse | null) => {
      if (!response) return
      const id = response.notification.request.identifier
      if (handled.current.has(id)) return
      handled.current.add(id)
      const data = response.notification.request.content.data as Record<string, unknown> | undefined
      // Only allow-listed internal paths; anything else opens the notification centre.
      router.push(resolveNotificationPath(data).path as never)
      const notificationId = typeof data?.notificationId === 'string' ? data.notificationId : null
      if (notificationId && repo) void repo.markRead(notificationId).then(refreshUnread).catch(() => {})
    }
    void Notifications.getLastNotificationResponseAsync().then(open)
    const sub = Notifications.addNotificationResponseReceivedListener(open)
    return () => sub.remove()
  }, [router, repo, refreshUnread])
  return null
}

function HeaderActions() {
  return (
    <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
      <HeaderBell />
      <HeaderSettings />
    </View>
  )
}

export default function RootLayout() {
  return (
    <AuthProvider>
      <NotificationsProvider>
        <StatusBar style="light" />
        <NotificationRouting />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.bg },
            headerTintColor: colors.text,
            headerTitleStyle: { fontWeight: '700' },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.bg },
            headerRight: () => <HeaderActions />,
          }}
        >
          <Stack.Screen name="index" options={{ title: 'Apex AI' }} />
          <Stack.Screen name="notifications" options={{ title: 'Notifications', headerRight: () => <HeaderSettings /> }} />
          <Stack.Screen name="settings/index" options={{ title: 'Settings' }} />
          <Stack.Screen name="settings/notifications" options={{ title: 'Notifications & preferences' }} />
          <Stack.Screen name="sign-in" options={{ title: 'Sign in', presentation: 'modal' }} />
        </Stack>
      </NotificationsProvider>
    </AuthProvider>
  )
}
