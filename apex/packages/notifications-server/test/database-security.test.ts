// Row-level security, grants and constraints, exercised as the `anon` and
// `authenticated` roles exactly as Supabase's API would run them.

import { after, before, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { preferencesFromRow, recommendedPreferences } from '@apex/notifications-core'
import { asUser, connect, createUser, resetData, skipNoDb, token } from './helpers.ts'

describe('database security', { skip: skipNoDb }, () => {
  const sql = skipNoDb ? (null as never) : connect()
  let alice: string
  let bob: string

  before(async () => {})
  after(async () => sql?.end())
  beforeEach(async () => {
    await resetData(sql)
    alice = await createUser(sql, 'alice@example.com')
    bob = await createUser(sql, 'bob@example.com')
  })

  async function addNotification(userId: string, key: string) {
    const [n] = await sql<{ id: string }[]>`
      insert into public.notifications (user_id, category, kind, title, body, deep_link, dedupe_key)
      values (${userId}, 'race_results', 'results_published', 'Results', 'Body', '/events/e1', ${key}) returning id`
    return n.id
  }

  test('new users get the recommended default preferences (SQL defaults match the app)', async () => {
    const [row] = await sql`select * from public.notification_preferences where user_id = ${alice}`
    const parsed = preferencesFromRow(row as never)
    assert.deepEqual(parsed.errors, [])
    assert.deepEqual(parsed.preferences, recommendedPreferences())
  })

  test('users only see and change their own notifications', async () => {
    const mine = await addNotification(alice, 'k1')
    const theirs = await addNotification(bob, 'k2')
    const visible = await asUser(sql, alice, (tx) => tx`select id from public.notifications`)
    assert.deepEqual(visible.map((r) => r.id), [mine])

    const updated = await asUser(sql, alice, (tx) => tx`update public.notifications set read_at = now() where id = ${theirs} returning id`)
    assert.equal(updated.length, 0, 'cannot mark another user notification read')
    const own = await asUser(sql, alice, (tx) => tx`update public.notifications set read_at = now(), archived_at = now() where id = ${mine} returning id`)
    assert.equal(own.length, 1)

    const n = await asUser(sql, alice, (tx) => tx`select public.mark_all_notifications_read() as n`)
    assert.equal(n[0].n, 0)
    const [bobRow] = await sql`select read_at from public.notifications where id = ${theirs}`
    assert.equal(bobRow.read_at, null)

    const anon = await asUser(sql, null, (tx) => tx`select id from public.notifications`).catch((e) => e)
    assert.match(String(anon), /permission denied/)
  })

  test('clients cannot create, rewrite or delete notifications', async () => {
    const mine = await addNotification(alice, 'k1')
    const insert = await asUser(sql, alice, (tx) =>
      tx`insert into public.notifications (user_id, category, kind, title, body, dedupe_key) values (${bob}, 'system', 'x', 't', 'b', 'evil')`,
    ).catch((e) => e)
    assert.match(String(insert), /permission denied/)
    const rewrite = await asUser(sql, alice, (tx) => tx`update public.notifications set title = 'Hacked' where id = ${mine}`).catch((e) => e)
    assert.match(String(rewrite), /permission denied/)
    const del = await asUser(sql, alice, (tx) => tx`delete from public.notifications where id = ${mine}`).catch((e) => e)
    assert.match(String(del), /permission denied/)
  })

  test('preferences, follows and saved events are private to the user', async () => {
    await asUser(sql, alice, (tx) => tx`update public.notification_preferences set push_enabled = false`)
    const [a] = await sql`select push_enabled from public.notification_preferences where user_id = ${alice}`
    const [b] = await sql`select push_enabled from public.notification_preferences where user_id = ${bob}`
    assert.equal(a.push_enabled, false)
    assert.equal(b.push_enabled, true, 'update without a filter only touched own row')

    await asUser(sql, alice, (tx) => tx`insert into public.user_follows (entity_type, entity_id) values ('championship', 'f1')`)
    const spoof = await asUser(sql, alice, (tx) => tx`insert into public.user_follows (user_id, entity_type, entity_id) values (${bob}, 'championship', 'f1')`).catch((e) => e)
    assert.match(String(spoof), /row-level security/)
    const bobSees = await asUser(sql, bob, (tx) => tx`select * from public.user_follows`)
    assert.equal(bobSees.length, 0)
    const bobPrefs = await asUser(sql, bob, (tx) => tx`select user_id from public.notification_preferences`)
    assert.deepEqual(bobPrefs.map((r) => r.user_id), [bob])
  })

  test('preference constraints reject invalid values', async () => {
    const bad = [
      sql`update public.notification_preferences set reminder_offsets = '{45}' where user_id = ${alice}`,
      sql`update public.notification_preferences set reminder_session_types = '{warmup}' where user_id = ${alice}`,
      sql`update public.notification_preferences set preferred_timezone = 'Mars/Base' where user_id = ${alice}`,
      sql`update public.notification_preferences set timezone_mode = 'preferred', preferred_timezone = null where user_id = ${alice}`,
      sql`update public.notification_preferences set quiet_hours_start = '07:00', quiet_hours_end = '07:00' where user_id = ${alice}`,
    ]
    for (const q of bad) assert.match(String(await q.catch((e) => e)), /violates check constraint/)
  })

  test('push tokens are never readable by clients and only bound to the caller', async () => {
    const direct = await asUser(sql, alice, (tx) => tx`select expo_push_token from public.push_devices`).catch((e) => e)
    assert.match(String(direct), /permission denied/)
    const insert = await asUser(sql, alice, (tx) =>
      tx`insert into public.push_devices (user_id, expo_push_token, platform) values (${bob}, ${token(1)}, 'ios')`,
    ).catch((e) => e)
    assert.match(String(insert), /permission denied/)

    const [{ id }] = await asUser(sql, alice, (tx) => tx`select public.register_push_device(${token(1)}, 'ios', 'Alice phone', '1.0.0', 'Europe/London') as id`)
    const [device] = await sql`select user_id, timezone from public.push_devices where id = ${id}`
    assert.equal(device.user_id, alice)
    const [prefs] = await sql`select device_timezone from public.notification_preferences where user_id = ${alice}`
    assert.equal(prefs.device_timezone, 'Europe/London')

    const listed = await asUser(sql, alice, (tx) => tx`select * from public.my_push_devices()`)
    assert.equal(listed.length, 1)
    assert.equal(listed[0].token_hint, '…0001')
    assert.ok(!JSON.stringify(listed).includes('ExponentPushToken'))
    assert.equal((await asUser(sql, bob, (tx) => tx`select * from public.my_push_devices()`)).length, 0)

    const badToken = await asUser(sql, alice, (tx) => tx`select public.register_push_device('not-a-token', 'ios')`).catch((e) => e)
    assert.match(String(badToken), /check constraint/)
    const anon = await asUser(sql, null, (tx) => tx`select public.register_push_device(${token(2)}, 'ios')`).catch((e) => e)
    assert.match(String(anon), /permission denied/)
  })

  test('re-registering a token on another account moves it and cancels the old owner\'s queued pushes', async () => {
    await asUser(sql, alice, (tx) => tx`select public.register_push_device(${token(1)}, 'android')`)
    const n = await addNotification(alice, 'k1')
    const [device] = await sql`select id from public.push_devices`
    await sql`insert into public.notification_deliveries (notification_id, user_id, device_id, category) values (${n}, ${alice}, ${device.id}, 'race_results')`
    await asUser(sql, bob, (tx) => tx`select public.register_push_device(${token(1)}, 'android')`)
    const [moved] = await sql`select user_id from public.push_devices`
    assert.equal(moved.user_id, bob)
    const [delivery] = await sql`select status, error_code from public.notification_deliveries`
    assert.deepEqual({ ...delivery }, { status: 'cancelled', error_code: 'DEVICE_REASSIGNED' })
  })

  test('unregistering (logout) removes only the caller\'s device', async () => {
    await asUser(sql, alice, (tx) => tx`select public.register_push_device(${token(1)}, 'ios')`)
    const [{ removed: bobTry }] = await asUser(sql, bob, (tx) => tx`select public.unregister_push_device(${token(1)}) as removed`)
    assert.equal(bobTry, false)
    const [{ removed }] = await asUser(sql, alice, (tx) => tx`select public.unregister_push_device(${token(1)}) as removed`)
    assert.equal(removed, true)
    assert.equal((await sql`select * from public.push_devices`).length, 0)
  })

  test('users can remove their own devices by id, not anyone else\'s', async () => {
    await asUser(sql, alice, (tx) => tx`select public.register_push_device(${token(1)}, 'ios')`)
    const [{ id }] = await asUser(sql, alice, (tx) => tx`select id from public.my_push_devices()`)
    const [{ ok: bobTry }] = await asUser(sql, bob, (tx) => tx`select public.remove_push_device(${id}) as ok`)
    assert.equal(bobTry, false)
    const [{ ok }] = await asUser(sql, alice, (tx) => tx`select public.remove_push_device(${id}) as ok`)
    assert.equal(ok, true)
  })

  test('a device that signed out offline can release its token later without a session', async () => {
    await asUser(sql, alice, (tx) => tx`select public.register_push_device(${token(1)}, 'ios')`)
    const [{ ok }] = await asUser(sql, null, (tx) => tx`select public.release_push_token(${token(1)}) as ok`)
    assert.equal(ok, true)
    assert.equal((await sql`select * from public.push_devices`).length, 0)
    const [{ ok: again }] = await asUser(sql, null, (tx) => tx`select public.release_push_token(${token(1)}) as ok`)
    assert.equal(again, false)
  })

  test('server-only tables and functions are closed to clients', async () => {
    for (const table of ['notification_deliveries', 'notification_jobs', 'reminder_scan_state', 'ingest_log', 'system_heartbeats']) {
      const r = await asUser(sql, alice, (tx) => tx.unsafe(`select * from public.${table}`)).catch((e) => e)
      assert.match(String(r), /permission denied/, table)
    }
    const fn = await asUser(sql, alice, (tx) => tx`select * from public.reminder_candidates(now(), now())`).catch((e) => e)
    assert.match(String(fn), /permission denied/)
    const aud = await asUser(sql, alice, (tx) => tx`select * from public.session_audience(gen_random_uuid())`).catch((e) => e)
    assert.match(String(aud), /permission denied/)
    const writeRef = await asUser(sql, alice, (tx) => tx`update public.championships set supported = true`).catch((e) => e)
    assert.match(String(writeRef), /permission denied/)
  })

  test('reference data and system status are public and read-only', async () => {
    const champs = await asUser(sql, null, (tx) => tx`select id from public.championships order by sort_order`)
    assert.ok(champs.length >= 10)
    const [status] = await asUser(sql, null, (tx) => tx`select public.get_notification_system_status() as s`)
    assert.equal(status.s.push_provider_configured, false)
    assert.equal(status.s.live_sources, 0)
  })

  test('notification constraints reject external deep links and oversize text', async () => {
    const ext = await sql`insert into public.notifications (user_id, category, kind, title, body, deep_link, dedupe_key)
      values (${alice}, 'system', 'x', 't', 'b', 'https://evil.example', 'k')`.catch((e) => e)
    assert.match(String(ext), /check constraint/)
    const dbl = await sql`insert into public.notifications (user_id, category, kind, title, body, deep_link, dedupe_key)
      values (${alice}, 'system', 'x', 't', 'b', '//evil.example/x', 'k')`.catch((e) => e)
    assert.match(String(dbl), /check constraint/)
    const long = await sql`insert into public.notifications (user_id, category, kind, title, body, dedupe_key)
      values (${alice}, 'system', 'x', ${'x'.repeat(66)}, 'b', 'k')`.catch((e) => e)
    assert.match(String(long), /check constraint/)
    await addNotification(alice, 'same')
    const dup = await addNotification(alice, 'same').catch((e) => e)
    assert.match(String(dup), /duplicate key/)
  })

  test('demo notifications are labelled, idempotent and removable', async () => {
    const [{ n }] = await asUser(sql, alice, (tx) => tx`select public.seed_demo_notifications() as n`)
    assert.equal(n, 5)
    const [{ n: again }] = await asUser(sql, alice, (tx) => tx`select public.seed_demo_notifications() as n`)
    assert.equal(again, 0)
    const rows = await asUser(sql, alice, (tx) => tx`select title, is_demo from public.notifications`)
    assert.ok(rows.every((r) => r.is_demo && r.title.startsWith('Sample:')))
    const [{ n: cleared }] = await asUser(sql, alice, (tx) => tx`select public.clear_demo_notifications() as n`)
    assert.equal(cleared, 5)
  })

  test('password and email changes queue an account-security job', async () => {
    await sql`update auth.users set encrypted_password = 'hash-2' where id = ${alice}`
    await sql`update auth.users set email = 'alice2@example.com' where id = ${alice}`
    await sql`update auth.users set updated_at = now() where id = ${alice}`
    const jobs = await sql`select payload ->> 'kind' as kind from public.notification_jobs where job_type = 'security_event' order by created_at`
    assert.deepEqual(jobs.map((j) => j.kind), ['password_changed', 'email_changed'])
  })

  test('deleting an account removes all of its notification data', async () => {
    await addNotification(alice, 'k1')
    await asUser(sql, alice, (tx) => tx`select public.register_push_device(${token(1)}, 'ios')`)
    await sql`delete from auth.users where id = ${alice}`
    for (const t of ['notifications', 'push_devices', 'notification_preferences']) {
      const [{ count }] = await sql.unsafe(`select count(*)::int as count from public.${t} where user_id = '${alice}'`)
      assert.equal(count, 0, t)
    }
  })
})
