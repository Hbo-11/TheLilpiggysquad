// Minimal Expo Push Service client (https://docs.expo.dev/push-notifications/sending-notifications/).
// `fetch` is injected so the server can run it in Deno/Node and tests can stub it.

export const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send'
export const EXPO_PUSH_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'
export const EXPO_SEND_CHUNK = 100
export const EXPO_RECEIPT_CHUNK = 1000

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

export interface ExpoPushMessage {
  to: string
  title: string
  body: string
  data: Record<string, unknown>
  sound?: 'default' | null
  channelId?: string
  priority?: 'default' | 'normal' | 'high'
  /** Seconds the push service keeps trying to deliver. */
  ttl?: number
  /** iOS notification grouping. */
  threadId?: string
  /** iOS 15+: time-sensitive reminders break through Focus when the user allows it. */
  interruptionLevel?: 'active' | 'passive' | 'time-sensitive'
}

export function isExpoPushToken(token: unknown): token is string {
  return typeof token === 'string' && /^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]{8,200}\]$/.test(token)
}

/** Errors that mean the token will never work again and the device must be deregistered. */
export const PERMANENT_TOKEN_ERRORS = new Set(['DeviceNotRegistered'])
/** Errors worth retrying later. */
export const RETRYABLE_ERRORS = new Set(['MessageRateExceeded', 'HTTP_429', 'HTTP_5XX', 'NETWORK', 'ExpoServerError'])

export type SendResult =
  | { status: 'ok'; ticketId: string }
  | { status: 'error'; errorCode: string; message: string; retryable: boolean; invalidToken: boolean }

function classify(errorCode: string, message: string): Extract<SendResult, { status: 'error' }> {
  return {
    status: 'error',
    errorCode,
    message: message.slice(0, 500),
    retryable: RETRYABLE_ERRORS.has(errorCode),
    invalidToken: PERMANENT_TOKEN_ERRORS.has(errorCode),
  }
}

function headers(accessToken?: string): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/json',
    'accept-encoding': 'gzip, deflate',
    'content-type': 'application/json',
  }
  if (accessToken) h.authorization = `Bearer ${accessToken}`
  return h
}

/**
 * Send messages in chunks of 100. Returns one result per input message, in order.
 * Transport failures (network, 429, 5xx) are marked retryable for the whole chunk.
 */
export async function sendExpoPush(
  messages: ExpoPushMessage[],
  opts: { fetch: FetchLike; accessToken?: string },
): Promise<SendResult[]> {
  const results: SendResult[] = []
  for (let i = 0; i < messages.length; i += EXPO_SEND_CHUNK) {
    const chunk = messages.slice(i, i + EXPO_SEND_CHUNK)
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await opts.fetch(EXPO_PUSH_SEND_URL, {
        method: 'POST',
        headers: headers(opts.accessToken),
        body: JSON.stringify(chunk),
      })
    } catch (err) {
      results.push(...chunk.map(() => classify('NETWORK', String(err))))
      continue
    }
    if (res.status === 429 || res.status >= 500) {
      const text = await res.text().catch(() => '')
      results.push(...chunk.map(() => classify(res.status === 429 ? 'HTTP_429' : 'HTTP_5XX', text || `HTTP ${res.status}`)))
      continue
    }
    let payload: { data?: unknown; errors?: { code?: string; message?: string }[] }
    try {
      payload = (await res.json()) as typeof payload
    } catch {
      results.push(...chunk.map(() => classify('BAD_RESPONSE', `Unparseable response (HTTP ${res.status})`)))
      continue
    }
    if (res.status >= 400 || !Array.isArray(payload.data)) {
      const err = payload.errors?.[0]
      results.push(...chunk.map(() => classify(err?.code ?? `HTTP_${res.status}`, err?.message ?? 'Request rejected')))
      continue
    }
    const tickets = payload.data as { status: string; id?: string; message?: string; details?: { error?: string } }[]
    chunk.forEach((_, j) => {
      const t = tickets[j]
      if (!t) results.push(classify('MISSING_TICKET', 'No ticket returned for message'))
      else if (t.status === 'ok' && t.id) results.push({ status: 'ok', ticketId: t.id })
      else results.push(classify(t.details?.error ?? 'UNKNOWN', t.message ?? 'Push rejected'))
    })
  }
  return results
}

export type ReceiptResult =
  | { status: 'ok' }
  | { status: 'error'; errorCode: string; message: string; invalidToken: boolean }
  | { status: 'pending' }

/** Fetch delivery receipts. Missing receipts are reported as pending (Expo keeps them ~24h). */
export async function getExpoReceipts(
  ticketIds: string[],
  opts: { fetch: FetchLike; accessToken?: string },
): Promise<Map<string, ReceiptResult>> {
  const out = new Map<string, ReceiptResult>()
  for (let i = 0; i < ticketIds.length; i += EXPO_RECEIPT_CHUNK) {
    const ids = ticketIds.slice(i, i + EXPO_RECEIPT_CHUNK)
    const res = await opts.fetch(EXPO_PUSH_RECEIPTS_URL, {
      method: 'POST',
      headers: headers(opts.accessToken),
      body: JSON.stringify({ ids }),
    })
    if (res.status !== 200) throw new Error(`Expo receipts request failed: HTTP ${res.status}`)
    const payload = (await res.json()) as { data?: Record<string, { status: string; message?: string; details?: { error?: string } }> }
    for (const id of ids) {
      const r = payload.data?.[id]
      if (!r) out.set(id, { status: 'pending' })
      else if (r.status === 'ok') out.set(id, { status: 'ok' })
      else {
        const code = r.details?.error ?? 'UNKNOWN'
        out.set(id, { status: 'error', errorCode: code, message: (r.message ?? '').slice(0, 500), invalidToken: PERMANENT_TOKEN_ERRORS.has(code) })
      }
    }
  }
  return out
}

export const RETRY_POLICY = { maxAttempts: 5, baseDelayMs: 30_000, maxDelayMs: 30 * 60_000 }

/** Exponential backoff with full jitter. `random` is injectable for deterministic tests. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const exp = Math.min(RETRY_POLICY.maxDelayMs, RETRY_POLICY.baseDelayMs * 2 ** Math.max(0, attempt - 1))
  return Math.round(exp / 2 + random() * (exp / 2))
}
