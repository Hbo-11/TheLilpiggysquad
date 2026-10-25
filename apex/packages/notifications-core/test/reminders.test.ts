import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  dedupeKeys,
  limitLocalReminders,
  planSessionReminders,
  reconcileLocalReminders,
  recommendedPreferences,
  type NotificationPreferences,
  type SessionForReminders,
} from '../src/index.ts'

const quali: SessionForReminders = {
  id: 'sess-quali',
  eventId: 'evt-1',
  sessionType: 'qualifying',
  startsAt: '2026-07-04T14:00:00.000Z',
  timeStatus: 'confirmed',
  status: 'scheduled',
}

function prefs(over: Partial<NotificationPreferences> = {}): NotificationPreferences {
  return { ...recommendedPreferences(), ...over }
}

const NOW = new Date('2026-07-01T12:00:00Z')

test('plans one reminder per selected offset, latest-first ordering by offset', () => {
  const plan = planSessionReminders({ session: quali, prefs: prefs({ reminderOffsets: [1440, 60, 15] }), now: NOW })
  assert.deepEqual(
    plan.reminders.map((r) => [r.offsetMinutes, r.fireAt.toISOString()]),
    [
      [1440, '2026-07-03T14:00:00.000Z'],
      [60, '2026-07-04T13:00:00.000Z'],
      [15, '2026-07-04T13:45:00.000Z'],
    ],
  )
  assert.equal(new Set(plan.reminders.map((r) => r.dedupeKey)).size, 3)
})

test('never plans two reminders for the same moment', () => {
  // Duplicate offsets in stored settings collapse to one reminder.
  const plan = planSessionReminders({
    session: quali,
    prefs: prefs({ reminderOffsets: [15, 15, 15] as NotificationPreferences['reminderOffsets'] }),
    now: NOW,
  })
  assert.equal(plan.reminders.length, 1)
  assert.equal(plan.reminders[0].offsetMinutes, 15)
})

test('dedupe keys are stable across runs so retries are idempotent', () => {
  const a = planSessionReminders({ session: quali, prefs: prefs({ reminderOffsets: [30] }), now: NOW })
  const b = planSessionReminders({ session: quali, prefs: prefs({ reminderOffsets: [30] }), now: new Date('2026-07-02T00:00:00Z') })
  assert.equal(a.reminders[0].dedupeKey, b.reminders[0].dedupeKey)
})

test('a rescheduled session produces new reminders and the old ones are cancelled', () => {
  const before = planSessionReminders({ session: quali, prefs: prefs({ reminderOffsets: [60, 15] }), now: NOW }).reminders
  const moved = { ...quali, startsAt: '2026-07-04T16:30:00.000Z' }
  const after = planSessionReminders({ session: moved, prefs: prefs({ reminderOffsets: [60, 15] }), now: NOW }).reminders
  const existing = before.map((r, i) => ({ identifier: `os-${i}`, dedupeKey: r.dedupeKey }))
  const diff = reconcileLocalReminders(after, existing)
  assert.deepEqual(diff.toCancel, ['os-0', 'os-1'])
  assert.deepEqual(
    diff.toSchedule.map((r) => r.fireAt.toISOString()),
    ['2026-07-04T15:30:00.000Z', '2026-07-04T16:15:00.000Z'],
  )
})

test('cancelled and postponed sessions get no reminders; existing ones are cancelled', () => {
  for (const status of ['cancelled', 'postponed'] as const) {
    const plan = planSessionReminders({ session: { ...quali, status }, prefs: prefs(), now: NOW })
    assert.equal(plan.reminders.length, 0)
    assert.equal(plan.skipped[0].reason, 'session_not_scheduled')
  }
  const diff = reconcileLocalReminders([], [{ identifier: 'os-1', dedupeKey: 'reminder:sess-quali:x:30' }])
  assert.deepEqual(diff.toCancel, ['os-1'])
})

