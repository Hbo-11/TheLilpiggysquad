// Expo implementations of the device interfaces used by registration.ts and
// localReminders.ts. Kept thin so the logic stays testable without a device.

import { ANDROID_CHANNELS } from '@apex/notifications-core'
import * as Application from 'expo-application'
import Constants from 'expo-constants'
import * as Device from 'expo-device'
import * as Localization from 'expo-localization'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { supabase } from '../lib/backend.ts'
import { colors } from '../theme.ts'
import type { LocalScheduler } from './localReminders.ts'
import type { DeviceInfo, PermissionSnapshot, PushBackend, PushPlatform } from './registration.ts'

export const isNativePlatform = Platform.OS === 'ios' || Platform.OS === 'android'

/** Foreground presentation: show banners for incoming notifications while the app is open. */
export function configureForegroundHandling() {
  if (!isNativePlatform) return
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
  })
}

const IMPORTANCE = {
  high: Notifications.AndroidImportance.HIGH,
  default: Notifications.AndroidImportance.DEFAULT,
  low: Notifications.AndroidImportance.LOW,
}

export async function ensureAndroidChannels() {
  if (Platform.OS !== 'android') return
  for (const ch of ANDROID_CHANNELS) {
    await Notifications.setNotificationChannelAsync(ch.id, { name: ch.name, importance: IMPORTANCE[ch.importance], lightColor: colors.purple })
  }
}

function snapshot(p: Notifications.NotificationPermissionsStatus): PermissionSnapshot {
  return {
    status: p.status === 'granted' ? 'granted' : p.status === 'denied' ? 'denied' : 'undetermined',
    canAskAgain: p.canAskAgain,
    provisional: p.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL,
  }
}

export async function getPermission(): Promise<PermissionSnapshot | null> {
  if (!isNativePlatform) return null
  return snapshot(await Notifications.getPermissionsAsync())
}

export function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null
}

export const expoPushPlatform: PushPlatform = {
  os: Platform.OS,
  isPhysicalDevice: Device.isDevice,
  projectId: projectId(),
  getPermission: async () => snapshot(await Notifications.getPermissionsAsync()),
  requestPermission: async () =>
    snapshot(await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowBadge: true, allowSound: true } })),
  getExpoPushToken: async (id) => (await Notifications.getExpoPushTokenAsync({ projectId: id })).data,
  ensureAndroidChannels,
}

export function deviceTimezone(): string {
  return Localization.getCalendars()[0]?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
}

export function deviceInfo(): DeviceInfo | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null
  return {
    platform: Platform.OS,
    deviceName: Device.modelName ?? null, // model, not the user-chosen device name (which may contain their name)
    appVersion: Application.nativeApplicationVersion ?? null,
    timezone: deviceTimezone(),
  }
}

export const supabasePushBackend: PushBackend | null = supabase
  ? {
      async register(token, info) {
        const { error } = await supabase!.rpc('register_push_device', {
          p_token: token,
          p_platform: info.platform,
          p_device_name: info.deviceName,
          p_app_version: info.appVersion,
          p_timezone: info.timezone,
        })
        if (error) throw new Error(error.message)
      },
      async unregister(token) {
        const { error } = await supabase!.rpc('unregister_push_device', { p_token: token })
        if (error) throw new Error(error.message)
      },
      async release(token) {
        const { error } = await supabase!.rpc('release_push_token', { p_token: token })
        if (error) throw new Error(error.message)
      },
    }
  : null

export const expoLocalScheduler: LocalScheduler = {
  async list() {
    if (!isNativePlatform) return []
    const all = await Notifications.getAllScheduledNotificationsAsync()
    return all.map((n) => ({ identifier: n.identifier, data: (n.content.data ?? null) as Record<string, unknown> | null }))
  },
  async cancel(identifier) {
    await Notifications.cancelScheduledNotificationAsync(identifier)
  },
  async schedule(n) {
    await Notifications.scheduleNotificationAsync({
      identifier: n.identifier,
      content: { title: n.title, body: n.body, data: n.data, sound: 'default' },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: n.fireAt, channelId: n.channelId },
    })
  },
}

/** Troubleshooting without a backend: a local notification in a few seconds, clearly labelled. */
export async function scheduleLocalTestNotification() {
  await Notifications.scheduleNotificationAsync({
    content: { title: 'Local test notification', body: 'Scheduled on this device. Server push is not configured.', data: { url: '/settings/notifications', type: 'local_test' } },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 5, channelId: 'default' },
  })
}
