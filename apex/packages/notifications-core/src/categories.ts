// Notification categories, session types and reminder offsets shared by the
// mobile app, the server pipeline and the database (see the migration, which
// mirrors these values in CHECK constraints and the notification_categories table).

export const NOTIFICATION_CATEGORIES = [
  'race_reminders',
  'schedule_changes',
  'race_results',
  'driver_updates',
  'team_updates',
  'news_major',
  'news_breaking',
  'ai_tasks',
  'track_lab',
  'sim_racing',
  'weekly_summary',
  'product_updates',
  'account_security',
  'system',
] as const

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]

/** Categories a user can switch off. Security and system messages are handled separately. */
export const OPTIONAL_CATEGORIES = [
  'race_reminders',
  'schedule_changes',
  'race_results',
  'driver_updates',
  'team_updates',
  'news_major',
  'news_breaking',
  'ai_tasks',
  'track_lab',
  'sim_racing',
  'weekly_summary',
  'product_updates',
] as const satisfies readonly NotificationCategory[]

export type OptionalCategory = (typeof OPTIONAL_CATEGORIES)[number]

/**
 * critical: never deferred or rate limited (account security).
 * time_sensitive: tied to a session start; quiet hours follow the user's reminder policy.
 * normal: deferred until quiet hours end and subject to rate limits.
 * low: deferred, rate limited and collapsed aggressively.
 */
export type NotificationPriority = 'critical' | 'time_sensitive' | 'normal' | 'low'

export type SettingsGroup =
  | 'race_reminders'
  | 'championships'
  | 'drivers'
  | 'teams'
  | 'news'
  | 'apex_ai'
  | 'track_lab'
  | 'sim_racing'
  | 'weekly_summaries'
  | 'account'

export interface CategoryInfo {
  label: string
  description: string
  optional: boolean
  priority: NotificationPriority
  group: SettingsGroup
  /** Android notification channel id. Channels are created on the device at start-up. */
  androidChannel: string
  /** Icon name from @expo/vector-icons Ionicons. */
  icon: string
  /** Marked as a later-version feature in the settings UI. */
  availability: 'available' | 'later'
}

export const CATEGORY_INFO: Record<NotificationCategory, CategoryInfo> = {
  race_reminders: {
    label: 'Session reminders',
    description: 'Reminders before practice, qualifying, sprint and race sessions you follow.',
    optional: true,
    priority: 'time_sensitive',
    group: 'race_reminders',
    androidChannel: 'race-reminders',
    icon: 'alarm-outline',
    availability: 'available',
  },
  schedule_changes: {
    label: 'Schedule changes',
    description: 'Confirmed postponements, cancellations and rescheduled sessions.',
    optional: true,
    priority: 'time_sensitive',
    group: 'race_reminders',
    androidChannel: 'schedule-changes',
    icon: 'calendar-outline',
    availability: 'available',
  },
  race_results: {
    label: 'Official results',
    description: 'When official qualifying and race classifications are published.',
    optional: true,
    priority: 'normal',
    group: 'championships',
    androidChannel: 'results',
    icon: 'flag-outline',
    availability: 'available',
  },
  driver_updates: {
    label: 'Followed drivers',
    description: 'Confirmed announcements, penalties and results for drivers you follow.',
    optional: true,
    priority: 'normal',
    group: 'drivers',
    androidChannel: 'drivers-teams',
    icon: 'person-outline',
    availability: 'available',
  },
  team_updates: {
    label: 'Followed teams',
    description: 'Official team announcements, signings and technical news.',
    optional: true,
    priority: 'normal',
    group: 'teams',
    androidChannel: 'drivers-teams',
    icon: 'people-outline',
    availability: 'available',
  },
  news_major: {
    label: 'Major headlines',
    description: 'Important championship, regulation and calendar news. Minor stories are never pushed.',
    optional: true,
    priority: 'low',
    group: 'news',
    androidChannel: 'news',
    icon: 'newspaper-outline',
    availability: 'available',
  },
  news_breaking: {
    label: 'Breaking news',
    description: 'Verified breaking news from trusted sources, including significant safety developments.',
    optional: true,
    priority: 'normal',
    group: 'news',
    androidChannel: 'news',
    icon: 'flash-outline',
    availability: 'available',
  },
  ai_tasks: {
    label: 'Apex AI tasks',
    description: 'Race summaries, analysis jobs, reports and exports you requested. Ordinary chat replies are never pushed.',
    optional: true,
    priority: 'normal',
    group: 'apex_ai',
    androidChannel: 'apex-ai',
    icon: 'sparkles-outline',
    availability: 'available',
  },
  track_lab: {
    label: 'Track Lab',
    description: 'Track-generation tasks and project exports you started.',
    optional: true,
    priority: 'normal',
    group: 'track_lab',
    androidChannel: 'apex-ai',
    icon: 'git-network-outline',
    availability: 'available',
  },
  sim_racing: {
    label: 'Sim racing',
    description: 'Practice reminders, session analysis and milestones you opt into.',
    optional: true,
    priority: 'low',
    group: 'sim_racing',
    androidChannel: 'sim-racing',
    icon: 'game-controller-outline',
    availability: 'later',
  },
  weekly_summary: {
    label: 'Weekly summary',
    description: 'A short weekly recap of your followed championships.',
    optional: true,
    priority: 'low',
    group: 'weekly_summaries',
    androidChannel: 'summaries',
    icon: 'document-text-outline',
    availability: 'later',
  },
  product_updates: {
    label: 'Apex AI updates',
    description: 'Important app and project updates. Off unless you switch it on.',
    optional: true,
    priority: 'low',
    group: 'apex_ai',
    androidChannel: 'apex-ai',
    icon: 'information-circle-outline',
    availability: 'available',
  },
  account_security: {
    label: 'Account security',
    description: 'Password, email and sign-in changes. Always on so you can spot unexpected activity.',
    optional: false,
    priority: 'critical',
    group: 'account',
    androidChannel: 'security',
    icon: 'shield-checkmark-outline',
    availability: 'available',
  },
  system: {
    label: 'Apex AI',
    description: 'Test notifications and delivery troubleshooting.',
    optional: false,
    priority: 'normal',
    group: 'account',
    androidChannel: 'default',
    icon: 'notifications-outline',
    availability: 'available',
  },
}

