import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EXPO_PUSH_SEND_URL,
  checkSourceAllowed,
  canNotifyVerification,
  getExpoReceipts,
  isExpoPushToken,
  retryDelayMs,
  sendExpoPush,
  signHmac,
  validateIngestUpdate,
  verifyHmacSignature,
  type ExpoPushMessage,
  type FetchLike,
} from '../src/index.ts'

function fakeFetch(handler: (url: string, body: unknown) => { status: number; body: unknown } | Error) {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = []
  const fetch: FetchLike = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body, headers: init.headers })
    const r = handler(url, body)
    if (r instanceof Error) throw r
    return { status: r.status, json: async () => r.body, text: async () => JSON.stringify(r.body) }
  }
  return { fetch, calls }
}

const msg = (i: number): ExpoPushMessage => ({ to: `ExponentPushToken[tok${String(i).padStart(6, '0')}]`, title: 't', body: 'b', data: {} })

test('validates Expo push tokens', () => {
  assert.equal(isExpoPushToken('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'), true)
  assert.equal(isExpoPushToken('ExpoPushToken[abcdefgh1234]'), true)
  assert.equal(isExpoPushToken('fcm:abc'), false)
  assert.equal(isExpoPushToken('ExponentPushToken[]'), false)
})

test('sends in chunks of 100 and maps tickets back to messages', async () => {
  const { fetch, calls } = fakeFetch((_url, body) => ({
    status: 200,
    body: {
      data: (body as ExpoPushMessage[]).map((m, i) =>
        m.to.endsWith('000003]')
          ? { status: 'error', message: '"ExponentPushToken[...]" is not a registered push notification recipient', details: { error: 'DeviceNotRegistered' } }
          : { status: 'ok', id: `ticket-${i}` },
      ),
    },
  }))
  const results = await sendExpoPush(Array.from({ length: 150 }, (_, i) => msg(i)), { fetch, accessToken: 'secret' })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, EXPO_PUSH_SEND_URL)
  assert.equal((calls[0].body as unknown[]).length, 100)
  assert.equal(calls[0].headers.authorization, 'Bearer secret')
  assert.equal(results.length, 150)
  assert.deepEqual(results[0], { status: 'ok', ticketId: 'ticket-0' })
  const invalid = results[3]
  assert.equal(invalid.status === 'error' && invalid.invalidToken, true)
  assert.equal(invalid.status === 'error' && invalid.retryable, false)
})

test('transport failures are retryable, rejected requests are not', async () => {
  const rate = await sendExpoPush([msg(1)], { fetch: fakeFetch(() => ({ status: 429, body: {} })).fetch })
  assert.equal(rate[0].status === 'error' && rate[0].retryable, true)
  const down = await sendExpoPush([msg(1)], { fetch: fakeFetch(() => ({ status: 503, body: {} })).fetch })
  assert.equal(down[0].status === 'error' && down[0].errorCode, 'HTTP_5XX')
  const net = await sendExpoPush([msg(1)], { fetch: fakeFetch(() => new Error('ECONNRESET')).fetch })
  assert.equal(net[0].status === 'error' && net[0].retryable, true)
  const bad = await sendExpoPush([msg(1)], {
    fetch: fakeFetch(() => ({ status: 400, body: { errors: [{ code: 'VALIDATION_ERROR', message: 'bad' }] } })).fetch,
  })
  assert.deepEqual(bad[0].status === 'error' && [bad[0].errorCode, bad[0].retryable], ['VALIDATION_ERROR', false])
})

