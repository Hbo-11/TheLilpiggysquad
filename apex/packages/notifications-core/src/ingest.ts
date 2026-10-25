// Validation for updates pushed by trusted motorsport data providers into
// the ingest endpoint. Everything is checked before it touches the database.

import { isSessionType, type SessionType } from './categories.ts'
import { isSafeExternalUrl } from './deepLinks.ts'
import type { SessionStatus, SessionTimeStatus } from './reminders.ts'
import type { IngestKind, Verification } from './sources.ts'
import { isValidTimeZone, parseInstant, parseLocalDateTime, zonedWallTimeToInstant } from './time.ts'

export type EventStatus = 'scheduled' | 'postponed' | 'cancelled' | 'completed'
export type AnnouncementType =
  | 'signing'
  | 'team_change'
  | 'injury'
  | 'absence'
  | 'penalty'
  | 'disqualification'
  | 'technical'
  | 'general'
export type NewsImportance = 'breaking' | 'major' | 'minor'

export interface EntryInput {
  driverRef: string
  driverName: string
  teamRef: string | null
  teamName: string | null
}

export type IngestUpdate =
  | {
      kind: 'event.upsert'
      externalRef: string
      championshipId: string
      name: string
      circuitName: string | null
      country: string | null
      timezone: string
      status: EventStatus
      entries: EntryInput[] | null
    }
  | {
      kind: 'session.upsert'
      externalRef: string
      eventExternalRef: string
      sessionType: SessionType
      name: string
      /** Resolved absolute instant, or null if the time is not yet known. */
      startsAt: string | null
      timeStatus: SessionTimeStatus
      /** Event-local wall time as published by the source, kept for display/audit. */
      localStart: string | null
      timezone: string | null
    }
  | { kind: 'session.status'; externalRef: string; status: SessionStatus }
  | { kind: 'results.published'; sessionExternalRef: string; resultsUrl: string | null }
  | {
      kind: 'announcement'
      externalRef: string
      announcementType: AnnouncementType
      headline: string
      summary: string
      verification: Verification
      driverRefs: string[]
      teamRefs: string[]
      championshipIds: string[]
      url: string | null
      storyKey: string | null
      publishedAt: string
    }
  | {
      kind: 'news'
      externalRef: string
      headline: string
      summary: string
      importance: NewsImportance
      verification: Verification
      driverRefs: string[]
      teamRefs: string[]
      championshipIds: string[]
      url: string | null
      storyKey: string | null
      publishedAt: string
    }

export type IngestValidation = { ok: true; update: IngestUpdate } | { ok: false; errors: string[] }

const REF = /^[A-Za-z0-9_.:-]{1,100}$/
const CHAMPIONSHIP = /^[a-z0-9_-]{1,40}$/

class Checker {
  errors: string[] = []
  src: Record<string, unknown>
  constructor(src: Record<string, unknown>) {
    this.src = src
  }

  ref(key: string): string {
    const v = this.src[key]
    if (typeof v !== 'string' || !REF.test(v)) {
      this.errors.push(`${key} must be an identifier`)
      return ''
    }
    return v
  }
  text(key: string, max: number, required = true): string {
    const v = this.src[key]
    if (v === undefined || v === null || v === '') {
      if (required) this.errors.push(`${key} is required`)
      return ''
    }
    if (typeof v !== 'string') {
      this.errors.push(`${key} must be text`)
      return ''
    }
    const t = v.trim().replace(/\s+/g, ' ')
    if (t.length > max) this.errors.push(`${key} must be at most ${max} characters`)
    return t
  }
  optText(key: string, max: number): string | null {
    return this.text(key, max, false) || null
  }
  oneOf<T extends string>(key: string, values: readonly T[]): T {
    const v = this.src[key]
    if (typeof v !== 'string' || !values.includes(v as T)) {
      this.errors.push(`${key} must be one of ${values.join(', ')}`)
      return values[0]
    }
    return v as T
  }
  refList(key: string, pattern = REF): string[] {
    const v = this.src[key]
    if (v === undefined || v === null) return []
    if (!Array.isArray(v) || v.length > 50 || !v.every((x) => typeof x === 'string' && pattern.test(x))) {
      this.errors.push(`${key} must be a list of identifiers`)
      return []
    }
    return [...new Set(v as string[])]
  }
  url(key: string): string | null {
    const v = this.src[key]
    if (v === undefined || v === null || v === '') return null
    if (!isSafeExternalUrl(v)) {
      this.errors.push(`${key} must be an https URL`)
      return null
    }
    return v
  }
  instant(key: string): string {
    const d = parseInstant(this.src[key])
    if (!d) {
      this.errors.push(`${key} must be an ISO-8601 timestamp with an offset`)
      return new Date(0).toISOString()
    }
    return d.toISOString()
  }
}