export const ANDROID_CHANNELS: { id: string; name: string; importance: 'high' | 'default' | 'low' }[] = [
  { id: 'race-reminders', name: 'Session reminders', importance: 'high' },
  { id: 'schedule-changes', name: 'Schedule changes', importance: 'high' },
  { id: 'results', name: 'Official results', importance: 'default' },
  { id: 'drivers-teams', name: 'Drivers and teams', importance: 'default' },
  { id: 'news', name: 'Motorsport news', importance: 'default' },
  { id: 'apex-ai', name: 'Apex AI and Track Lab', importance: 'default' },
  { id: 'sim-racing', name: 'Sim racing', importance: 'low' },
  { id: 'summaries', name: 'Weekly summaries', importance: 'low' },
  { id: 'security', name: 'Account security', importance: 'high' },
  { id: 'default', name: 'General', importance: 'default' },
]

export const SESSION_TYPES = [
  'practice',
  'qualifying',
  'sprint_qualifying',
  'sprint',
  'race',
  'other',
] as const

export type SessionType = (typeof SESSION_TYPES)[number]

export const SESSION_TYPE_LABELS: Record<SessionType, string> = {
  practice: 'Practice',
  qualifying: 'Qualifying',
  sprint_qualifying: 'Sprint qualifying',
  sprint: 'Sprint',
  race: 'Race',
  other: 'Other sessions',
}

/** Minutes before session start. 0 means "at session start". */
export const REMINDER_OFFSETS = [1440, 60, 30, 15, 0] as const
export type ReminderOffset = (typeof REMINDER_OFFSETS)[number]

export const REMINDER_OFFSET_LABELS: Record<ReminderOffset, string> = {
  1440: '24 hours before',
  60: '1 hour before',
  30: '30 minutes before',
  15: '15 minutes before',
  0: 'At session start',
}

export function isNotificationCategory(value: unknown): value is NotificationCategory {
  return typeof value === 'string' && (NOTIFICATION_CATEGORIES as readonly string[]).includes(value)
}

export function isOptionalCategory(value: unknown): value is OptionalCategory {
  return typeof value === 'string' && (OPTIONAL_CATEGORIES as readonly string[]).includes(value)
}

export function isSessionType(value: unknown): value is SessionType {
  return typeof value === 'string' && (SESSION_TYPES as readonly string[]).includes(value)
}

export function isReminderOffset(value: unknown): value is ReminderOffset {
  return typeof value === 'number' && (REMINDER_OFFSETS as readonly number[]).includes(value)
}
