// Push registration and sign-out cleanup, written against small interfaces so the
// logic is unit-tested without a device. The Expo/Supabase implementations live in
// pushPlatform.ts. Nothing here assumes push works: every failure mode returns a
// state the UI can explain, and the app keeps working without push.

export type PermissionStatus = 'granted' | 'denied' | 'undetermined'

export interface PermissionSnapshot {
  status: PermissionStatus
  canAskAgain: boolean
  /** iOS provisional authorisation (quiet delivery) counts as granted. */
  provisional?: boolean
}

export interface PushPlatform {
  os: string
  isPhysicalDevice: boolean
  projectId: string | null
  getPermission(): Promise<PermissionSnapshot>
  requestPermission(): Promise<PermissionSnapshot>
  getExpoPushToken(projectId: string): Promise<string>
  ensureAndroidChannels(): Promise<void>
}

export interface DeviceInfo {
  platform: 'ios' | 'android'
  deviceName: string | null
  appVersion: string | null
  timezone: string | null
}

export interface PushBackend {
  register(token: string, info: DeviceInfo): Promise<void>
  /** Signed-in removal (binds to the current user). */
  unregister(token: string): Promise<void>
  /** Removal by token possession, used when sign-out happened offline. */
  release(token: string): Promise<void>
}

export interface KeyValueStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string | null): Promise<void>
}

export const TOKEN_KEY = 'apex.push.token'
export const PENDING_RELEASE_KEY = 'apex.push.pendingRelease'

export type RegistrationResult =
  | { state: 'registered'; token: string }
  | { state: 'permission_denied'; canAskAgain: boolean }
  | { state: 'permission_not_requested' }
  | { state: 'unsupported_platform' }
  | { state: 'simulator' }
  | { state: 'not_configured'; reason: 'no_backend' | 'signed_out' | 'missing_project_id' }
  | { state: 'error'; message: string }

export function isGranted(p: PermissionSnapshot): boolean {
  return p.status === 'granted' || p.provisional === true
}

/**
 * Register this device for server push.
 * `prompt` must only be true after the app has explained the benefit (PermissionPrimer)
 * and the user chose to enable notifications. On start-up we call it with prompt=false
 * so users who have not opted in are never asked out of the blue.
 */
export async function registerForPush(input: {
  platform: PushPlatform
  backend: PushBackend | null
  store: KeyValueStore
  prompt: boolean
  signedIn: boolean
  deviceInfo: DeviceInfo | null
}): Promise<RegistrationResult> {
  const { platform, backend, store } = input
  if (platform.os !== 'ios' && platform.os !== 'android') return { state: 'unsupported_platform' }
  if (!platform.isPhysicalDevice) return { state: 'simulator' }

  try {
    // Android 13+: a channel must exist before the permission prompt can appear.
    if (platform.os === 'android') await platform.ensureAndroidChannels()

    let permission = await platform.getPermission()
    if (!isGranted(permission)) {
      if (!input.prompt) return { state: 'permission_not_requested' }
      if (!permission.canAskAgain) return { state: 'permission_denied', canAskAgain: false }
      permission = await platform.requestPermission()
      if (!isGranted(permission)) return { state: 'permission_denied', canAskAgain: permission.canAskAgain }
    }

    if (!backend) return { state: 'not_configured', reason: 'no_backend' }
    if (!input.signedIn) return { state: 'not_configured', reason: 'signed_out' }
    if (!platform.projectId) return { state: 'not_configured', reason: 'missing_project_id' }

    const token = await platform.getExpoPushToken(platform.projectId)
    await backend.register(token, input.deviceInfo ?? { platform: platform.os, deviceName: null, appVersion: null, timezone: null })
    const previous = await store.get(TOKEN_KEY)
    await store.set(TOKEN_KEY, token)
    // If the token rotated, release the old one so it cannot linger on the server.
    if (previous && previous !== token) await backend.release(previous).catch(() => store.set(PENDING_RELEASE_KEY, previous))
    return { state: 'registered', token }
  } catch (err) {
    return { state: 'error', message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Sign out without leaving this device subscribed to the previous account's pushes:
 * 1. unregister the token while still authenticated,
 * 2. cancel locally scheduled reminders,
 * 3. sign out.
 * If step 1 fails (offline), the token is remembered and released on next launch.
 */
export async function signOutWithCleanup(input: {
  backend: PushBackend | null
  store: KeyValueStore
  cancelLocalReminders: () => Promise<void>
  signOut: () => Promise<void>
}): Promise<{ unregistered: boolean; pendingRelease: boolean }> {
  const token = await input.store.get(TOKEN_KEY)
  let unregistered = false
  let pendingRelease = false
  if (token && input.backend) {
    try {
      await input.backend.unregister(token)
      unregistered = true
    } catch {
      await input.store.set(PENDING_RELEASE_KEY, token)
      pendingRelease = true
    }
  }
  await input.store.set(TOKEN_KEY, null)
  await input.cancelLocalReminders().catch(() => {})
  await input.signOut()
  return { unregistered, pendingRelease }
}

/** Retry a release that could not complete at sign-out. Call on app start. */
export async function releasePendingToken(input: { backend: PushBackend | null; store: KeyValueStore }): Promise<boolean> {
  const pending = await input.store.get(PENDING_RELEASE_KEY)
  if (!pending || !input.backend) return false
  try {
    await input.backend.release(pending)
    await input.store.set(PENDING_RELEASE_KEY, null)
    return true
  } catch {
    return false
  }
}

/**
 * Who delivers session reminders to this device:
 * server: the backend (handles reschedules and cancellations centrally),
 * local: the device scheduler, from verified event data already in the app,
 * none: notifications are not permitted; reminders appear in the app only.
 * Never both, so the same reminder is not shown twice.
 */
export function reminderDeliveryMode(input: { registration: RegistrationResult | null; permission: PermissionSnapshot | null; pushEnabled: boolean }): 'server' | 'local' | 'none' {
  if (!input.pushEnabled) return 'none'
  if (input.registration?.state === 'registered') return 'server'
  if (input.permission && isGranted(input.permission)) return 'local'
  return 'none'
}

export interface PermissionDescription {
  label: string
  detail: string
  /** Show a button that triggers the (primed) system prompt. */
  canRequest: boolean
  /** The OS will not prompt again; offer a link to system settings. */
  needsSettings: boolean
}

export function describeRegistration(r: RegistrationResult | null, permission: PermissionSnapshot | null): PermissionDescription {
  if (r?.state === 'unsupported_platform') {
    return { label: 'Not available here', detail: 'Device notifications need the iOS or Android app.', canRequest: false, needsSettings: false }
  }
  if (r?.state === 'simulator') {
    return { label: 'Not available on simulators', detail: 'Push notifications need a physical device running a development or store build.', canRequest: false, needsSettings: false }
  }
  if (permission && isGranted(permission)) {
    return { label: permission.provisional ? 'Allowed (delivered quietly)' : 'Allowed', detail: 'This device can show Apex AI notifications.', canRequest: false, needsSettings: false }
  }
  if (permission?.status === 'denied' && !permission.canAskAgain) {
    return {
      label: 'Turned off in system settings',
      detail: 'You can still use the notification centre in the app. To get alerts on this device, allow notifications for Apex AI in system settings.',
      canRequest: false,
      needsSettings: true,
    }
  }
  return {
    label: 'Not enabled yet',
    detail: 'Turn on device notifications to get reminders and alerts when the app is closed.',
    canRequest: true,
    needsSettings: false,
  }
}
