// App-wide notification state: the repository behind the notification centre,
// the unread badge, preferences (saved to the server and enforced there), follows,
// device permission/registration, and local reminder sync.

import {
  detectTimezoneChange,
  resolveEffectiveTimezone,
  type NotificationPreferences,
} from '@apex/notifications-core'
import * as Notifications from 'expo-notifications'
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { useAuth } from '../lib/auth.tsx'
import { backendConfigured, storage, supabase } from '../lib/backend.ts'
import {
  loadFollows,
  loadPreferences,
  reportDeviceTimezone,
  savePreferences,
  setFollow as persistFollow,
  upcomingSessions,
  type EntityType,
  type Follow,
} from '../data/motorsport.ts'
import {
  deviceInfo,
  deviceTimezone,
  expoLocalScheduler,
  expoPushPlatform,
  getPermission,
  isNativePlatform,
  supabasePushBackend,
} from './expoPlatform.ts'
import { syncLocalReminders, type ReminderSession } from './localReminders.ts'
import {
  registerForPush,
  releasePendingToken,
  reminderDeliveryMode,
  type PermissionSnapshot,
  type RegistrationResult,
} from './registration.ts'
import { DemoNotificationRepository, type NotificationRepository } from './repository.ts'
import { SupabaseNotificationRepository } from './supabaseRepository.ts'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

interface NotificationsState {
  /** null when a backend exists but the user is signed out (sign-in needed for the centre). */
  repo: NotificationRepository | null
  mode: 'server' | 'demo'
  unreadCount: number
  refreshUnread(): Promise<void>
  prefs: NotificationPreferences | null
  prefsError: string | null
  saveState: SaveState
  updatePrefs(update: (p: NotificationPreferences) => NotificationPreferences): void
  retrySave(): void
  follows: Follow[]
  toggleFollow(entityType: EntityType, entityId: string, on: boolean): Promise<void>
  permission: PermissionSnapshot | null
  registration: RegistrationResult | null
  /** Shows the OS prompt. Only call after the PermissionPrimer explanation. */
  enableDevicePush(): Promise<RegistrationResult>
  reminderMode: 'server' | 'local' | 'none'
  timeZone: string
  deviceTimeZone: string
  timezoneNotice: { from: string; to: string } | null
  dismissTimezoneNotice(): void
  resyncReminders(): Promise<void>
}

