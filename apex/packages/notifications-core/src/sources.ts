// Data accuracy rules. Notifications are only created from trusted sources, and only
// confirmed information is ever presented as confirmed. Rumours are never pushed.

export type TrustLevel = 'official' | 'licensed_provider' | 'trusted_media' | 'unverified'
export type Verification = 'confirmed' | 'reported' | 'rumour'

export interface DataSource {
  id: string
  trustLevel: TrustLevel
  active: boolean
}

export type IngestKind =
  | 'event.upsert'
  | 'session.upsert'
  | 'session.status'
  | 'results.published'
  | 'announcement'
  | 'news'

/**
 * Which source trust levels may publish each kind of update.
 * Schedules, session status and results must come from the championship itself or a
 * licensed data provider. Announcements and news may also come from trusted media,
 * but must be marked confirmed to notify.
 */
const ALLOWED: Record<IngestKind, TrustLevel[]> = {
  'event.upsert': ['official', 'licensed_provider'],
  'session.upsert': ['official', 'licensed_provider'],
  'session.status': ['official', 'licensed_provider'],
  'results.published': ['official', 'licensed_provider'],
  announcement: ['official', 'licensed_provider', 'trusted_media'],
  news: ['official', 'licensed_provider', 'trusted_media'],
}

export type SourceCheck = { ok: true } | { ok: false; reason: string }

export function checkSourceAllowed(source: DataSource | null | undefined, kind: IngestKind): SourceCheck {
  if (!source) return { ok: false, reason: 'unknown_source' }
  if (!source.active) return { ok: false, reason: 'source_inactive' }
  if (!ALLOWED[kind].includes(source.trustLevel)) return { ok: false, reason: `source_not_trusted_for_${kind}` }
  return { ok: true }
}

/** Only confirmed announcements and news trigger notifications. Stored-but-unconfirmed items never notify. */
export function canNotifyVerification(verification: Verification): boolean {
  return verification === 'confirmed'
}
