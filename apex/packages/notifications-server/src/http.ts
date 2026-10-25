// Request handlers for the Supabase Edge Functions. They use only Web-standard
// Request/Response so the same code runs in Deno (production) and Node (tests).

import { APP_EVENT_KINDS, verifyHmacSignature, type AppEventKind, type FetchLike } from '@apex/notifications-core'
import type { Db } from './db.ts'
import { checkReceipts, dispatchDeliveries, type PushTransport } from './dispatch.ts'
import { ingestUpdate } from './ingest.ts'
import { processJobs, queueAppEvent } from './jobs.ts'
import { scanReminders } from './reminders.ts'
import { sendTestNotification } from './testNotification.ts'

export interface HandlerDeps {
  db: Db
  env: (name: string) => string | undefined
  /** Used for Expo and Supabase Auth calls. */
  fetch: typeof globalThis.fetch
  now?: () => Date
}

const MAX_BODY_BYTES = 64 * 1024

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Internal endpoints (cron, other backend services) authenticate with APEX_INTERNAL_SECRET. */
function isInternal(req: Request, deps: HandlerDeps): boolean {
  const secret = deps.env('APEX_INTERNAL_SECRET')
  const header = req.headers.get('authorization') ?? ''
  return !!secret && secret.length >= 32 && timingSafeEqual(header, `Bearer ${secret}`)
}

function transport(deps: HandlerDeps): PushTransport {
  return { fetch: deps.fetch as unknown as FetchLike, accessToken: deps.env('EXPO_ACCESS_TOKEN') || undefined }
}

async function readBody(req: Request): Promise<string | null> {
  const text = await req.text()
  return new TextEncoder().encode(text).length > MAX_BODY_BYTES ? null : text
}

/** Resolve the calling user from their Supabase access token via the Auth API. */
async function authenticatedUserId(req: Request, deps: HandlerDeps): Promise<string | null> {
  const auth = req.headers.get('authorization')
  const url = deps.env('SUPABASE_URL')
  const anonKey = deps.env('SUPABASE_ANON_KEY')
  if (!auth?.startsWith('Bearer ') || !url || !anonKey) return null
  const res = await deps.fetch(`${url}/auth/v1/user`, { headers: { authorization: auth, apikey: anonKey } })
  if (res.status !== 200) return null
  const user = (await res.json()) as { id?: string }
  return typeof user.id === 'string' ? user.id : null
}

/**
 * POST /ingest-motorsport-update
 * Headers: x-apex-source: <data_sources.id>, x-apex-signature: sha256=<hex HMAC of body>
 * Secrets per source come from INGEST_SOURCE_SECRETS (JSON object {sourceId: secret}).
 */
export async function handleIngest(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' })
  const sourceId = req.headers.get('x-apex-source') ?? ''
  let secrets: Record<string, string> = {}
  try {
    secrets = JSON.parse(deps.env('INGEST_SOURCE_SECRETS') ?? '{}')
  } catch {
    return json(500, { error: 'ingest_not_configured' })
  }
  const secret = secrets[sourceId]
  const body = await readBody(req)
  if (body === null) return json(413, { error: 'payload_too_large' })
  if (!secret || !(await verifyHmacSignature(secret, body, req.headers.get('x-apex-signature')))) {
    return json(401, { error: 'invalid_signature' })
  }
  let payload: unknown
  try {
    payload = JSON.parse(body)
  } catch {
    return json(400, { error: 'invalid_json' })
  }
  const updates = Array.isArray(payload) ? payload.slice(0, 200) : [payload]
  const now = deps.now?.() ?? new Date()
  const results = []
  for (const u of updates) results.push(await ingestUpdate(deps.db, { sourceId, payload: u, now }))
  const rejected = results.filter((r) => r.outcome === 'rejected').length
  return json(rejected === results.length ? 422 : 200, { results })
}

/** POST /process-notifications (cron, every minute): jobs, reminders, then dispatch. */
export async function handleProcess(req: Request, deps: HandlerDeps): Promise<Response> {
  if (!isInternal(req, deps)) return json(401, { error: 'unauthorized' })
  const now = deps.now?.() ?? new Date()
  const jobs = await processJobs(deps.db, { now })
  const reminders = await scanReminders(deps.db, { now })
  const dispatch = await dispatchDeliveries(deps.db, { now, transport: transport(deps) })
  return json(200, { jobs, reminders, dispatch })
}

/** POST /check-push-receipts (cron, every 15 minutes). */
export async function handleReceipts(req: Request, deps: HandlerDeps): Promise<Response> {
  if (!isInternal(req, deps)) return json(401, { error: 'unauthorized' })
  const now = deps.now?.() ?? new Date()
  return json(200, await checkReceipts(deps.db, { now, transport: transport(deps) }))
}

/**
 * POST /notify-app-event (other Apex AI backend services only).
 * Body: { userId, kind, resourceId }. Never callable from the mobile app.
 */
export async function handleAppEvent(req: Request, deps: HandlerDeps): Promise<Response> {
  if (!isInternal(req, deps)) return json(401, { error: 'unauthorized' })
  const body = await readBody(req)
  if (body === null) return json(413, { error: 'payload_too_large' })
  let p: { userId?: unknown; kind?: unknown; resourceId?: unknown }
  try {
    p = JSON.parse(body)
  } catch {
    return json(400, { error: 'invalid_json' })
  }
  if (!(APP_EVENT_KINDS as readonly unknown[]).includes(p.kind)) return json(400, { error: 'unknown_kind' })
  try {
    const queued = await queueAppEvent(deps.db, { userId: String(p.userId), kind: p.kind as AppEventKind, resourceId: String(p.resourceId) })
    return json(202, { queued })
  } catch (err) {
    return json(400, { error: String(err instanceof Error ? err.message : err) })
  }
}

/** POST /send-test-notification (signed-in user; sends only to their own devices). */
export async function handleTestNotification(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 })
  const userId = await authenticatedUserId(req, deps)
  if (!userId) return json(401, { error: 'unauthorized' })
  const now = deps.now?.() ?? new Date()
  const result = await sendTestNotification(deps.db, { userId, now, transport: transport(deps), requestId: crypto.randomUUID() })
  const status = result.status === 'rate_limited' ? 429 : 200
  return json(status, { status: result.status })
}
