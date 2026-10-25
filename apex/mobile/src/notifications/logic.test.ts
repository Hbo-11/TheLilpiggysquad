// Device-independent tests for the mobile notification logic: permission handling,
// push registration, logout cleanup, local reminders and the demo repository.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recommendedPreferences, resolveNotificationPath } from '@apex/notifications-core'
import {
  PENDING_RELEASE_KEY,
  TOKEN_KEY,
  describeRegistration,
  registerForPush,
  releasePendingToken,
  reminderDeliveryMode,
  signOutWithCleanup,
  type KeyValueStore,
  type PermissionSnapshot,
  type PushBackend,
  type PushPlatform,
} from './registration.ts'
import { LOCAL_REMINDER_TYPE, syncLocalReminders, type LocalScheduler, type ScheduledLocal } from './localReminders.ts'
import { DemoNotificationRepository, describePushNote } from './repository.ts'

function memoryStore(init: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init))
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => void (v === null ? data.delete(k) : data.set(k, v)),
  }
}

function platform(over: Partial<PushPlatform> & { permission?: PermissionSnapshot; afterRequest?: PermissionSnapshot } = {}) {
  const calls: string[] = []
  const p: PushPlatform = {
    os: 'ios',
    isPhysicalDevice: true,
    projectId: 'proj-1',
    getPermission: async () => (calls.push('getPermission'), over.permission ?? { status: 'undetermined', canAskAgain: true }),
    requestPermission: async () => (calls.push('requestPermission'), over.afterRequest ?? { status: 'granted', canAskAgain: true }),
    getExpoPushToken: async () => (calls.push('getToken'), 'ExponentPushToken[abcdefgh123]'),
    ensureAndroidChannels: async () => void calls.push('channels'),
    ...over,
  }
  return { p, calls }
}

function backend(fail: Partial<Record<'register' | 'unregister' | 'release', boolean>> = {}) {
  const calls: string[] = []
  const b: PushBackend = {
    register: async (t) => {
      calls.push(`register:${t}`)
      if (fail.register) throw new Error('offline')
    },
    unregister: async (t) => {
      calls.push(`unregister:${t}`)
      if (fail.unregister) throw new Error('offline')
    },
    release: async (t) => {
      calls.push(`release:${t}`)
      if (fail.release) throw new Error('offline')
    },
  }
  return { b, calls }
}

const info = { platform: 'ios' as const, deviceName: 'Phone', appVersion: '1.0', timezone: 'Europe/London' }

test('never prompts for permission on start-up without the user opting in', async () => {
  const { p, calls } = platform()
  const r = await registerForPush({ platform: p, backend: backend().b, store: memoryStore(), prompt: false, signedIn: true, deviceInfo: info })
  assert.deepEqual(r, { state: 'permission_not_requested' })
  assert.ok(!calls.includes('requestPermission'))
})

test('permission denial is handled and the app is told whether it can ask again', async () => {
  const { p, calls } = platform({ afterRequest: { status: 'denied', canAskAgain: false } })
  const r = await registerForPush({ platform: p, backend: backend().b, store: memoryStore(), prompt: true, signedIn: true, deviceInfo: info })
  assert.deepEqual(r, { state: 'permission_denied', canAskAgain: false })
  assert.ok(!calls.includes('getToken'), 'no token requested after denial')
  const blocked = platform({ permission: { status: 'denied', canAskAgain: false } })
  const r2 = await registerForPush({ platform: blocked.p, backend: backend().b, store: memoryStore(), prompt: true, signedIn: true, deviceInfo: info })
  assert.deepEqual(r2, { state: 'permission_denied', canAskAgain: false })
  assert.ok(!blocked.calls.includes('requestPermission'), 'does not re-prompt when the OS will not show the dialog')
  const d = describeRegistration(r2, { status: 'denied', canAskAgain: false })
  assert.equal(d.needsSettings, true)
  assert.match(d.detail, /still use the notification centre/)
})

test('registers the token with the backend once permission is granted', async () => {
  const { p } = platform({ permission: { status: 'granted', canAskAgain: true } })
  const be = backend()
  const store = memoryStore()
  const r = await registerForPush({ platform: p, backend: be.b, store, prompt: false, signedIn: true, deviceInfo: info })
  assert.deepEqual(r, { state: 'registered', token: 'ExponentPushToken[abcdefgh123]' })
  assert.deepEqual(be.calls, ['register:ExponentPushToken[abcdefgh123]'])
  assert.equal(store.data.get(TOKEN_KEY), 'ExponentPushToken[abcdefgh123]')
})

