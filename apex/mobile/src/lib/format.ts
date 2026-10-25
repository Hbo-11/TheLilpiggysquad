import { formatDateTimeInZone } from '@apex/notifications-core'

export function timeAgo(iso: string, now = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'Just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d} d ago`
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** Absolute timestamp with the timezone named, for accessibility and detail views. */
export function stamp(iso: string, timeZone: string): string {
  return formatDateTimeInZone(new Date(iso), timeZone)
}

export function friendlyZone(tz: string): string {
  return tz.replace(/_/g, ' ')
}
