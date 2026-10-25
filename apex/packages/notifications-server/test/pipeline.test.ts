// End-to-end pipeline against a real database: verified ingest -> jobs/reminders
// -> preferences/quiet hours/rate limits/dedupe -> deliveries -> Expo -> receipts.

import { after, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { RATE_LIMITS, dedupeKeys } from '@apex/notifications-core'
import {
  checkReceipts,
  dispatchDeliveries,
  fanOut,
  ingestUpdate,
  processJobs,
  queueAppEvent,
  scanReminders,
  sendTestNotification,
} from '../src/index.ts'
import { SOURCE, asUser, connect, createUser, fakeExpo, resetData, setupOfficialSource, skipNoDb, token } from './helpers.ts'

const QUALI_START = new Date('2026-07-04T14:00:00Z') // 15:00 BST at Silverstone
const at = (iso: string) => new Date(iso)
const minutesBefore = (d: Date, m: number) => new Date(d.getTime() - m * 60_000)

describe('notification pipeline', { skip: skipNoDb }, () => {
  const sql = skipNoDb ? (null as never) : connect()
  after(async () => sql?.end())

  let fan: string // follows the championship
  let driverFan: string // follows a driver in the event
  let stranger: string // follows nothing
  let muted: string // follows the championship but turned reminders off

  async function ingest(payload: Record<string, unknown>, now = at('2026-07-01T10:00:00Z'), sourceId = SOURCE) {
    return ingestUpdate(sql, { sourceId, payload, now })
  }

  async function seedWeekend() {
    await setupOfficialSource(sql)
    const ev = await ingest({
      kind: 'event.upsert',
      externalRef: 'gbr-2026',
      championshipId: 'f1',
      name: 'British Grand Prix',
      circuitName: 'Silverstone',
      country: 'United Kingdom',
      timezone: 'Europe/London',
      status: 'scheduled',
      entries: [{ driverRef: 'drv-44', driverName: 'Test Driver', teamRef: 'team-1', teamName: 'Test Team' }],
    })
    assert.equal(ev.outcome, 'applied', JSON.stringify(ev))
    const q = await ingest({
      kind: 'session.upsert',
      externalRef: 'gbr-2026-q',
      eventExternalRef: 'gbr-2026',
      sessionType: 'qualifying',
      name: 'Qualifying',
      localStart: '2026-07-04T15:00',
      timezone: 'Europe/London',
      timeStatus: 'confirmed',
    })
    assert.equal(q.outcome, 'applied', JSON.stringify(q))
    const [session] = await sql<{ id: string; event_id: string; starts_at: Date }[]>`select id, event_id, starts_at from public.event_sessions where external_ref = 'gbr-2026-q'`
    assert.equal(session.starts_at.toISOString(), QUALI_START.toISOString())
    return session
  }

  beforeEach(async () => {
    await resetData(sql)
    fan = await createUser(sql, 'fan@example.com')
    driverFan = await createUser(sql, 'driverfan@example.com')
    stranger = await createUser(sql, 'stranger@example.com')
    muted = await createUser(sql, 'muted@example.com')
    await sql`insert into public.user_follows (user_id, entity_type, entity_id) values (${fan}, 'championship', 'f1'), (${muted}, 'championship', 'f1')`
    await sql`update public.notification_preferences set categories = categories || '{"race_reminders": false}' where user_id = ${muted}`
    for (const [i, u] of [fan, driverFan, stranger, muted].entries()) {
      await asUser(sql, u, (tx) => tx`select public.register_push_device(${token(i + 1)}, 'ios', null, '1.0.0', 'Europe/London')`)
    }
  })

  async function followDriver(userId: string) {
    const [d] = await sql`select id from public.drivers where external_ref = 'drv-44'`
    await sql`insert into public.user_follows (user_id, entity_type, entity_id) values (${userId}, 'driver', ${d.id})`
  }

  async function notificationsFor(userId: string) {
    return sql`select * from public.notifications where user_id = ${userId} and archived_at is null order by created_at`
  }

  test('session reminders reach followers once, at the right time, honouring preferences', async () => {
    const session = await seedWeekend()
    await followDriver(driverFan)
    // Overlapping follows: the fan also follows the driver and saved the event.
    await followDriver(fan)
    await sql`insert into public.saved_events (user_id, event_id) values (${fan}, ${session.event_id})`

    // Scan up to 31 minutes before: nothing due yet.
    let r = await scanReminders(sql, { now: minutesBefore(QUALI_START, 31) })
    assert.equal(r.created, 0)
    // The 30-minute reminder becomes due.
    r = await scanReminders(sql, { now: minutesBefore(QUALI_START, 29) })
    assert.equal(r.created, 2)

    const [n] = await notificationsFor(fan)
    assert.equal(n.title, 'Qualifying starts in 30 minutes')
    assert.equal(n.body, 'British Grand Prix • Sat 4 Jul, 15:00 BST • Open event schedule')
    assert.equal(n.deep_link, `/events/${session.event_id}`)
    assert.equal(n.dedupe_key, dedupeKeys.sessionReminder(session.id, QUALI_START.toISOString(), 30))
    assert.equal((await notificationsFor(fan)).length, 1, 'overlapping follows give one reminder')
    assert.equal((await notificationsFor(driverFan)).length, 1)
    assert.equal((await notificationsFor(stranger)).length, 0)
    assert.equal((await notificationsFor(muted)).length, 0, 'disabled category is enforced server-side')

    // Re-running the same window (retry, overlapping cron) creates nothing new.
    await sql`update public.reminder_scan_state set scanned_until = ${minutesBefore(QUALI_START, 35)}`
    r = await scanReminders(sql, { now: minutesBefore(QUALI_START, 28) })
    assert.equal(r.created, 0)
    assert.equal(r.duplicates, 2)

    // Push delivery, then the receipt.
    const expo = fakeExpo({ receipts: { 'ticket-1': { status: 'ok' }, 'ticket-2': { status: 'ok' } } })
    const d = await dispatchDeliveries(sql, { now: minutesBefore(QUALI_START, 28), transport: { fetch: expo.fetch } })
    assert.equal(d.sent, 2)
    assert.equal(expo.sent[0].channelId, 'race-reminders')
    assert.equal(expo.sent[0].data.url, `/events/${session.event_id}`)
    assert.ok(expo.sent[0].ttl! <= 33 * 60, 'reminder expires around session start')
    assert.equal((await dispatchDeliveries(sql, { now: minutesBefore(QUALI_START, 27), transport: { fetch: expo.fetch } })).sent, 0)
    const receipts = await checkReceipts(sql, { now: new Date(QUALI_START.getTime() + 60 * 60_000), transport: { fetch: expo.fetch } })
    assert.equal(receipts.delivered, 2)
    const [fanNotification] = await notificationsFor(fan)
    assert.equal(fanNotification.push_state, 'sent')
  })

  test('reminders skip sessions whose time is not confirmed', async () => {
    await seedWeekend()
    await ingest({ kind: 'session.upsert', externalRef: 'gbr-2026-r', eventExternalRef: 'gbr-2026', sessionType: 'race', name: 'Race', timeStatus: 'tbc' })
    await ingest({
      kind: 'session.upsert', externalRef: 'gbr-2026-s', eventExternalRef: 'gbr-2026', sessionType: 'sprint', name: 'Sprint',
      localStart: '2026-07-04T15:00', timezone: 'Europe/London', timeStatus: 'provisional',
    })
    const r = await scanReminders(sql, { now: minutesBefore(QUALI_START, 29) })
    assert.equal(r.created, 1, 'only the confirmed qualifying session')
  })

  test('a rescheduled session notifies followers, cancels held reminders and reminds at the new time', async () => {
    const session = await seedWeekend()
    // The fan has quiet hours that hold the reminder (policy: defer).
    await sql`update public.notification_preferences
                 set quiet_hours_enabled = true, quiet_hours_start = '13:00', quiet_hours_end = '14:50' where user_id = ${fan}`
    await scanReminders(sql, { now: minutesBefore(QUALI_START, 29) }) // 14:31 BST: inside quiet hours, held until 14:50 BST
    const [held] = await sql`select status, send_after from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.user_id = ${fan}`
    assert.equal(held.status, 'pending')
    assert.equal(held.send_after.toISOString(), '2026-07-04T13:50:00.000Z')

    // Officials move qualifying back two hours (confirmed).
    const now = minutesBefore(QUALI_START, 25)
    const res = await ingest(
      { kind: 'session.upsert', externalRef: 'gbr-2026-q', eventExternalRef: 'gbr-2026', sessionType: 'qualifying', name: 'Qualifying',
        localStart: '2026-07-04T17:00', timezone: 'Europe/London', timeStatus: 'confirmed' },
      now,
    )
    assert.deepEqual(res, { outcome: 'applied', jobsQueued: 1 })
    const jobs = await processJobs(sql, { now })
    assert.equal(jobs.done, 1)

    const fanNotes = await notificationsFor(fan)
    assert.equal(fanNotes.length, 1, 'obsolete reminder archived')
    assert.equal(fanNotes[0].kind, 'schedule_change')
    assert.equal(fanNotes[0].title, 'Qualifying rescheduled')
    assert.match(fanNotes[0].body, /now Sat 4 Jul, 17:00 BST \(was Sat 4 Jul, 15:00 BST\)/)
    const [cancelled] = await sql`select status, error_code from public.notification_deliveries where status <> 'pending'`
    assert.deepEqual({ ...cancelled }, { status: 'cancelled', error_code: 'SESSION_CHANGED' })

    // Re-processing (retry) does not notify twice; re-sending the same update queues nothing.
    await sql`update public.notification_jobs set status = 'queued'`
    await processJobs(sql, { now })
    assert.equal((await notificationsFor(fan)).length, 1)
    assert.deepEqual(await ingest(
      { kind: 'session.upsert', externalRef: 'gbr-2026-q', eventExternalRef: 'gbr-2026', sessionType: 'qualifying', name: 'Qualifying',
        localStart: '2026-07-04T17:00', timezone: 'Europe/London', timeStatus: 'confirmed' },
      now,
    ), { outcome: 'unchanged', jobsQueued: 0 })

    // New reminder at the new time (old window produces nothing).
    const newStart = new Date('2026-07-04T16:00:00Z')
    const r = await scanReminders(sql, { now: minutesBefore(newStart, 29) })
    assert.equal(r.created, 1)
    const [reminder] = await sql`select data from public.notifications where user_id = ${fan} and kind = 'session_reminder' and archived_at is null`
    assert.equal(reminder.data.sessionStartsAt, newStart.toISOString())
    void session
  })

  test('cancelled sessions notify followers and get no further reminders', async () => {
    await seedWeekend()
    const now = at('2026-07-03T09:00:00Z')
    const res = await ingest({ kind: 'session.status', externalRef: 'gbr-2026-q', status: 'cancelled' }, now)
    assert.equal(res.outcome, 'applied')
    await processJobs(sql, { now })
    const [n] = await notificationsFor(fan)
    assert.equal(n.title, 'Qualifying cancelled')
    const r = await scanReminders(sql, { now: minutesBefore(QUALI_START, 29) })
    assert.equal(r.created, 0)
  })

  test('only trusted sources and supported championships are accepted', async () => {
    await seedWeekend()
    await sql`insert into public.data_sources (id, name, trust_level) values ('blog', 'A blog', 'trusted_media'), ('forum', 'Forum', 'unverified')`
    const results = await ingest({ kind: 'results.published', sessionExternalRef: 'gbr-2026-q', official: true }, undefined, 'blog')
    assert.deepEqual(results, { outcome: 'rejected', errors: ['source_not_trusted_for_results.published'] })
    const forum = await ingest({ kind: 'news', externalRef: 'n1', headline: 'h', summary: 's', importance: 'breaking', verification: 'confirmed', publishedAt: '2026-07-01T10:00:00Z' }, undefined, 'forum')
    assert.equal(forum.outcome, 'rejected')
    const unknown = await ingest({ kind: 'session.status', externalRef: 'x', status: 'live' }, undefined, 'nobody')
    assert.deepEqual(unknown, { outcome: 'rejected', errors: ['unknown_source'] })
    const unsupported = await ingest({ kind: 'event.upsert', externalRef: 'e', championshipId: 'motogp', name: 'GP', timezone: 'Europe/Rome', status: 'scheduled' })
    assert.deepEqual(unsupported, { outcome: 'rejected', errors: ['championship_not_supported'] })
    const log = await sql`select outcome from public.ingest_log where outcome = 'rejected'`
    assert.equal(log.length, 4)
  })

  test('official results notify followers once', async () => {
    await seedWeekend()
    const now = at('2026-07-04T16:00:00Z')
    assert.deepEqual(await ingest({ kind: 'results.published', sessionExternalRef: 'gbr-2026-q', official: true }, now), { outcome: 'applied', jobsQueued: 1 })
    assert.deepEqual(await ingest({ kind: 'results.published', sessionExternalRef: 'gbr-2026-q', official: true }, now), { outcome: 'unchanged', jobsQueued: 0 })
    await processJobs(sql, { now })
    const [n] = await notificationsFor(fan)
    assert.equal(n.title, 'Official qualifying results are available')
  })

  test('announcements: rumours never notify; confirmed news reaches driver and team followers once', async () => {
    await seedWeekend()
    await followDriver(driverFan)
    const [team] = await sql`select id from public.teams where external_ref = 'team-1'`
    await sql`insert into public.user_follows (user_id, entity_type, entity_id) values (${driverFan}, 'team', ${team.id}), (${stranger}, 'team', ${team.id})`
    const base = {
      kind: 'announcement', externalRef: 'ann-1', announcementType: 'signing', headline: 'Test Team confirms Test Driver for 2027',
      summary: 'The team has confirmed a multi-year agreement.', driverRefs: ['drv-44'], teamRefs: ['team-1'],
      url: 'https://example.com/a', publishedAt: '2026-07-01T09:00:00Z',
    }
    const now = at('2026-07-01T10:00:00Z')
    assert.deepEqual(await ingest({ ...base, verification: 'rumour' }, now), { outcome: 'applied', jobsQueued: 0, detail: (await ingest({ ...base, verification: 'rumour' }, now) as { detail: unknown }).detail })
    assert.equal((await ingest({ ...base, verification: 'confirmed' }, now)).outcome, 'applied')
    await processJobs(sql, { now })
    const df = await notificationsFor(driverFan)
    assert.equal(df.length, 1, 'driver + team follower gets one notification')
    assert.equal(df[0].category, 'driver_updates')
    assert.equal(df[0].source_url, 'https://example.com/a')
    assert.match(df[0].body, /Source: Official timing \(test\)/)
    const st = await notificationsFor(stranger)
    assert.equal(st[0].category, 'team_updates')
    // Editing a confirmed article does not re-notify.
    assert.equal((await ingest({ ...base, verification: 'confirmed', summary: 'Updated.' }, now)).outcome, 'applied')
    assert.equal(await sql`select count(*)::int as c from public.notification_jobs`.then((r) => r[0].c), 1)
  })

  test('related news collapses into one notification and minor stories are not pushed', async () => {
    await seedWeekend()
    await sql`update public.notification_preferences set categories = categories || '{"news_breaking": true}' where user_id = ${fan}`
    const now = at('2026-07-01T10:00:00Z')
    for (const [i, h] of ['Red flag in practice', 'Practice resumes after red flag'].entries()) {
      await ingest({ kind: 'news', externalRef: `n${i}`, headline: h, summary: 'Update', importance: 'breaking', verification: 'confirmed', championshipIds: ['f1'], storyKey: 'fp1-red-flag', publishedAt: '2026-07-01T09:00:00Z' }, now)
      await processJobs(sql, { now: new Date(now.getTime() + i * 60_000) })
    }
    await ingest({ kind: 'news', externalRef: 'minor', headline: 'Minor', summary: 'x', importance: 'minor', verification: 'confirmed', championshipIds: ['f1'], publishedAt: '2026-07-01T09:00:00Z' }, now)
    await processJobs(sql, { now })
    const notes = await notificationsFor(fan)
    assert.equal(notes.length, 1)
    assert.equal(notes[0].group_count, 2)
    assert.match(notes[0].body, /2 updates on this story/)
    assert.equal((await sql`select * from public.notification_deliveries`).length, 1, 'one push for the story')
    assert.equal((await notificationsFor(driverFan)).length, 0, 'news is opt-in')
  })

  test('rate limits suppress the push but keep the in-app notification', async () => {
    const make = (i: number) =>
      fanOut(sql, { category: 'news_major', kind: 'news', dedupeKey: `rl-${i}`, deepLink: '/notifications', text: () => ({ title: `Story ${i}`, body: 'b' }) }, [fan], {
        now: at('2026-07-01T10:00:00Z'),
      })
    await sql`update public.notification_preferences set categories = categories || '{"news_major": true}' where user_id = ${fan}`
    for (let i = 0; i < 4; i++) await make(i)
    const notes = await notificationsFor(fan)
    assert.equal(notes.length, 4)
    const states = notes.map((n) => `${n.push_state}:${n.push_note}`).sort()
    assert.deepEqual(states, ['scheduled:null', 'scheduled:null', 'suppressed:category_rate_limited', 'suppressed:category_rate_limited'])
  })

  test('security alerts bypass quiet hours and the push switch', async () => {
    await sql`update public.notification_preferences set push_enabled = false, quiet_hours_enabled = true,
                quiet_hours_start = '00:00', quiet_hours_end = '23:59' where user_id = ${fan}`
    await sql`update auth.users set encrypted_password = 'changed' where id = ${fan}`
    const now = new Date()
    await processJobs(sql, { now })
    const [n] = await notificationsFor(fan)
    assert.equal(n.category, 'account_security')
    assert.equal(n.title, 'Your password was changed')
    assert.doesNotMatch(n.body, /fan@example\.com/)
    assert.equal(n.deep_link, '/account/security')
    const expo = fakeExpo()
    assert.equal((await dispatchDeliveries(sql, { now, transport: { fetch: expo.fetch } })).sent, 1)
  })

  test('preference changes after a push was held are enforced at send time', async () => {
    await sql`update public.notification_preferences set quiet_hours_enabled = true, quiet_hours_start = '22:00', quiet_hours_end = '07:00' where user_id = ${fan}`
    const night = at('2026-07-01T22:30:00Z') // 23:30 BST
    await queueAppEvent(sql, { userId: fan, kind: 'analysis_completed', resourceId: 'an_1', now: night })
    await processJobs(sql, { now: night })
    const [n] = await notificationsFor(fan)
    assert.equal(n.deep_link, '/ai/analyses/an_1')
    assert.equal(n.push_note, 'held_for_quiet_hours')
    const expo = fakeExpo()
    assert.equal((await dispatchDeliveries(sql, { now: night, transport: { fetch: expo.fetch } })).sent, 0, 'held')
    await sql`update public.notification_preferences set categories = categories || '{"ai_tasks": false}' where user_id = ${fan}`
    const morning = at('2026-07-02T06:01:00Z')
    const d = await dispatchDeliveries(sql, { now: morning, transport: { fetch: expo.fetch } })
    assert.deepEqual([d.claimed, d.cancelled, d.sent], [1, 1, 0])
    assert.equal(expo.sent.length, 0)
  })

  test('reading a notification in the app cancels its held push', async () => {
    await sql`update public.notification_preferences set quiet_hours_enabled = true, quiet_hours_start = '22:00', quiet_hours_end = '07:00' where user_id = ${fan}`
    await queueAppEvent(sql, { userId: fan, kind: 'track_design_ready', resourceId: 'p1', now: at('2026-07-01T22:30:00Z') })
    await processJobs(sql, { now: at('2026-07-01T22:30:00Z') })
    await asUser(sql, fan, (tx) => tx`select public.mark_all_notifications_read()`)
    const d = await dispatchDeliveries(sql, { now: at('2026-07-02T06:01:00Z'), transport: { fetch: fakeExpo().fetch } })
    assert.equal(d.cancelled, 1)
  })

  test('invalid tokens are deregistered and stop receiving deliveries', async () => {
    const expo = fakeExpo({ ticket: () => ({ status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } }) })
    const now = at('2026-07-01T12:00:00Z')
    await queueAppEvent(sql, { userId: fan, kind: 'report_ready', resourceId: 'r1', now })
    await processJobs(sql, { now })
    const d = await dispatchDeliveries(sql, { now, transport: { fetch: expo.fetch } })
    assert.deepEqual([d.failed, d.invalidatedDevices], [1, 1])
    const [device] = await sql`select invalidated_at, invalid_reason from public.push_devices where user_id = ${fan}`
    assert.ok(device.invalidated_at)
    assert.equal(device.invalid_reason, 'DeviceNotRegistered')
    const [n] = await notificationsFor(fan)
    assert.equal(n.push_state, 'failed')
    // Next notification: in-app only.
    await queueAppEvent(sql, { userId: fan, kind: 'report_ready', resourceId: 'r2', now })
    await processJobs(sql, { now })
    const [latest] = await sql`select push_note from public.notifications where user_id = ${fan} and dedupe_key = ${dedupeKeys.appEvent('report_ready', 'r2')}`
    assert.equal(latest.push_note, 'no_device')
    await asUser(sql, driverFan, (tx) => tx`select 1`)
  })

  test('receipt errors are logged and invalid tokens from receipts are removed', async () => {
    const now = at('2026-07-01T12:00:00Z')
    await queueAppEvent(sql, { userId: fan, kind: 'report_ready', resourceId: 'r1', now })
    await processJobs(sql, { now })
    const expo = fakeExpo({ receipts: { 'ticket-1': { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } } } })
    await dispatchDeliveries(sql, { now, transport: { fetch: expo.fetch } })
    const r = await checkReceipts(sql, { now: new Date(now.getTime() + 20 * 60_000), transport: { fetch: expo.fetch } })
    assert.deepEqual([r.failed, r.invalidatedDevices, r.errors.DeviceNotRegistered], [1, 1, 1])
    const [delivery] = await sql`select status, error_code from public.notification_deliveries`
    assert.deepEqual({ ...delivery }, { status: 'failed', error_code: 'DeviceNotRegistered' })
  })

  test('temporary push failures are retried with backoff, then marked failed', async () => {
    let now = at('2026-07-01T12:00:00Z')
    await queueAppEvent(sql, { userId: fan, kind: 'export_ready', resourceId: 'x1', now })
    await processJobs(sql, { now })
    const down = fakeExpo({ httpStatus: () => 503 })
    for (let attempt = 1; attempt <= 5; attempt++) {
      const d = await dispatchDeliveries(sql, { now, transport: { fetch: down.fetch }, random: () => 0.5 })
      assert.equal(d.claimed, 1, `attempt ${attempt}`)
      const [row] = await sql`select status, attempts, send_after, error_code from public.notification_deliveries`
      assert.equal(row.attempts, attempt)
      assert.equal(row.error_code, 'HTTP_5XX')
      if (attempt < 5) {
        assert.equal(row.status, 'pending')
        assert.ok(row.send_after > now, 'backoff')
        assert.equal((await dispatchDeliveries(sql, { now, transport: { fetch: down.fetch } })).claimed, 0, 'not before backoff')
        now = row.send_after
      } else assert.equal(row.status, 'failed')
    }
  })

  test('logout removes the device so nothing more is pushed to it', async () => {
    await asUser(sql, fan, (tx) => tx`select public.unregister_push_device(${token(1)})`)
    await queueAppEvent(sql, { userId: fan, kind: 'analysis_completed', resourceId: 'a1', now: at('2026-07-01T12:00:00Z') })
    await processJobs(sql, { now: at('2026-07-01T12:00:00Z') })
    const [n] = await notificationsFor(fan)
    assert.equal(n.push_note, 'no_device')
    assert.equal((await sql`select * from public.notification_deliveries`).length, 0)
  })

  test('failed jobs are retried and eventually marked failed with the error', async () => {
    await sql`insert into public.notification_jobs (job_type, payload, idempotency_key) values ('app_event', '{"userId": "x", "kind": "nope"}', 'bad-1')`
    await sql`update public.notification_jobs set run_after = '2026-07-01T12:00:00Z'`
    let now = at('2026-07-01T12:00:00Z')
    for (let i = 0; i < 5; i++) {
      await processJobs(sql, { now })
      now = new Date(now.getTime() + 60 * 60_000)
    }
    const [job] = await sql`select status, attempts, last_error from public.notification_jobs`
    assert.deepEqual([job.status, job.attempts], ['failed', 5])
    assert.match(job.last_error, /Unknown app event/)
  })

  test('test notifications go only to the caller and are rate limited', async () => {
    const expo = fakeExpo()
    const now = at('2026-07-01T12:00:00Z')
    for (let i = 0; i < 3; i++) {
      const r = await sendTestNotification(sql, { userId: fan, now, transport: { fetch: expo.fetch }, requestId: `req-${i}` })
      assert.equal(r.status, 'sent')
    }
    assert.equal((await sendTestNotification(sql, { userId: fan, now, transport: { fetch: expo.fetch }, requestId: 'req-4' })).status, 'rate_limited')
    assert.ok(expo.sent.every((m) => m.to === token(1)))
    await asUser(sql, stranger, (tx) => tx`select public.unregister_push_device(${token(3)})`)
    assert.equal((await sendTestNotification(sql, { userId: stranger, now, transport: { fetch: expo.fetch }, requestId: 'req-5' })).status, 'no_device')
  })

  test('reminders more than 10 minutes late are skipped, not sent stale', async () => {
    await seedWeekend()
    await sql`insert into public.reminder_scan_state (id, scanned_until) values (1, ${minutesBefore(QUALI_START, 120)})`
    // Worker was down; first run is 15 minutes after the 30-minute reminder was due.
    const r = await scanReminders(sql, { now: minutesBefore(QUALI_START, 15) })
    assert.ok(r.missedWindow)
    assert.equal(r.created, 0)
  })

  // ---- Regressions from the backend review ----

  test('a token moved to another account never receives the previous owner\'s retried push', async () => {
    const now = at('2026-07-01T12:00:00Z')
    await queueAppEvent(sql, { userId: fan, kind: 'report_ready', resourceId: 'r1', now })
    await processJobs(sql, { now })
    // First attempt fails transiently, so the delivery goes back to pending...
    await dispatchDeliveries(sql, { now, transport: { fetch: fakeExpo({ httpStatus: () => 503 }).fetch }, random: () => 0.5 })
    // ...and meanwhile the phone signs in to the stranger's account.
    await asUser(sql, stranger, (tx) => tx`select public.register_push_device(${token(1)}, 'ios')`)
    const expo = fakeExpo()
    const d = await dispatchDeliveries(sql, { now: new Date(now.getTime() + 60 * 60_000), transport: { fetch: expo.fetch } })
    assert.equal(expo.sent.length, 0)
    assert.equal(d.sent, 0)
    const [row] = await sql`select status, error_code from public.notification_deliveries`
    assert.deepEqual({ ...row }, { status: 'cancelled', error_code: 'DEVICE_REASSIGNED' })
  })

  test('a token moved while a send is in flight cannot be re-sent to the new owner', async () => {
    const now = at('2026-07-01T12:00:00Z')
    await queueAppEvent(sql, { userId: fan, kind: 'report_ready', resourceId: 'r1', now })
    await processJobs(sql, { now })
    await sql`update public.notification_deliveries set status = 'sending', last_attempt_at = ${now}`
    await asUser(sql, stranger, (tx) => tx`select public.register_push_device(${token(1)}, 'ios')`)
    const [row] = await sql`select status from public.notification_deliveries`
    assert.equal(row.status, 'cancelled')
  })

  test('a confirmed time that becomes provisional cancels reminders built on it', async () => {
    await seedWeekend()
    await sql`update public.notification_preferences
                 set reminder_offsets = '{1440}', quiet_hours_enabled = true, quiet_hours_start = '13:00', quiet_hours_end = '16:00' where user_id = ${fan}`
    await scanReminders(sql, { now: minutesBefore(QUALI_START, 1439) }) // 15:01 BST on the 3rd: held until 16:00
    const [held] = await sql`select status from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.user_id = ${fan}`
    assert.equal(held.status, 'pending')
    const res = await ingest(
      { kind: 'session.upsert', externalRef: 'gbr-2026-q', eventExternalRef: 'gbr-2026', sessionType: 'qualifying', name: 'Qualifying',
        localStart: '2026-07-06T15:00', timezone: 'Europe/London', timeStatus: 'provisional' },
      minutesBefore(QUALI_START, 1430),
    )
    assert.equal(res.outcome, 'applied')
    const [after] = await sql`select d.status, n.archived_at from public.notification_deliveries d join public.notifications n on n.id = d.notification_id where n.user_id = ${fan}`
    assert.equal(after.status, 'cancelled')
    assert.ok(after.archived_at)
    const sent = await dispatchDeliveries(sql, { now: minutesBefore(QUALI_START, 1300), transport: { fetch: fakeExpo().fetch } })
    assert.equal(sent.sent, 0)
  })

  test('pushes held overnight are still rate limited when quiet hours end', async () => {
    await sql`update public.notification_preferences set quiet_hours_enabled = true, quiet_hours_start = '22:00', quiet_hours_end = '07:00' where user_id = ${fan}`
    // Five AI results per hour for seven hours: each hour is within the creation-time limits.
    for (let h = 0; h < 7; h++) {
      const now = new Date(at('2026-07-01T21:30:00Z').getTime() + h * 60 * 60_000)
      for (let i = 0; i < 5; i++) await queueAppEvent(sql, { userId: fan, kind: 'report_ready', resourceId: `r${h}-${i}`, now })
      await processJobs(sql, { now })
    }
    const expo = fakeExpo()
    const d = await dispatchDeliveries(sql, { now: at('2026-07-02T06:01:00Z'), transport: { fetch: expo.fetch } })
    assert.equal(expo.sent.length, RATE_LIMITS.perCategoryPerWindow.ai_tasks)
    assert.equal(d.sent + d.cancelled, d.claimed)
    const [{ c }] = await sql`select count(*)::int as c from public.notifications where user_id = ${fan} and push_note = 'overall_rate_limited'`
    assert.equal(c, d.cancelled, 'skipped pushes stay in-app with an explanation')
  })

  test('app events for two users with the same resource id are both delivered', async () => {
    const now = at('2026-07-01T12:00:00Z')
    assert.equal(await queueAppEvent(sql, { userId: fan, kind: 'analysis_completed', resourceId: 'job-1', now }), true)
    assert.equal(await queueAppEvent(sql, { userId: driverFan, kind: 'analysis_completed', resourceId: 'job-1', now }), true)
    assert.equal(await queueAppEvent(sql, { userId: fan, kind: 'analysis_completed', resourceId: 'job-1', now }), false, 'still idempotent per user')
    await processJobs(sql, { now })
    assert.equal((await notificationsFor(fan)).length, 1)
    assert.equal((await notificationsFor(driverFan)).length, 1)
  })

  test('out-of-order provider updates cannot put back an old session time', async () => {
    await seedWeekend()
    const now = at('2026-07-03T09:00:00Z')
    const base = { kind: 'session.upsert', externalRef: 'gbr-2026-q', eventExternalRef: 'gbr-2026', sessionType: 'qualifying', name: 'Qualifying', timezone: 'Europe/London', timeStatus: 'confirmed' }
    assert.equal((await ingest({ ...base, localStart: '2026-07-04T17:00', updatedAt: '2026-07-03T08:00:00Z' }, now)).outcome, 'applied')
    const replay = await ingest({ ...base, localStart: '2026-07-04T15:00', updatedAt: '2026-07-02T08:00:00Z' }, now)
    assert.deepEqual(replay, { outcome: 'rejected', errors: ['stale_update'] })
    const [s] = await sql`select starts_at from public.event_sessions where external_ref = 'gbr-2026-q'`
    assert.equal(s.starts_at.toISOString(), '2026-07-04T16:00:00.000Z')
    const staleStatus = await ingest({ kind: 'session.status', externalRef: 'gbr-2026-q', status: 'cancelled', updatedAt: '2026-07-01T00:00:00Z' }, now)
    assert.deepEqual(staleStatus, { outcome: 'rejected', errors: ['stale_update'] })
  })

  test('a new time for a cancelled session does not announce a reschedule', async () => {
    await seedWeekend()
    const now = at('2026-07-03T09:00:00Z')
    await ingest({ kind: 'session.status', externalRef: 'gbr-2026-q', status: 'cancelled' }, now)
    const r = await ingest(
      { kind: 'session.upsert', externalRef: 'gbr-2026-q', eventExternalRef: 'gbr-2026', sessionType: 'qualifying', name: 'Qualifying',
        localStart: '2026-07-04T17:00', timezone: 'Europe/London', timeStatus: 'confirmed' },
      now,
    )
    assert.deepEqual(r, { outcome: 'applied', jobsQueued: 0 })
  })

  test('a job that keeps crashing the worker is eventually marked failed', async () => {
    const now = at('2026-07-01T12:00:00Z')
    await sql`insert into public.notification_jobs (job_type, payload, idempotency_key, status, attempts, locked_at)
              values ('app_event', '{}', 'crash-1', 'processing', 5, ${new Date(now.getTime() - 20 * 60_000)})`
    await processJobs(sql, { now })
    const [job] = await sql`select status, last_error from public.notification_jobs where idempotency_key = 'crash-1'`
    assert.equal(job.status, 'failed')
    assert.match(job.last_error, /Worker stopped/)
  })

  test('test notifications are sent straight away even during quiet hours', async () => {
    await sql`update public.notification_preferences set quiet_hours_enabled = true, quiet_hours_start = '00:00', quiet_hours_end = '23:59' where user_id = ${fan}`
    const r = await sendTestNotification(sql, { userId: fan, now: at('2026-07-01T12:00:00Z'), transport: { fetch: fakeExpo().fetch }, requestId: 'q1' })
    assert.equal(r.status, 'sent')
  })
})
