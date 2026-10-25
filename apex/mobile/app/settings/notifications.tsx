// Settings > Notifications. Preferences save automatically and are enforced by the
// server when it creates and sends notifications, not just hidden in the app.

import {
  CATEGORY_INFO,
  REMINDER_OFFSETS,
  REMINDER_OFFSET_LABELS,
  SESSION_TYPES,
  SESSION_TYPE_LABELS,
  describeQuietHoursPolicy,
  disableAllOptionalNotifications,
  enableAllNotifications,
  isValidTimeZone,
  parseClockTime,
  recommendedPreferences,
  sortOffsets,
  type NotificationPreferences,
  type OptionalCategory,
  type QuietHoursReminderPolicy,
  type ReminderOffset,
} from '@apex/notifications-core'
import { useRouter } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import { Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Badge, Button, Chip, Loading, Notice, Row, Screen, Section, StatusRow, ToggleRow, type IconName, type StatusTone } from '../../src/components/ui.tsx'
import { PermissionPrimer } from '../../src/components/PermissionPrimer.tsx'
import { getSystemStatus, listChampionships, listDrivers, listTeams, sendServerTestNotification, type Championship, type NamedEntity, type SystemStatus } from '../../src/data/motorsport.ts'
import { useAuth } from '../../src/lib/auth.tsx'
import { backendConfigured } from '../../src/lib/backend.ts'
import { friendlyZone, timeAgo } from '../../src/lib/format.ts'
import { isNativePlatform, scheduleLocalTestNotification } from '../../src/notifications/expoPlatform.ts'
import { useNotifications } from '../../src/notifications/NotificationsProvider.tsx'
import { describeRegistration } from '../../src/notifications/registration.ts'
import { colors, radius, spacing, type } from '../../src/theme.ts'

const COMMON_ZONES = [
  'UTC', 'Europe/London', 'Europe/Paris', 'Europe/Madrid', 'Europe/Rome', 'Europe/Berlin', 'Europe/Amsterdam', 'Europe/Monaco',
  'Europe/Istanbul', 'Asia/Dubai', 'Asia/Qatar', 'Asia/Riyadh', 'Asia/Baku', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Shanghai',
  'Asia/Tokyo', 'Australia/Melbourne', 'Australia/Sydney', 'Australia/Perth', 'Pacific/Auckland', 'America/New_York',
  'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Indiana/Indianapolis', 'America/Toronto',
  'America/Mexico_City', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'Africa/Johannesburg',
]

function allZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
  try {
    return intl.supportedValuesOf?.('timeZone') ?? COMMON_ZONES
  } catch {
    return COMMON_ZONES
  }
}