test('a rotated token replaces the old one on the server', async () => {
  const { p } = platform({ permission: { status: 'granted', canAskAgain: true } })
  const be = backend()
  const store = memoryStore({ [TOKEN_KEY]: 'ExponentPushToken[oldtoken000]' })
  await registerForPush({ platform: p, backend: be.b, store, prompt: false, signedIn: true, deviceInfo: info })
  assert.deepEqual(be.calls, ['register:ExponentPushToken[abcdefgh123]', 'release:ExponentPushToken[oldtoken000]'])
})

test('reports missing configuration instead of pretending push works', async () => {
  const granted = { permission: { status: 'granted', canAskAgain: true } as PermissionSnapshot }
  assert.deepEqual(
    await registerForPush({ platform: platform(granted).p, backend: null, store: memoryStore(), prompt: false, signedIn: true, deviceInfo: info }),
    { state: 'not_configured', reason: 'no_backend' },
  )
  assert.deepEqual(
    await registerForPush({ platform: platform(granted).p, backend: backend().b, store: memoryStore(), prompt: false, signedIn: false, deviceInfo: info }),
    { state: 'not_configured', reason: 'signed_out' },
  )
  assert.deepEqual(
    await registerForPush({ platform: platform({ ...granted, projectId: null }).p, backend: backend().b, store: memoryStore(), prompt: false, signedIn: true, deviceInfo: info }),
    { state: 'not_configured', reason: 'missing_project_id' },
  )
  assert.deepEqual(
    await registerForPush({ platform: platform({ isPhysicalDevice: false }).p, backend: backend().b, store: memoryStore(), prompt: true, signedIn: true, deviceInfo: info }),
    { state: 'simulator' },
  )
  assert.deepEqual(
    await registerForPush({ platform: platform({ os: 'web' }).p, backend: backend().b, store: memoryStore(), prompt: true, signedIn: true, deviceInfo: info }),
    { state: 'unsupported_platform' },
  )
  const failing = await registerForPush({ platform: platform(granted).p, backend: backend({ register: true }).b, store: memoryStore(), prompt: false, signedIn: true, deviceInfo: info })
  assert.equal(failing.state, 'error')
})

test('android creates notification channels before asking for permission', async () => {
  const { p, calls } = platform({ os: 'android' })
  await registerForPush({ platform: p, backend: backend().b, store: memoryStore(), prompt: true, signedIn: true, deviceInfo: { ...info, platform: 'android' } })
  assert.ok(calls.indexOf('channels') < calls.indexOf('requestPermission'))
})

test('logout unregisters the token before signing out, then clears local reminders', async () => {
  const order: string[] = []
  const be = backend()
  const store = memoryStore({ [TOKEN_KEY]: 'ExponentPushToken[abcdefgh123]' })
  const r = await signOutWithCleanup({
    backend: { ...be.b, unregister: async (t) => (order.push('unregister'), be.b.unregister(t)) },
    store,
    cancelLocalReminders: async () => void order.push('cancelLocal'),
    signOut: async () => void order.push('signOut'),
  })
  assert.deepEqual(order, ['unregister', 'cancelLocal', 'signOut'])
  assert.deepEqual(r, { unregistered: true, pendingRelease: false })
  assert.equal(store.data.has(TOKEN_KEY), false)
})

test('offline logout still signs out and releases the token on next launch', async () => {
  const store = memoryStore({ [TOKEN_KEY]: 'ExponentPushToken[abcdefgh123]' })
  const r = await signOutWithCleanup({ backend: backend({ unregister: true }).b, store, cancelLocalReminders: async () => {}, signOut: async () => {} })
  assert.deepEqual(r, { unregistered: false, pendingRelease: true })
  assert.equal(store.data.get(PENDING_RELEASE_KEY), 'ExponentPushToken[abcdefgh123]')
  const be = backend()
  assert.equal(await releasePendingToken({ backend: be.b, store }), true)
  assert.deepEqual(be.calls, ['release:ExponentPushToken[abcdefgh123]'])
  assert.equal(store.data.has(PENDING_RELEASE_KEY), false)
})

test('reminders are delivered by exactly one mechanism', () => {
  const granted: PermissionSnapshot = { status: 'granted', canAskAgain: true }
  assert.equal(reminderDeliveryMode({ registration: { state: 'registered', token: 't' }, permission: granted, pushEnabled: true }), 'server')
  assert.equal(reminderDeliveryMode({ registration: { state: 'not_configured', reason: 'no_backend' }, permission: granted, pushEnabled: true }), 'local')
  assert.equal(reminderDeliveryMode({ registration: { state: 'permission_denied', canAskAgain: false }, permission: { status: 'denied', canAskAgain: false }, pushEnabled: true }), 'none')
  assert.equal(reminderDeliveryMode({ registration: { state: 'registered', token: 't' }, permission: granted, pushEnabled: false }), 'none')
})