test('unverified session times never trigger reminders', () => {
  for (const timeStatus of ['provisional', 'tbc'] as const) {
    const plan = planSessionReminders({ session: { ...quali, timeStatus }, prefs: prefs(), now: NOW })
    assert.equal(plan.reminders.length, 0)
    assert.equal(plan.skipped[0].reason, 'time_unverified')
  }
  const plan = planSessionReminders({ session: { ...quali, startsAt: null }, prefs: prefs(), now: NOW })
  assert.equal(plan.skipped[0].reason, 'no_start_time')
})

test('respects disabled session types and the reminders category', () => {
  const practice = { ...quali, sessionType: 'practice' as const }
  assert.equal(planSessionReminders({ session: practice, prefs: prefs(), now: NOW }).skipped[0].reason, 'session_type_disabled')
  const off = prefs()
  off.categories = { ...off.categories, race_reminders: false }
  assert.equal(planSessionReminders({ session: quali, prefs: off, now: NOW }).skipped[0].reason, 'reminders_disabled')
})

test('drops reminders whose time has passed, keeping later ones', () => {
  const now = new Date('2026-07-04T13:20:00Z') // 40 minutes before qualifying
  const plan = planSessionReminders({ session: quali, prefs: prefs({ reminderOffsets: [1440, 60, 30, 15, 0] }), now })
  assert.deepEqual(plan.reminders.map((r) => r.offsetMinutes), [30, 15, 0])
  assert.deepEqual(plan.skipped.map((s) => s.offsetMinutes), [1440, 60])
})

test('reminders stay correct across a DST change between scheduling and the session', () => {
  // Scheduled on 24 Oct (BST), session on 25 Oct after clocks go back to GMT.
  const session = { ...quali, startsAt: '2026-10-25T14:00:00.000Z' } // 14:00 GMT
  const plan = planSessionReminders({ session, prefs: prefs({ reminderOffsets: [1440] }), now: new Date('2026-10-20T00:00:00Z') })
  // 24 hours before is an absolute 24h, i.e. 15:00 BST on the 24th.
  assert.equal(plan.reminders[0].fireAt.toISOString(), '2026-10-24T14:00:00.000Z')
})

test('reconcile keeps matching reminders and removes duplicates already on the device', () => {
  const desired = planSessionReminders({ session: quali, prefs: prefs({ reminderOffsets: [30] }), now: NOW }).reminders
  const key = desired[0].dedupeKey
  const diff = reconcileLocalReminders(desired, [
    { identifier: 'a', dedupeKey: key },
    { identifier: 'b', dedupeKey: key },
    { identifier: 'c', dedupeKey: null },
  ])
  assert.deepEqual(diff, { toCancel: ['b', 'c'], toSchedule: [], unchanged: 1 })
})

test('limits local reminders to the soonest ones (iOS caps pending notifications)', () => {
  const many = Array.from({ length: 80 }, (_, i) =>
    planSessionReminders({
      session: { ...quali, id: `s${i}`, startsAt: new Date(Date.UTC(2026, 7, 1) + i * 86_400_000).toISOString() },
      prefs: prefs({ reminderOffsets: [30] }),
      now: NOW,
    }).reminders[0],
  )
  const limited = limitLocalReminders(many.reverse())
  assert.equal(limited.length, 60)
  assert.equal(limited[0].sessionId, 's0')
})

test('dedupe keys never collide for different ids', () => {
  assert.notEqual(dedupeKeys.article('src', 'a b'), dedupeKeys.article('src', 'a_b'))
  assert.notEqual(dedupeKeys.article('src', 'x'.repeat(100) + '1'), dedupeKeys.article('src', 'x'.repeat(100) + '2'))
  assert.notEqual(dedupeKeys.article('a:b', 'c'), dedupeKeys.article('a', 'b:c'))
  assert.equal(dedupeKeys.article('src', 'plain-id_1'), 'article:src:plain-id_1')
  assert.ok(dedupeKeys.article('s'.repeat(40), 'r'.repeat(100)).length <= 200)
})