const Ctx = createContext<NotificationsState | null>(null)
const LAST_DEVICE_TZ = 'apex.lastDeviceTimezone'

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { userId } = useAuth()
  const repo = useMemo<NotificationRepository | null>(() => {
    if (!backendConfigured) return new DemoNotificationRepository(storage)
    return supabase && userId ? new SupabaseNotificationRepository(supabase, userId) : null
  }, [userId])

  const [unreadCount, setUnread] = useState(0)
  const [prefs, setPrefs] = useState<NotificationPreferences | null>(null)
  const [prefsError, setPrefsError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [follows, setFollows] = useState<Follow[]>([])
  const [permission, setPermission] = useState<PermissionSnapshot | null>(null)
  const [registration, setRegistration] = useState<RegistrationResult | null>(null)
  const [deviceTz] = useState(deviceTimezone)
  const [timezoneNotice, setTimezoneNotice] = useState<{ from: string; to: string } | null>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestPrefs = useRef<NotificationPreferences | null>(null)

  const refreshUnread = useCallback(async () => {
    if (!repo) return setUnread(0)
    try {
      setUnread(await repo.unreadCount())
    } catch {
      // Keep the last known count; the centre shows the error.
    }
  }, [repo])

  useEffect(() => {
    void refreshUnread()
    if (!repo) return
    const unsubscribe = repo.subscribe(() => void refreshUnread())
    const app = AppState.addEventListener('change', (s) => s === 'active' && void refreshUnread())
    const received = isNativePlatform ? Notifications.addNotificationReceivedListener(() => void refreshUnread()) : null
    return () => {
      unsubscribe()
      app.remove()
      received?.remove()
    }
  }, [repo, refreshUnread])

  // Preferences and follows for the current user (or this device when signed out / demo).
  useEffect(() => {
    let cancelled = false
    setPrefs(null)
    loadPreferences(userId)
      .then(({ prefs: p }) => {
        if (cancelled) return
        setPrefs(p)
        latestPrefs.current = p
        setPrefsError(null)
      })
      .catch((e) => !cancelled && setPrefsError(String(e.message ?? e)))
    loadFollows(userId)
      .then((f) => !cancelled && setFollows(f))
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [userId])

  const persist = useCallback(
    (p: NotificationPreferences) => {
      setSaveState('saving')
      savePreferences(userId, p)
        .then(() => setSaveState('saved'))
        .catch(() => setSaveState('error'))
    },
    [userId],
  )

  const updatePrefs = useCallback(
    (update: (p: NotificationPreferences) => NotificationPreferences) => {
      const current = latestPrefs.current
      if (!current) return
      const next = update(current)
      latestPrefs.current = next
      setPrefs(next)
      setSaveState('saving')
      // Debounced so rapid toggles become one write; the server enforces the saved values.
      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => persist(next), 400)
    },
    [persist],
  )

  const retrySave = useCallback(() => {
    if (latestPrefs.current) persist(latestPrefs.current)
  }, [persist])

  const toggleFollow = useCallback(
    async (entityType: EntityType, entityId: string, on: boolean) => {
      setFollows(await persistFollow(userId, { entity_type: entityType, entity_id: entityId }, on, follows))
    },
    [userId, follows],
  )

  // Device registration: silent on start-up (never prompts), re-run when the user signs in.
  const register = useCallback(
    async (prompt: boolean) => {
      const result = await registerForPush({
        platform: expoPushPlatform,
        backend: supabasePushBackend,
        store: storage,
        prompt,
        signedIn: !!userId,
        deviceInfo: deviceInfo(),
      })
      setRegistration(result)
      setPermission(await getPermission())
      return result
    },
    [userId],
  )

  useEffect(() => {
    void releasePendingToken({ backend: supabasePushBackend, store: storage })
    void register(false)
    if (!isNativePlatform) return
    // Tokens can rotate (reinstall, OS restore); keep the server copy current.
    const sub = Notifications.addPushTokenListener(() => void register(false))
    return () => sub.remove()
  }, [register])

  // Timezone: report the device zone to the server and flag changes rather than switching silently.
  const prefsLoaded = prefs !== null
  const timezoneMode = prefs?.timezoneMode
  useEffect(() => {
    if (!prefsLoaded || !timezoneMode) return
    void (async () => {
      const last = await storage.get(LAST_DEVICE_TZ)
      const change = detectTimezoneChange({ mode: timezoneMode, lastKnownDeviceTimezone: last, currentDeviceTimezone: deviceTz })
      if (change.changed && change.affectsDisplay) setTimezoneNotice({ from: change.from, to: change.to })
      await storage.set(LAST_DEVICE_TZ, deviceTz)
      await reportDeviceTimezone(userId, deviceTz).catch(() => {})
    })()
  }, [deviceTz, userId, prefsLoaded, timezoneMode])

  const reminderMode = reminderDeliveryMode({ registration, permission, pushEnabled: prefs?.pushEnabled ?? true })
  const timeZone = resolveEffectiveTimezone({ mode: prefs?.timezoneMode ?? 'device', preferredTimezone: prefs?.preferredTimezone, deviceTimezone: deviceTz }).timeZone

  const resyncReminders = useCallback(async () => {
    if (!isNativePlatform || !prefs) return
    let sessions: ReminderSession[] = []
    if (reminderMode === 'local') {
      const followed = new Set(follows.filter((f) => f.entity_type === 'championship').map((f) => f.entity_id))
      const rows = await upcomingSessions({ limit: 200 }).catch(() => [])
      sessions = rows
        .filter((r) => followed.has(r.events.championship_id))
        .map((r) => ({
          id: r.id,
          eventId: r.event_id,
          sessionType: r.session_type,
          startsAt: r.starts_at,
          timeStatus: r.time_status,
          status: r.status,
          name: r.name,
          eventName: r.events.name,
        }))
    }
    await syncLocalReminders({ scheduler: expoLocalScheduler, sessions, prefs, timeZone, now: new Date(), enabled: reminderMode === 'local' }).catch(() => {})
  }, [prefs, follows, reminderMode, timeZone])

  useEffect(() => {
    void resyncReminders()
  }, [resyncReminders])

  // A "schedule changed" push asks the app to re-check local reminders straight away.
  useEffect(() => {
    if (!isNativePlatform) return
    const sub = Notifications.addNotificationReceivedListener((n) => {
      if ((n.request.content.data as Record<string, unknown> | undefined)?.reconcileReminders) void resyncReminders()
    })
    return () => sub.remove()
  }, [resyncReminders])

  const value: NotificationsState = {
    repo,
    mode: backendConfigured ? 'server' : 'demo',
    unreadCount,
    refreshUnread,
    prefs,
    prefsError,
    saveState,
    updatePrefs,
    retrySave,
    follows,
    toggleFollow,
    permission,
    registration,
    enableDevicePush: () => register(true),
    reminderMode,
    timeZone,
    deviceTimeZone: deviceTz,
    timezoneNotice,
    dismissTimezoneNotice: () => setTimezoneNotice(null),
    resyncReminders,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useNotifications(): NotificationsState {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useNotifications outside NotificationsProvider')
  return ctx
}
