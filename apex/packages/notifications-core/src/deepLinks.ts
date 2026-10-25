// Safe internal deep links. Notifications carry a path such as "/events/<id>", never a
// full external URL. Both the server (when creating a notification) and the app (when
// one is opened) validate it against this allow-list, so a tampered payload cannot
// navigate to an arbitrary screen or open an external site.

export type AppRoute =
  | { screen: 'event'; id: string }
  | { screen: 'driver'; id: string }
  | { screen: 'team'; id: string }
  | { screen: 'article'; id: string }
  | { screen: 'ai_analysis'; id: string }
  | { screen: 'ai_report'; id: string }
  | { screen: 'track_project'; id: string }
  | { screen: 'notification_settings' }
  | { screen: 'account_security' }
  | { screen: 'notifications' }

export type AppScreen = AppRoute['screen']

const ID = '([A-Za-z0-9_-]{1,64})'

const PATTERNS: { screen: AppScreen; re: RegExp; build: (id?: string) => string }[] = [
  { screen: 'event', re: new RegExp(`^/events/${ID}$`), build: (id) => `/events/${id}` },
  { screen: 'driver', re: new RegExp(`^/drivers/${ID}$`), build: (id) => `/drivers/${id}` },
  { screen: 'team', re: new RegExp(`^/teams/${ID}$`), build: (id) => `/teams/${id}` },
  { screen: 'article', re: new RegExp(`^/news/${ID}$`), build: (id) => `/news/${id}` },
  { screen: 'ai_analysis', re: new RegExp(`^/ai/analyses/${ID}$`), build: (id) => `/ai/analyses/${id}` },
  { screen: 'ai_report', re: new RegExp(`^/ai/reports/${ID}$`), build: (id) => `/ai/reports/${id}` },
  { screen: 'track_project', re: new RegExp(`^/track-lab/projects/${ID}$`), build: (id) => `/track-lab/projects/${id}` },
  { screen: 'notification_settings', re: /^\/settings\/notifications$/, build: () => '/settings/notifications' },
  { screen: 'account_security', re: /^\/account\/security$/, build: () => '/account/security' },
  { screen: 'notifications', re: /^\/notifications$/, build: () => '/notifications' },
]

export const APP_SCHEME = 'apexai'

/** Fallback when a notification has no valid destination: the notification centre, not Home. */
export const FALLBACK_PATH = '/notifications'

export function buildDeepLinkPath(route: AppRoute): string {
  const pattern = PATTERNS.find((p) => p.screen === route.screen)
  if (!pattern) throw new Error(`Unknown screen ${route.screen}`)
  const path = pattern.build('id' in route ? route.id : undefined)
  if (!parseDeepLink(path)) throw new Error(`Invalid id for ${route.screen}`)
  return path
}

/**
 * Accepts "/events/abc", "apexai://events/abc" or "apexai:///events/abc".
 * Returns null for anything not on the allow-list (other schemes, hosts, traversal,
 * query strings, encoded characters, over-long ids).
 */
export function parseDeepLink(input: unknown): AppRoute | null {
  if (typeof input !== 'string' || input.length === 0 || input.length > 200) return null
  let path: string
  if (input.startsWith('/')) {
    if (input.startsWith('//')) return null
    path = input
  } else if (input.startsWith(`${APP_SCHEME}://`)) {
    const rest = input.slice(APP_SCHEME.length + 3)
    path = rest.startsWith('/') ? rest : `/${rest}`
  } else {
    return null
  }
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1)
  for (const p of PATTERNS) {
    const m = p.re.exec(path)
    if (!m) continue
    if (m[1] !== undefined) return { screen: p.screen, id: m[1] } as AppRoute
    return { screen: p.screen } as AppRoute
  }
  return null
}

/** Resolve the screen to open for a notification payload; never throws. */
export function resolveNotificationPath(data: unknown): { path: string; valid: boolean } {
  const url = data && typeof data === 'object' ? (data as Record<string, unknown>).url : undefined
  const route = parseDeepLink(url)
  if (!route) return { path: FALLBACK_PATH, valid: false }
  return { path: buildDeepLinkPath(route), valid: true }
}

/** External source links shown on article screens: https only, no credentials in the URL. */
export function isSafeExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false
  try {
    const u = new URL(value)
    return u.protocol === 'https:' && !u.username && !u.password && u.hostname.includes('.')
  } catch {
    return false
  }
}