export function validateIngestUpdate(input: unknown): IngestValidation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['update must be an object'] }
  const src = input as Record<string, unknown>
  const c = new Checker(src)
  const kind = c.oneOf<IngestKind>('kind', [
    'event.upsert',
    'session.upsert',
    'session.status',
    'results.published',
    'announcement',
    'news',
  ])
  if (c.errors.length) return { ok: false, errors: c.errors }

  let update: IngestUpdate
  switch (kind) {
    case 'event.upsert': {
      const timezone = c.text('timezone', 64)
      if (timezone && !isValidTimeZone(timezone)) c.errors.push('timezone must be an IANA timezone such as Europe/London')
      const championshipId = c.text('championshipId', 40)
      if (championshipId && !CHAMPIONSHIP.test(championshipId)) c.errors.push('championshipId must be a slug')
      let entries: EntryInput[] | null = null
      if (src.entries !== undefined && src.entries !== null) {
        if (!Array.isArray(src.entries) || src.entries.length > 100) c.errors.push('entries must be a list')
        else {
          entries = src.entries.map((e, i) => {
            const ec = new Checker((e ?? {}) as Record<string, unknown>)
            const entry = {
              driverRef: ec.ref('driverRef'),
              driverName: ec.text('driverName', 100),
              teamRef: ec.optText('teamRef', 100),
              teamName: ec.optText('teamName', 100),
            }
            if (entry.teamRef && !REF.test(entry.teamRef)) ec.errors.push('teamRef must be an identifier')
            c.errors.push(...ec.errors.map((m) => `entries[${i}].${m}`))
            return entry
          })
        }
      }
      update = {
        kind,
        externalRef: c.ref('externalRef'),
        championshipId,
        name: c.text('name', 120),
        circuitName: c.optText('circuitName', 120),
        country: c.optText('country', 80),
        timezone,
        status: c.oneOf<EventStatus>('status', ['scheduled', 'postponed', 'cancelled', 'completed']),
        entries,
      }
      break
    }
    case 'session.upsert': {
      const sessionType = src.sessionType
      if (!isSessionType(sessionType)) c.errors.push('sessionType is not recognised')
      const timeStatus = c.oneOf<SessionTimeStatus>('timeStatus', ['confirmed', 'provisional', 'tbc'])
      const timezone = c.optText('timezone', 64)
      if (timezone && !isValidTimeZone(timezone)) c.errors.push('timezone must be an IANA timezone')
      const localStart = c.optText('localStart', 19)
      let startsAt: string | null = null
      if (src.startsAt !== undefined && src.startsAt !== null) startsAt = c.instant('startsAt')
      if (localStart) {
        const wall = parseLocalDateTime(localStart)
        if (!wall) c.errors.push('localStart must be YYYY-MM-DDTHH:mm')
        else if (!timezone) c.errors.push('timezone is required with localStart')
        else if (isValidTimeZone(timezone)) {
          const resolved = zonedWallTimeToInstant(wall, timezone)
          if (resolved.resolution === 'skipped') {
            c.errors.push(`localStart ${localStart} does not exist in ${timezone} (daylight-saving gap)`)
          } else if (startsAt) {
            const later = zonedWallTimeToInstant(wall, timezone, 'later').instant.getTime()
            const t = new Date(startsAt).getTime()
            if (t !== resolved.instant.getTime() && t !== later) {
              c.errors.push('startsAt and localStart disagree; refusing to guess which is correct')
            }
          } else if (resolved.resolution === 'ambiguous') {
            c.errors.push(`localStart ${localStart} occurs twice in ${timezone}; send startsAt with an offset`)
          } else {
            startsAt = resolved.instant.toISOString()
          }
        }
      }
      if (timeStatus !== 'tbc' && !startsAt) c.errors.push('startsAt or localStart is required unless timeStatus is tbc')
      update = {
        kind,
        externalRef: c.ref('externalRef'),
        eventExternalRef: c.ref('eventExternalRef'),
        sessionType: (isSessionType(sessionType) ? sessionType : 'other') as SessionType,
        name: c.text('name', 80),
        startsAt: timeStatus === 'tbc' ? null : startsAt,
        timeStatus,
        localStart,
        timezone,
      }
      break
    }
    case 'session.status':
      update = {
        kind,
        externalRef: c.ref('externalRef'),
        status: c.oneOf<SessionStatus>('status', ['scheduled', 'live', 'finished', 'cancelled', 'postponed']),
      }
      break
    case 'results.published':
      if (src.official !== true) c.errors.push('results must be marked official: true')
      update = { kind, sessionExternalRef: c.ref('sessionExternalRef'), resultsUrl: c.url('resultsUrl') }
      break
    case 'announcement':
    case 'news': {
      const common = {
        externalRef: c.ref('externalRef'),
        headline: c.text('headline', 140),
        summary: c.text('summary', 600),
        verification: c.oneOf<Verification>('verification', ['confirmed', 'reported', 'rumour']),
        driverRefs: c.refList('driverRefs'),
        teamRefs: c.refList('teamRefs'),
        championshipIds: c.refList('championshipIds', CHAMPIONSHIP),
        url: c.url('url'),
        storyKey: c.optText('storyKey', 100),
        publishedAt: c.instant('publishedAt'),
      }
      if (kind === 'announcement') {
        if (common.driverRefs.length === 0 && common.teamRefs.length === 0) {
          c.errors.push('announcement must name at least one driver or team')
        }
        update = {
          kind,
          ...common,
          announcementType: c.oneOf<AnnouncementType>('announcementType', [
            'signing',
            'team_change',
            'injury',
            'absence',
            'penalty',
            'disqualification',
            'technical',
            'general',
          ]),
        }
      } else {
        update = { kind, ...common, importance: c.oneOf<NewsImportance>('importance', ['breaking', 'major', 'minor']) }
      }
      break
    }
  }
  return c.errors.length ? { ok: false, errors: c.errors } : { ok: true, update }
}

/** Constant-time comparison of hex HMAC signatures for the ingest webhook. */
export async function verifyHmacSignature(secret: string, body: string, signatureHeader: string | null): Promise<boolean> {
  if (!secret || !signatureHeader) return false
  const provided = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader
  if (!/^[0-9a-f]{64}$/i.test(provided)) return false
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)))
  const expected = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
  let diff = 0
  const a = provided.toLowerCase()
  for (let i = 0; i < expected.length; i++) diff |= a.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

export async function signHmac(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(body)))
  return 'sha256=' + [...sig].map((b) => b.toString(16).padStart(2, '0')).join('')
}
