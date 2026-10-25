import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  OPTIONAL_CATEGORIES,
  appEventText,
  buildDeepLinkPath,
  disableAllOptionalNotifications,
  enableAllNotifications,
  isCategoryEnabled,
  isSafeExternalUrl,
  normalizePreferences,
  parseDeepLink,
  preferencesFromRow,
  preferencesToRow,
  recommendedPreferences,
  resolveNotificationPath,
  scheduleChangeText,
  securityText,
  sessionReminderText,
  truncate,
  TITLE_MAX,
  BODY_MAX,
} from '../src/index.ts'

test('global controls', () => {
  const all = enableAllNotifications(recommendedPreferences())
  assert.ok(OPTIONAL_CATEGORIES.every((c) => all.categories[c]))
  assert.ok(Object.values(all.reminderSessionTypes).every(Boolean))
  const none = disableAllOptionalNotifications(all)
  assert.ok(OPTIONAL_CATEGORIES.every((c) => !none.categories[c]))
  assert.equal(isCategoryEnabled(none, 'account_security'), true, 'security is not optional')
  assert.deepEqual(none.reminderOffsets, all.reminderOffsets, 'timings are kept')
})

test('normalises untrusted preference input and reports problems', () => {
  const { preferences, errors } = normalizePreferences({
    categories: { race_results: false, account_security: false, bogus: true, news_major: 'yes' },
    reminderOffsets: [15, 60, 15],
    reminderSessionTypes: { practice: true },
    timezoneMode: 'preferred',
    preferredTimezone: 'Not/AZone',
    quietHours: { enabled: true, start: '22:00', end: '22:00' },
  })
  assert.equal(preferences.categories.race_results, false)
  assert.equal(isCategoryEnabled(preferences, 'account_security'), true)
  assert.deepEqual(preferences.reminderOffsets, [60, 15])
  assert.equal(preferences.reminderSessionTypes.practice, true)
  assert.equal(preferences.timezoneMode, 'device', 'invalid preferred timezone falls back to device time')
  assert.equal(preferences.quietHours.enabled, false)
  assert.equal(errors.length, 5, errors.join('\n'))
  assert.deepEqual(normalizePreferences({ reminderOffsets: [45] }).preferences.reminderOffsets, [30])
})

test('round-trips through the database row shape', () => {
  const p = enableAllNotifications(recommendedPreferences())
  p.quietHours = { enabled: true, start: '22:30', end: '06:45', reminderPolicy: 'deliver' }
  p.timezoneMode = 'preferred'
  p.preferredTimezone = 'America/Indiana/Indianapolis'
  const row = preferencesToRow(p)
  const back = preferencesFromRow({ ...row, quiet_hours_start: '22:30:00', quiet_hours_end: '06:45:00' })
  assert.deepEqual(back.errors, [])
  assert.deepEqual(back.preferences, p)
  assert.deepEqual(preferencesFromRow(null).preferences, recommendedPreferences())
})

test('deep links: only allow-listed internal destinations', () => {
  assert.deepEqual(parseDeepLink('/events/evt_123'), { screen: 'event', id: 'evt_123' })
  assert.deepEqual(parseDeepLink('apexai://drivers/9a1b'), { screen: 'driver', id: '9a1b' })
  assert.deepEqual(parseDeepLink('apexai:///track-lab/projects/p1/'), { screen: 'track_project', id: 'p1' })
  assert.deepEqual(parseDeepLink('/settings/notifications'), { screen: 'notification_settings' })
  for (const bad of [
    'https://evil.example/events/1',
    '//evil.example/events/1',
    'javascript:alert(1)',
    '/events/../admin',
    '/events/a%2F..%2Fb',
    '/events/1?redirect=https://x',
    '/admin',
    '/events/' + 'x'.repeat(65),
    'otherapp://events/1',
    42,
    null,
  ]) {
    assert.equal(parseDeepLink(bad), null, String(bad))
  }
  assert.equal(buildDeepLinkPath({ screen: 'ai_analysis', id: 'an-1' }), '/ai/analyses/an-1')
  assert.throws(() => buildDeepLinkPath({ screen: 'event', id: '../x' }))
})

test('opening a notification goes to its screen, or the notification centre, never Home', () => {
  assert.deepEqual(resolveNotificationPath({ url: '/events/e1' }), { path: '/events/e1', valid: true })
  assert.deepEqual(resolveNotificationPath({ url: 'https://phish.example' }), { path: '/notifications', valid: false })
  assert.deepEqual(resolveNotificationPath(undefined), { path: '/notifications', valid: false })
})

test('external source links must be https', () => {
  assert.equal(isSafeExternalUrl('https://www.fia.com/news/x'), true)
  assert.equal(isSafeExternalUrl('http://www.fia.com/news/x'), false)
  assert.equal(isSafeExternalUrl('https://user:pw@example.com/'), false)
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false)
})

test('copy is concise, names the timezone and is lock-screen safe', () => {
  const text = sessionReminderText({
    sessionName: 'Qualifying',
    sessionType: 'qualifying',
    eventName: 'British Grand Prix',
    startsAt: new Date('2026-07-04T14:00:00Z'),
    timeZone: 'Europe/London',
    offsetMinutes: 30,
  })
  assert.equal(text.title, 'Qualifying starts in 30 minutes')
  assert.equal(text.body, 'British Grand Prix • Sat 4 Jul, 15:00 BST • Open event schedule')
  const moved = scheduleChangeText({
    sessionName: 'Race',
    sessionType: 'race',
    eventName: 'Belgian Grand Prix',
    timeZone: 'Europe/Brussels',
    change: 'rescheduled',
    previousStartsAt: new Date('2026-07-19T13:00:00Z'),
    startsAt: new Date('2026-07-19T15:00:00Z'),
  })
  assert.equal(moved.title, 'Race rescheduled')
  assert.match(moved.body, /now Sun 19 Jul, 17:00 CEST \(was Sun 19 Jul, 15:00 CEST\)/)
  assert.equal(appEventText('track_design_ready').title, 'Your circuit design is ready')
  const sec = securityText('password_changed')
  assert.doesNotMatch(sec.title + sec.body, /@|token|password:/i)
  assert.equal(truncate('x'.repeat(300), BODY_MAX).length, BODY_MAX)
  assert.ok(truncate('y'.repeat(100), TITLE_MAX).endsWith('…'))
})
