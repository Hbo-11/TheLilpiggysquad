import Ionicons from '@expo/vector-icons/Ionicons'
import type { ComponentProps, ReactNode } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, View, type ViewStyle } from 'react-native'
import { colors, radius, spacing, type } from '../theme.ts'

export type IconName = ComponentProps<typeof Ionicons>['name']

export function Screen({ children, scroll = true }: { children: ReactNode; scroll?: boolean }) {
  if (!scroll) return <View style={styles.screen}>{children}</View>
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
      {children}
    </ScrollView>
  )
}

export function Section({ title, footer, children }: { title: string; footer?: string; children: ReactNode }) {
  return (
    <View style={styles.section} accessibilityRole="summary">
      <Text style={type.heading} accessibilityRole="header">
        {title}
      </Text>
      <View style={styles.card}>{children}</View>
      {footer ? <Text style={[type.small, styles.footer]}>{footer}</Text> : null}
    </View>
  )
}

export function Row({ children, last, style }: { children: ReactNode; last?: boolean; style?: ViewStyle }) {
  return <View style={[styles.row, !last && styles.rowDivider, style]}>{children}</View>
}

export function ToggleRow(props: {
  label: string
  description?: string
  value: boolean
  onChange(v: boolean): void
  disabled?: boolean
  badge?: string
  icon?: IconName
  last?: boolean
}) {
  return (
    <Row last={props.last}>
      {props.icon ? <Ionicons name={props.icon} size={20} color={colors.purpleBright} style={styles.rowIcon} /> : null}
      <View style={styles.rowText}>
        <View style={styles.inline}>
          <Text style={[type.body, props.disabled && styles.disabled]}>{props.label}</Text>
          {props.badge ? <Badge text={props.badge} /> : null}
        </View>
        {props.description ? <Text style={type.small}>{props.description}</Text> : null}
      </View>
      <Switch
        value={props.value}
        onValueChange={props.onChange}
        disabled={props.disabled}
        trackColor={{ false: colors.border, true: colors.purple }}
        thumbColor={colors.text}
        // react-native-web only: otherwise the active thumb uses its default teal.
        {...({ activeThumbColor: colors.text } as object)}
        accessibilityLabel={props.label}
      />
    </Row>
  )
}

export function Badge({ text, tone = 'purple' }: { text: string; tone?: 'purple' | 'warning' | 'muted' | 'danger' | 'success' }) {
  const color = { purple: colors.purpleBright, warning: colors.warning, muted: colors.textMuted, danger: colors.danger, success: colors.success }[tone]
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{text}</Text>
    </View>
  )
}

export function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress(): void }) {
  return (
    <Pressable
      onPress={onPress}
      style={[styles.chip, selected && styles.chipSelected]}
      accessibilityRole="button"
      accessibilityState={{ selected }}
    >
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  )
}

export function Button(props: { label: string; onPress(): void; variant?: 'primary' | 'secondary' | 'danger'; disabled?: boolean; busy?: boolean; icon?: IconName }) {
  const variant = props.variant ?? 'primary'
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled || props.busy}
      accessibilityRole="button"
      style={({ pressed }) => [styles.button, styles[`button_${variant}`], (pressed || props.disabled) && styles.buttonPressed]}
    >
      {props.busy ? (
        <ActivityIndicator color={colors.text} />
      ) : (
        <View style={styles.inline}>
          {props.icon ? <Ionicons name={props.icon} size={18} color={variant === 'primary' ? colors.text : colors.purpleBright} /> : null}
          <Text style={[styles.buttonText, variant !== 'primary' && { color: variant === 'danger' ? colors.danger : colors.purpleBright }]}>{props.label}</Text>
        </View>
      )}
    </Pressable>
  )
}

export type StatusTone = 'ok' | 'warn' | 'off' | 'error'

export function StatusRow({ label, value, detail, tone, action, last }: { label: string; value: string; detail?: string; tone: StatusTone; action?: ReactNode; last?: boolean }) {
  const icon: IconName = { ok: 'checkmark-circle', warn: 'alert-circle', off: 'remove-circle-outline', error: 'close-circle' }[tone] as IconName
  const color = { ok: colors.success, warn: colors.warning, off: colors.textDim, error: colors.danger }[tone]
  return (
    <Row last={last}>
      <Ionicons name={icon} size={20} color={color} style={styles.rowIcon} />
      <View style={styles.rowText}>
        <Text style={type.body}>{label}</Text>
        <Text style={[type.small, { color }]}>{value}</Text>
        {detail ? <Text style={type.small}>{detail}</Text> : null}
        {action}
      </View>
    </Row>
  )
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body: string; action?: ReactNode }) {
  return (
    <View style={styles.empty}>
      <Ionicons name={icon} size={40} color={colors.purple} />
      <Text style={[type.body, styles.emptyTitle]}>{title}</Text>
      <Text style={[type.small, styles.center]}>{body}</Text>
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <EmptyState
      icon="cloud-offline-outline"
      title="Something went wrong"
      body={message}
      action={<Button label="Try again" onPress={onRetry} variant="secondary" />}
    />
  )
}

export function Loading({ label }: { label: string }) {
  return (
    <View style={styles.empty} accessibilityLabel={label}>
      <ActivityIndicator color={colors.purple} />
      <Text style={type.small}>{label}</Text>
    </View>
  )
}

export function Notice({ icon = 'information-circle-outline', tone = 'purple', children }: { icon?: IconName; tone?: 'purple' | 'warning'; children: ReactNode }) {
  const color = tone === 'warning' ? colors.warning : colors.purpleBright
  return (
    <View style={[styles.notice, { borderColor: color }]}>
      <Ionicons name={icon} size={18} color={color} />
      <View style={styles.rowText}>{children}</View>
    </View>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  screenContent: { padding: spacing.lg, paddingBottom: 48, gap: spacing.lg, maxWidth: 720, width: '100%', alignSelf: 'center' },
  section: { gap: spacing.sm },
  card: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, overflow: 'hidden' },
  footer: { paddingHorizontal: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  rowIcon: { alignSelf: 'flex-start', marginTop: 2 },
  rowText: { flex: 1, gap: 2 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  disabled: { color: colors.textDim },
  badge: { borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 1 },
  badgeText: { fontSize: 11, fontWeight: '700', letterSpacing: 0.4 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceRaised },
  chipSelected: { borderColor: colors.purple, backgroundColor: colors.purpleDim },
  chipText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
  chipTextSelected: { color: colors.purpleBright },
  button: { borderRadius: radius.md, paddingVertical: 12, paddingHorizontal: spacing.lg, alignItems: 'center', justifyContent: 'center' },
  button_primary: { backgroundColor: colors.purple },
  button_secondary: { borderWidth: 1, borderColor: colors.purple, backgroundColor: 'transparent' },
  button_danger: { borderWidth: 1, borderColor: colors.danger, backgroundColor: 'transparent' },
  buttonPressed: { opacity: 0.6 },
  buttonText: { color: colors.text, fontWeight: '700', fontSize: 15 },
  empty: { alignItems: 'center', justifyContent: 'center', padding: spacing.xl, gap: spacing.sm },
  emptyTitle: { fontWeight: '700', marginTop: spacing.sm },
  emptyAction: { marginTop: spacing.md },
  center: { textAlign: 'center', maxWidth: 360 },
  notice: { flexDirection: 'row', gap: spacing.sm, padding: spacing.md, borderRadius: radius.md, borderWidth: 1, backgroundColor: colors.surface },
})