test('reads receipts, flagging invalid tokens and pending receipts', async () => {
  const { fetch } = fakeFetch(() => ({
    status: 200,
    body: {
      data: {
        a: { status: 'ok' },
        b: { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
        c: { status: 'error', message: 'too big', details: { error: 'MessageTooBig' } },
      },
    },
  }))
  const r = await getExpoReceipts(['a', 'b', 'c', 'd'], { fetch })
  assert.deepEqual(r.get('a'), { status: 'ok' })
  assert.equal(r.get('b')?.status === 'error' && r.get('b')?.status === 'error' && (r.get('b') as { invalidToken: boolean }).invalidToken, true)
  assert.equal((r.get('c') as { invalidToken: boolean }).invalidToken, false)
  assert.deepEqual(r.get('d'), { status: 'pending' })
})

test('retry backoff grows and is capped', () => {
  const mid = () => 0.5
  assert.equal(retryDelayMs(1, mid), 22_500)
  assert.equal(retryDelayMs(2, mid), 45_000)
  assert.ok(retryDelayMs(20, () => 1) <= 30 * 60_000)
})

test('validates session updates and converts event-local times', () => {
  const r = validateIngestUpdate({
    kind: 'session.upsert',
    externalRef: 'f1-2026-gbr-q',
    eventExternalRef: 'f1-2026-gbr',
    sessionType: 'qualifying',
    name: 'Qualifying',
    localStart: '2026-07-04T15:00',
    timezone: 'Europe/London',
    timeStatus: 'confirmed',
  })
  assert.ok(r.ok, JSON.stringify(r))
  assert.equal(r.ok && r.update.kind === 'session.upsert' && r.update.startsAt, '2026-07-04T14:00:00.000Z')
})

test('rejects ambiguous, impossible or inconsistent session times instead of guessing', () => {
  const base = { kind: 'session.upsert', externalRef: 's', eventExternalRef: 'e', sessionType: 'race', name: 'Race', timeStatus: 'confirmed', timezone: 'Europe/London' }
  const gap = validateIngestUpdate({ ...base, localStart: '2026-03-29T01:30' })
  assert.ok(!gap.ok && gap.errors.some((e) => e.includes('daylight-saving gap')))
  const overlap = validateIngestUpdate({ ...base, localStart: '2026-10-25T01:30' })
  assert.ok(!overlap.ok && overlap.errors.some((e) => e.includes('occurs twice')))
  const overlapResolved = validateIngestUpdate({ ...base, localStart: '2026-10-25T01:30', startsAt: '2026-10-25T01:30:00+00:00' })
  assert.ok(overlapResolved.ok)
  const mismatch = validateIngestUpdate({ ...base, localStart: '2026-07-04T15:00', startsAt: '2026-07-04T15:00:00Z' })
  assert.ok(!mismatch.ok && mismatch.errors.some((e) => e.includes('disagree')))
  const missing = validateIngestUpdate({ ...base, timezone: undefined })
  assert.ok(!missing.ok)
  const tbc = validateIngestUpdate({ ...base, timeStatus: 'tbc' })
  assert.ok(tbc.ok && tbc.update.kind === 'session.upsert' && tbc.update.startsAt === null)
})

test('rejects malformed announcements and unsafe links', () => {
  const r = validateIngestUpdate({
    kind: 'announcement',
    externalRef: 'a1',
    announcementType: 'signing',
    headline: 'x',
    summary: 'y',
    verification: 'confirmed',
    url: 'javascript:alert(1)',
    publishedAt: '2026-07-01T10:00:00Z',
  })
  assert.ok(!r.ok)
  assert.ok(r.errors.includes('url must be an https URL'))
  assert.ok(r.errors.includes('announcement must name at least one driver or team'))
  const results = validateIngestUpdate({ kind: 'results.published', sessionExternalRef: 's1' })
  assert.ok(!results.ok && results.errors[0].includes('official'))
})

test('source trust rules: only confirmed information from trusted sources notifies', () => {
  assert.deepEqual(checkSourceAllowed({ id: 'fom', trustLevel: 'official', active: true }, 'session.upsert'), { ok: true })
  assert.equal(checkSourceAllowed({ id: 'blog', trustLevel: 'trusted_media', active: true }, 'results.published').ok, false)
  assert.equal(checkSourceAllowed({ id: 'blog', trustLevel: 'trusted_media', active: true }, 'news').ok, true)
  assert.equal(checkSourceAllowed({ id: 'forum', trustLevel: 'unverified', active: true }, 'news').ok, false)
  assert.equal(checkSourceAllowed({ id: 'old', trustLevel: 'official', active: false }, 'news').ok, false)
  assert.equal(checkSourceAllowed(null, 'news').ok, false)
  assert.equal(canNotifyVerification('confirmed'), true)
  assert.equal(canNotifyVerification('rumour'), false)
  assert.equal(canNotifyVerification('reported'), false)
})

test('HMAC webhook signatures', async () => {
  const body = JSON.stringify({ kind: 'news' })
  const sig = await signHmac('s3cret', body)
  assert.equal(await verifyHmacSignature('s3cret', body, sig), true)
  assert.equal(await verifyHmacSignature('s3cret', body + ' ', sig), false)
  assert.equal(await verifyHmacSignature('other', body, sig), false)
  assert.equal(await verifyHmacSignature('s3cret', body, null), false)
  assert.equal(await verifyHmacSignature('s3cret', body, 'sha256=zz'), false)
})