function fakeScheduler() {
  const scheduled = new Map<string, ScheduledLocal & { fireAt: Date; title: string }>()
  const s: LocalScheduler = {
    list: async () => [...scheduled.values()],
    cancel: async (id) => void scheduled.delete(id),
    schedule: async (n) => void scheduled.set(n.identifier, { identifier: n.identifier, data: n.data, fireAt: n.fireAt, title: n.title }),
  }
  return { s, scheduled }
}

const session = {
  id: 's1',
  eventId: 'e1',
  sessionType: 'qualifying' as const,
  startsAt: '2026-07-04T14:00:00.000Z',
  timeStatus: 'confirmed' as const,
  status: 'scheduled' as const,
  name: 'Qualifying',
  eventName: 'British Grand Prix',
}

test('local reminders: scheduled once, moved when rescheduled, removed when cancelled or server takes over', async () => {
  const { s, scheduled } = fakeScheduler()
  const prefs = { ...recommendedPreferences(), reminderOffsets: [60, 15] as (60 | 15)[] }
  const base = { scheduler: s, prefs, timeZone: 'Europe/London', now: new Date('2026-07-01T00:00:00Z'), enabled: true }
  assert.deepEqual(await syncLocalReminders({ ...base, sessions: [session] }), { scheduled: 2, cancelled: 0, kept: 0 })
  assert.deepEqual(await syncLocalReminders({ ...base, sessions: [session] }), { scheduled: 0, cancelled: 0, kept: 2 }, 'idempotent')
  const first = [...scheduled.values()][0]
  assert.equal(first.data?.type, LOCAL_REMINDER_TYPE)
  assert.equal(first.title, 'Qualifying starts in 1 hour')
  assert.equal(resolveNotificationPath(first.data).path, '/events/e1')

  const moved = { ...session, startsAt: '2026-07-04T16:00:00.000Z' }
  assert.deepEqual(await syncLocalReminders({ ...base, sessions: [moved] }), { scheduled: 2, cancelled: 2, kept: 0 })
  assert.deepEqual([...scheduled.values()].map((n) => n.fireAt.toISOString()).sort(), ['2026-07-04T15:00:00.000Z', '2026-07-04T15:45:00.000Z'])

  await syncLocalReminders({ ...base, sessions: [{ ...moved, status: 'cancelled' }] })
  assert.equal(scheduled.size, 0)

  await syncLocalReminders({ ...base, sessions: [session] })
  await syncLocalReminders({ ...base, sessions: [session], enabled: false })
  assert.equal(scheduled.size, 0, 'switching to server delivery removes local reminders')
})

test('local reminders leave unrelated scheduled notifications alone', async () => {
  const { s, scheduled } = fakeScheduler()
  scheduled.set('other', { identifier: 'other', data: { type: 'something_else' }, fireAt: new Date(), title: 'x' })
  await syncLocalReminders({ scheduler: s, sessions: [], prefs: recommendedPreferences(), timeZone: 'UTC', now: new Date('2026-07-01T00:00:00Z'), enabled: true })
  assert.ok(scheduled.has('other'))
})

test('demo repository: labelled samples with working read, unread, archive and pagination', async () => {
  const store = memoryStore()
  const repo = new DemoNotificationRepository(store, () => new Date('2026-07-01T12:00:00Z'))
  const page1 = await repo.list({ filter: 'all', cursor: null, limit: 3 })
  assert.equal(page1.items.length, 3)
  assert.ok(page1.items.every((n) => n.isDemo && n.title.startsWith('Sample:')))
  const page2 = await repo.list({ filter: 'all', cursor: page1.nextCursor, limit: 3 })
  assert.equal(page2.items.length, 2)
  assert.equal(page2.nextCursor, null)
  assert.equal(await repo.unreadCount(), 3)
  await repo.markRead(page1.items[0].id)
  assert.equal(await repo.unreadCount(), 2)
  assert.equal((await repo.list({ filter: 'unread', cursor: null, limit: 10 })).items.length, 2)
  assert.equal((await repo.list({ filter: 'race', cursor: null, limit: 10 })).items.length, 2)
  await repo.markAllRead()
  assert.equal(await repo.unreadCount(), 0)
  await repo.archive('demo-1')
  assert.equal((await repo.list({ filter: 'all', cursor: null, limit: 10 })).items.length, 4)
  // Persisted across app restarts.
  const again = new DemoNotificationRepository(store)
  assert.equal((await again.list({ filter: 'all', cursor: null, limit: 10 })).items.length, 4)
  assert.equal(await again.clearSamples(), 4)
  assert.equal(await again.seedSamples(), 5)
  assert.equal(describePushNote(page1.items[0]), 'Sample – not sent to your device')
})