function shiftClock(value: string, minutes: number): string {
  const m = ((parseClockTime(value) ?? 0) + minutes + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** Move one end of the quiet-hours window, skipping over the other end (they must differ). */
function shiftQuiet(p: NotificationPreferences, edge: 'start' | 'end', minutes: number): NotificationPreferences {
  const other = edge === 'start' ? p.quietHours.end : p.quietHours.start
  let next = shiftClock(p.quietHours[edge], minutes)
  if (next === other) next = shiftClock(next, minutes)
  return { ...p, quietHours: { ...p.quietHours, [edge]: next } }
}

function CategoryToggle({ category, prefs, update, last }: { category: OptionalCategory; prefs: NotificationPreferences; update: (fn: (p: NotificationPreferences) => NotificationPreferences) => void; last?: boolean }) {
  const info = CATEGORY_INFO[category]
  const later = info.availability === 'later'
  return (
    <ToggleRow
      icon={info.icon as IconName}
      label={info.label}
      description={later ? `${info.description} Saved now; these notifications arrive in a later version.` : info.description}
      badge={later ? 'LATER' : undefined}
      value={prefs.categories[category]}
      onChange={(v) => update((p) => ({ ...p, categories: { ...p.categories, [category]: v } }))}
      last={last}
    />
  )
}

export default function NotificationSettings() {
  const router = useRouter()
  const { userId } = useAuth()
  const n = useNotifications()
  const { prefs, updatePrefs: update } = n
  const [primer, setPrimer] = useState(false)
  const [status, setStatus] = useState<SystemStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [championships, setChampionships] = useState<Championship[]>([])
  const [drivers, setDrivers] = useState<NamedEntity[]>([])
  const [teams, setTeams] = useState<NamedEntity[]>([])
  const [entitySearch, setEntitySearch] = useState('')
  const [zoneSearch, setZoneSearch] = useState('')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  useEffect(() => {
    getSystemStatus().then(setStatus).catch((e) => setStatusError(String(e.message ?? e)))
    listChampionships().then(setChampionships).catch(() => {})
    listDrivers().then(setDrivers).catch(() => {})
    listTeams().then(setTeams).catch(() => {})
  }, [])

  const zones = useMemo(allZones, [])
  const zoneMatches = useMemo(() => {
    const q = zoneSearch.trim().toLowerCase().replace(/ /g, '_')
    return q ? zones.filter((z) => z.toLowerCase().includes(q)).slice(0, 12) : []
  }, [zoneSearch, zones])

  if (!prefs) {
    return n.prefsError ? (
      <Screen>
        <Notice tone="warning">
          <Text style={type.small}>Couldn't load your preferences: {n.prefsError}</Text>
        </Notice>
      </Screen>
    ) : (
      <Loading label="Loading preferences" />
    )
  }

  const followed = (type_: 'championship' | 'driver' | 'team', id: string) => n.follows.some((f) => f.entity_type === type_ && f.entity_id === id)
  const enabledCount = Object.values(prefs.categories).filter(Boolean).length
  const reg = describeRegistration(n.registration, n.permission)

  // ---- Status panel (four separate things that are easy to confuse) ----
  const appTone: StatusTone = enabledCount ? 'ok' : 'off'
  const permTone: StatusTone = reg.needsSettings ? 'error' : n.permission?.status === 'granted' || n.permission?.provisional ? 'ok' : reg.canRequest ? 'warn' : 'off'
  let serverTone: StatusTone = 'off'
  let serverValue = 'Not configured in this build'
  let serverDetail = 'No Apex AI server (Supabase URL and key) is configured, so nothing can be pushed from the server. See the setup guide.'
  if (backendConfigured) {
    const workerFresh = status?.dispatcher_last_run_at ? Date.now() - new Date(status.dispatcher_last_run_at).getTime() < 10 * 60_000 : false
    if (!userId) {
      ;[serverTone, serverValue, serverDetail] = ['warn', 'Sign in required', 'Server notifications are tied to your account.']
    } else if (n.registration?.state === 'registered') {
      ;[serverTone, serverValue, serverDetail] = workerFresh
        ? ['ok', 'Active – this device is registered', `Delivery worker last ran ${timeAgo(status!.dispatcher_last_run_at!)}.`]
        : ['warn', 'Device registered, delivery worker not running', 'The scheduled delivery job has not run recently, so pushes may be delayed. (Operators: check the cron schedule.)']
    } else if (n.registration?.state === 'not_configured' && n.registration.reason === 'missing_project_id') {
      ;[serverTone, serverValue, serverDetail] = ['error', 'App build is missing its EAS project ID', 'Push tokens cannot be created until the app is built with EAS_PROJECT_ID.']
    } else if (n.registration?.state === 'error') {
      ;[serverTone, serverValue, serverDetail] = ['error', 'Registration failed', n.registration.message]
    } else {
      ;[serverTone, serverValue, serverDetail] = ['off', 'This device is not registered', 'Turn on device notifications to register. In-app notifications still work.']
    }
  }
  let dataTone: StatusTone = 'off'
  let dataValue = 'Not connected'
  let dataDetail = 'No verified motorsport data source is connected, so there are no live schedules, results or session reminders yet. Nothing is invented in the meantime.'
  if (status && status.live_sources > 0 && status.supported_championships.length) {
    const names = championships.filter((c) => status.supported_championships.includes(c.id)).map((c) => c.name)
    const stale = !status.last_ingest_at || Date.now() - new Date(status.last_ingest_at).getTime() > 7 * 86_400_000
    dataTone = stale ? 'warn' : 'ok'
    dataValue = `Connected: ${names.join(', ') || status.supported_championships.join(', ')}`
    dataDetail = status.last_ingest_at ? `Last verified update ${timeAgo(status.last_ingest_at)}.${stale ? ' Data may be out of date.' : ''}` : 'Waiting for the first update.'
  } else if (statusError) {
    ;[dataTone, dataValue, dataDetail] = ['error', 'Status unavailable', statusError]
  }

  const reminderModeText = {
    server: 'Session reminders are sent by the Apex AI server, so rescheduled or cancelled sessions are handled automatically.',
    local: 'Session reminders are scheduled on this device from verified event times and refreshed whenever the app opens or a schedule change arrives.',
    none: 'Session reminders appear in the notification centre only, because device notifications are off.',
  }[n.reminderMode]

  async function runTest() {
    setBusy('test')
    setTestResult(null)
    try {
      if (n.registration?.state === 'registered') {
        const r = await sendServerTestNotification()
        setTestResult(
          {
            sent: 'Sent. It should arrive in a few seconds (delivery depends on your device and network).',
            no_device: 'The server has no active registration for this device.',
            push_disabled: 'Device notifications are switched off in your preferences.',
            rate_limited: 'Too many test notifications. Try again in a few minutes.',
            failed: 'The push service did not accept the notification. Check the server logs.',
            server_unavailable: 'Could not reach the Apex AI server.',
          }[r] ?? r,
        )
      } else if (isNativePlatform && (n.permission?.status === 'granted' || n.permission?.provisional)) {
        await scheduleLocalTestNotification()
        setTestResult('Server push is not set up for this device, so a local test notification was scheduled for 5 seconds from now.')
      } else {
        setTestResult(Platform.OS === 'web' ? 'Device notifications are not available on the web preview.' : 'Turn on device notifications first.')
      }
    } finally {
      setBusy(null)
    }
  }

  const entityList = (kind: 'driver' | 'team', list: NamedEntity[]) => {
    const q = entitySearch.trim().toLowerCase()
    const shown = list.filter((e) => followed(kind, e.id) || (q && e.name.toLowerCase().includes(q))).slice(0, 25)
    if (list.length === 0) {
      return (
        <Row last>
          <Text style={type.small}>No {kind} data has been imported from a verified source yet. You'll be able to follow {kind}s once it is.</Text>
        </Row>
      )
    }
    if (shown.length === 0) {
      return (
        <Row last>
          <Text style={type.small}>Search above to find {kind}s to follow.</Text>
        </Row>
      )
    }
    return shown.map((e, i) => (
      <ToggleRow key={e.id} label={e.name} value={followed(kind, e.id)} onChange={(v) => void n.toggleFollow(kind, e.id, v)} last={i === shown.length - 1} />
    ))
  }

  return (
    <Screen>
      <PermissionPrimer
        visible={primer}
        onDecline={() => setPrimer(false)}
        onAccept={async () => {
          setPrimer(false)
          await n.enableDevicePush()
        }}
      />

      <View style={styles.saveBar}>
        <Text style={type.small}>
          {userId ? 'Saved to your account and applied on the server.' : backendConfigured ? 'Saved on this device. Sign in to sync and receive server notifications.' : 'Demo mode: saved on this device only.'}
        </Text>
        <Text style={[type.small, n.saveState === 'error' && { color: colors.danger }]} accessibilityLiveRegion="polite">
          {{ idle: '', saving: 'Saving…', saved: 'Saved', error: "Couldn't save" }[n.saveState]}
        </Text>
        {n.saveState === 'error' ? <Button label="Retry" variant="secondary" onPress={n.retrySave} /> : null}
      </View>

      {n.timezoneNotice ? (
        <Notice tone="warning" icon="globe-outline">
          <Text style={type.small}>
            Your device timezone changed from {friendlyZone(n.timezoneNotice.from)} to {friendlyZone(n.timezoneNotice.to)}. Event times are now shown in {friendlyZone(n.timezoneNotice.to)}. Reminders still fire at the same moment
            before each session.
          </Text>
          <View style={styles.inline}>
            <Button
              label={`Keep ${friendlyZone(n.timezoneNotice.from)}`}
              variant="secondary"
              onPress={() => {
                const from = n.timezoneNotice!.from
                update((p) => ({ ...p, timezoneMode: 'preferred', preferredTimezone: from }))
                n.dismissTimezoneNotice()
              }}
            />
            <Button label="OK" variant="secondary" onPress={n.dismissTimezoneNotice} />
          </View>
        </Notice>
      ) : null}

      <Section title="Status">
        <StatusRow
          label="Notifications in Apex AI"
          tone={appTone}
          value={enabledCount ? `On – ${enabledCount} of ${Object.keys(prefs.categories).length} types enabled` : 'Optional notifications are off'}
          detail="Account security alerts are always on."
        />
        <StatusRow
          label="Device permission"
          tone={permTone}
          value={reg.label}
          detail={reg.detail}
          action={
            reg.canRequest ? (
              <View style={styles.action}>
                <Button label="Turn on device notifications" onPress={() => setPrimer(true)} />
              </View>
            ) : reg.needsSettings ? (
              <View style={styles.action}>
                <Button label="Open system settings" variant="secondary" onPress={() => void Linking.openSettings()} />
              </View>
            ) : undefined
          }
        />
        <StatusRow label="Server delivery" tone={serverTone} value={serverValue} detail={serverDetail} />
        <StatusRow label="Live motorsport data" tone={dataTone} value={dataValue} detail={dataDetail} last />
      </Section>

      <Section title="Quick settings">
        <Row>
          <View style={[styles.buttons, styles.rowText]}>
            <Button label="Enable all" variant="secondary" onPress={() => update(enableAllNotifications)} />
            <Button label="Disable all optional" variant="secondary" onPress={() => update(disableAllOptionalNotifications)} />
            <Button
              label="Restore recommended"
              variant="secondary"
              onPress={() => update((p) => ({ ...recommendedPreferences(), timezoneMode: p.timezoneMode, preferredTimezone: p.preferredTimezone }))}
            />
          </View>
        </Row>
        <ToggleRow
          icon="phone-portrait-outline"
          label="Send notifications to my devices"
          description="When off, everything still appears in the notification centre. Security alerts are always sent."
          value={prefs.pushEnabled}
          onChange={(v) => update((p) => ({ ...p, pushEnabled: v }))}
          last
        />
      </Section>

      <Section title="Race reminders" footer={reminderModeText}>
        <CategoryToggle category="race_reminders" prefs={prefs} update={update} />
        <CategoryToggle category="schedule_changes" prefs={prefs} update={update} />
        <Row>
          <View style={styles.rowText}>
            <Text style={type.body}>When to remind me</Text>
            <Text style={type.small}>Choose one or more. Each session gets at most one reminder per timing.</Text>
            <View style={styles.chips}>
              {REMINDER_OFFSETS.map((o) => {
                const on = prefs.reminderOffsets.includes(o)
                return (
                  <Chip
                    key={o}
                    label={REMINDER_OFFSET_LABELS[o]}
                    selected={on}
                    onPress={() =>
                      update((p) => ({
                        ...p,
                        reminderOffsets: sortOffsets(on ? p.reminderOffsets.filter((x) => x !== o) : [...p.reminderOffsets, o as ReminderOffset]),
                      }))
                    }
                  />
                )
              })}
            </View>
            {prefs.reminderOffsets.length === 0 ? <Text style={[type.small, { color: colors.warning }]}>No timing selected, so no reminders will be sent.</Text> : null}
          </View>
        </Row>
        {SESSION_TYPES.map((t, i) => (
          <ToggleRow
            key={t}
            label={SESSION_TYPE_LABELS[t]}
            value={prefs.reminderSessionTypes[t]}
            onChange={(v) => update((p) => ({ ...p, reminderSessionTypes: { ...p.reminderSessionTypes, [t]: v } }))}
            last={i === SESSION_TYPES.length - 1}
          />
        ))}
      </Section>

      <Section
        title="Championships"
        footer="Alerts are only sent for championships connected to a verified data source. You can follow others now and alerts will start when they are connected."
      >
        <CategoryToggle category="race_results" prefs={prefs} update={update} />
        {championships.map((c, i) => (
          <ToggleRow
            key={c.id}
            label={c.name}
            badge={c.supported ? undefined : 'DATA NOT CONNECTED'}
            value={followed('championship', c.id)}
            onChange={(v) => void n.toggleFollow('championship', c.id, v)}
            last={i === championships.length - 1}
          />
        ))}
      </Section>

      <Section title="Favourite drivers and teams">
        <CategoryToggle category="driver_updates" prefs={prefs} update={update} />
        <CategoryToggle category="team_updates" prefs={prefs} update={update} />
        <Row>
          <TextInput
            value={entitySearch}
            onChangeText={setEntitySearch}
            placeholder="Search drivers and teams"
            placeholderTextColor={colors.textDim}
            style={styles.input}
            accessibilityLabel="Search drivers and teams"
          />
        </Row>
        <Row>
          <Text style={type.heading}>Drivers</Text>
        </Row>
        {entityList('driver', drivers)}
        <Row>
          <Text style={type.heading}>Teams</Text>
        </Row>
        {entityList('team', teams)}
      </Section>

      <Section title="Motorsport news" footer="Minor stories are never pushed. Related updates about the same story are combined into one notification.">
        <CategoryToggle category="news_breaking" prefs={prefs} update={update} />
        <CategoryToggle category="news_major" prefs={prefs} update={update} last />
      </Section>

      <Section title="Apex AI" footer="Ordinary chat replies appear in the conversation and are never pushed.">
        <CategoryToggle category="ai_tasks" prefs={prefs} update={update} />
        <CategoryToggle category="product_updates" prefs={prefs} update={update} last />
      </Section>

      <Section title="Track Lab">
        <CategoryToggle category="track_lab" prefs={prefs} update={update} last />
      </Section>

      <Section title="Sim racing">
        <CategoryToggle category="sim_racing" prefs={prefs} update={update} last />
      </Section>

      <Section title="Weekly summaries">
        <CategoryToggle category="weekly_summary" prefs={prefs} update={update} last />
      </Section>

      <Section title="Quiet hours" footer={describeQuietHoursPolicy(prefs.quietHours)}>
        <ToggleRow
          icon="moon-outline"
          label="Don't disturb me overnight"
          description={`Uses ${friendlyZone(n.timeZone)} time.`}
          value={prefs.quietHours.enabled}
          onChange={(v) => update((p) => ({ ...p, quietHours: { ...p.quietHours, enabled: v } }))}
        />
        {(['start', 'end'] as const).map((edge) => (
          <Row key={edge}>
            <Text style={[type.body, styles.rowText]}>{edge === 'start' ? 'From' : 'Until'}</Text>
            <Pressable
              onPress={() => update((p) => shiftQuiet(p, edge, -30))}
              accessibilityRole="button"
              accessibilityLabel={`${edge} 30 minutes earlier`}
              style={styles.stepper}
            >
              <Text style={styles.stepperText}>−</Text>
            </Pressable>
            <Text style={styles.clock}>{prefs.quietHours[edge]}</Text>
            <Pressable
              onPress={() => update((p) => shiftQuiet(p, edge, 30))}
              accessibilityRole="button"
              accessibilityLabel={`${edge} 30 minutes later`}
              style={styles.stepper}
            >
              <Text style={styles.stepperText}>+</Text>
            </Pressable>
          </Row>
        ))}
        <Row last>
          <View style={styles.rowText}>
            <Text style={type.body}>Race reminders during quiet hours</Text>
            <View style={styles.chips}>
              {(
                [
                  ['defer', 'Hold until morning'],
                  ['deliver', 'Still deliver'],
                  ['in_app_only', 'In-app only'],
                ] as [QuietHoursReminderPolicy, string][]
              ).map(([value, label]) => (
                <Chip key={value} label={label} selected={prefs.quietHours.reminderPolicy === value} onPress={() => update((p) => ({ ...p, quietHours: { ...p.quietHours, reminderPolicy: value } }))} />
              ))}
            </View>
          </View>
        </Row>
      </Section>

      <Section title="Timezone" footer="Every event time in Apex AI shows which timezone it uses. Reminders are tied to the real session start, so they are never shifted by a timezone change.">
        <Row>
          <View style={styles.rowText}>
            <View style={styles.chips}>
              <Chip label={`Device time (${friendlyZone(n.deviceTimeZone)})`} selected={prefs.timezoneMode === 'device'} onPress={() => update((p) => ({ ...p, timezoneMode: 'device' }))} />
              <Chip
                label={prefs.preferredTimezone ? `Preferred (${friendlyZone(prefs.preferredTimezone)})` : 'A timezone I choose'}
                selected={prefs.timezoneMode === 'preferred'}
                onPress={() => update((p) => ({ ...p, timezoneMode: 'preferred', preferredTimezone: p.preferredTimezone ?? n.deviceTimeZone }))}
              />
            </View>
            <Text style={type.small}>Currently showing times in {friendlyZone(n.timeZone)}.</Text>
          </View>
        </Row>
        <Row last>
          <View style={styles.rowText}>
            <TextInput
              value={zoneSearch}
              onChangeText={setZoneSearch}
              placeholder="Search timezones (e.g. Melbourne)"
              placeholderTextColor={colors.textDim}
              style={styles.input}
              accessibilityLabel="Search timezones"
            />
            {zoneMatches.map((z) => (
              <Pressable
                key={z}
                onPress={() => {
                  if (!isValidTimeZone(z)) return
                  update((p) => ({ ...p, timezoneMode: 'preferred', preferredTimezone: z }))
                  setZoneSearch('')
                }}
                style={styles.zone}
                accessibilityRole="button"
              >
                <Text style={type.body}>{friendlyZone(z)}</Text>
              </Pressable>
            ))}
          </View>
        </Row>
      </Section>

      <Section title="Account security">
        <Row last>
          <View style={styles.rowText}>
            <View style={styles.inline}>
              <Text style={type.body}>Security alerts</Text>
              <Badge text="ALWAYS ON" tone="success" />
            </View>
            <Text style={type.small}>{CATEGORY_INFO.account_security.description} They never include passwords, codes or personal details.</Text>
            <Pressable onPress={() => router.push('/account/security')} accessibilityRole="link">
              <Text style={styles.link}>Manage devices and security</Text>
            </Pressable>
          </View>
        </Row>
      </Section>

      <Section title="Troubleshooting">
        <Row>
          <View style={styles.rowText}>
            <Button label="Send a test notification" icon="paper-plane-outline" onPress={runTest} busy={busy === 'test'} />
            {testResult ? <Text style={type.small} accessibilityLiveRegion="polite">{testResult}</Text> : null}
          </View>
        </Row>
        <Row last>
          <View style={styles.rowText}>
            <Text style={type.small}>Sample notifications are labelled "Sample" and are never pushed. Use them to try the notification centre.</Text>
            <View style={styles.buttons}>
              <Button label="Add samples" variant="secondary" disabled={!n.repo} onPress={() => void n.repo?.seedSamples().then(n.refreshUnread)} />
              <Button label="Remove samples" variant="secondary" disabled={!n.repo} onPress={() => void n.repo?.clearSamples().then(n.refreshUnread)} />
            </View>
          </View>
        </Row>
      </Section>
    </Screen>
  )
}

const styles = StyleSheet.create({
  saveBar: { gap: 4 },
  inline: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap', alignItems: 'center' },
  action: { marginTop: spacing.sm, alignSelf: 'flex-start' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  rowText: { flex: 1, gap: 6 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: 4 },
  input: { backgroundColor: colors.surfaceRaised, color: colors.text, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: spacing.md, paddingVertical: 10, fontSize: 15, flex: 1 },
  stepper: { width: 36, height: 36, borderRadius: 18, borderWidth: 1, borderColor: colors.purple, alignItems: 'center', justifyContent: 'center' },
  stepperText: { color: colors.purpleBright, fontSize: 20, fontWeight: '700' },
  clock: { color: colors.text, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'], minWidth: 60, textAlign: 'center' },
  zone: { paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  link: { color: colors.purpleBright, fontWeight: '700', marginTop: 4 },
})
