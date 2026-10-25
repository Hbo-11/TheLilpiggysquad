import { after, beforeEach, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { signHmac } from '@apex/notifications-core'
import { handleAppEvent, handleIngest, handleProcess, handleReceipts, handleTestNotification, type HandlerDeps } from '../src/index.ts'
import { SOURCE, connect, createUser, fakeExpo, resetData, setupOfficialSource, skipNoDb } from './helpers.ts'

const INTERNAL = 'x'.repeat(40)

describe('edge function handlers', { skip: skipNoDb }, () => {
  const sql = skipNoDb ? (null as never) : connect()
  after(async () => sql?.end())
  let userId: string

  function deps(extra: Partial<HandlerDeps> = {}): HandlerDeps {
    const expo = fakeExpo()
    const env: Record<string, string> = {
      APEX_INTERNAL_SECRET: INTERNAL,
      INGEST_SOURCE_SECRETS: JSON.stringify({ [SOURCE]: 'provider-secret' }),
      SUPABASE_URL: 'https://project.supabase.co',
      SUPABASE_ANON_KEY: 'anon',
    }
    const fetch = (async (url: string, init?: { headers?: Record<string, string>; body?: string; method?: string }) => {
      if (String(url).endsWith('/auth/v1/user')) {
        const ok = init?.headers?.authorization === 'Bearer valid-user-jwt'
        return new Response(JSON.stringify(ok ? { id: userId } : { msg: 'invalid' }), { status: ok ? 200 : 401 })
      }
      return expo.fetch(String(url), init as never)
    }) as unknown as typeof globalThis.fetch
    return { db: sql, env: (n) => env[n], fetch, ...extra }
  }

  beforeEach(async () => {
    await resetData(sql)
    await setupOfficialSource(sql)
    userId = await createUser(sql, 'user@example.com')
  })

  test('ingest requires a valid HMAC signature from a configured source', async () => {
    const body = JSON.stringify({ kind: 'event.upsert', externalRef: 'e1', championshipId: 'f1', name: 'Test GP', timezone: 'Europe/London', status: 'scheduled' })
    const req = (headers: Record<string, string>) => new Request('http://x/ingest', { method: 'POST', body, headers })
    assert.equal((await handleIngest(req({ 'x-apex-source': SOURCE }), deps())).status, 401)
    assert.equal((await handleIngest(req({ 'x-apex-source': SOURCE, 'x-apex-signature': await signHmac('wrong', body) }), deps())).status, 401)
    assert.equal((await handleIngest(req({ 'x-apex-source': 'other', 'x-apex-signature': await signHmac('provider-secret', body) }), deps())).status, 401)
    const ok = await handleIngest(req({ 'x-apex-source': SOURCE, 'x-apex-signature': await signHmac('provider-secret', body) }), deps())
    assert.equal(ok.status, 200)
    assert.equal(((await ok.json()) as { results: { outcome: string }[] }).results[0].outcome, 'applied')

    const bad = JSON.stringify({ kind: 'session.upsert' })
    const rejected = await handleIngest(
      new Request('http://x/ingest', { method: 'POST', body: bad, headers: { 'x-apex-source': SOURCE, 'x-apex-signature': await signHmac('provider-secret', bad) } }),
      deps(),
    )
    assert.equal(rejected.status, 422)
  })

  test('worker and service endpoints require the internal secret', async () => {
    for (const handler of [handleProcess, handleReceipts, handleAppEvent]) {
      assert.equal((await handler(new Request('http://x', { method: 'POST' }), deps())).status, 401)
      assert.equal((await handler(new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer nope' } }), deps())).status, 401)
    }
    // A weak secret disables the endpoints instead of accepting it.
    const weak = deps({ env: (n) => (n === 'APEX_INTERNAL_SECRET' ? 'short' : undefined) })
    assert.equal((await handleProcess(new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer short' } }), weak)).status, 401)

    const auth = { authorization: `Bearer ${INTERNAL}` }
    const appEvent = await handleAppEvent(
      new Request('http://x', { method: 'POST', headers: auth, body: JSON.stringify({ userId, kind: 'analysis_completed', resourceId: 'an1' }) }),
      deps(),
    )
    assert.equal(appEvent.status, 202)
    const unknownKind = await handleAppEvent(new Request('http://x', { method: 'POST', headers: auth, body: JSON.stringify({ userId, kind: 'chat_reply', resourceId: 'm1' }) }), deps())
    assert.equal(unknownKind.status, 400, 'ordinary chat replies are not a notification type')
    const run = await handleProcess(new Request('http://x', { method: 'POST', headers: auth }), deps())
    assert.equal(run.status, 200)
    const summary = (await run.json()) as { jobs: { done: number } }
    assert.equal(summary.jobs.done, 1)
  })

  test('test notifications require a signed-in user', async () => {
    assert.equal((await handleTestNotification(new Request('http://x', { method: 'POST' }), deps())).status, 401)
    assert.equal((await handleTestNotification(new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer forged' } }), deps())).status, 401)
    const res = await handleTestNotification(new Request('http://x', { method: 'POST', headers: { authorization: 'Bearer valid-user-jwt' } }), deps())
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: 'no_device' })
  })
})
