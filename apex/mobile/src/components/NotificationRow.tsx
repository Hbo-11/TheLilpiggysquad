import Ionicons from '@expo/vector-icons/Ionicons'
import { CATEGORY_INFO } from '@apex/notifications-core'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { stamp, timeAgo } from '../lib/format.ts'
import { describePushNote, iconFor, type AppNotification } from '../notifications/repository.ts'
import { colors, radius, spacing, type } from '../theme.ts'
import { Badge, type IconName } from './ui.tsx'

export function NotificationRow(props: { item: AppNotification; timeZone: string; onOpen(): void; onArchive(): void; onToggleRead(): void }) {
  const n = props.item
  const unread = n.readAt === null
  const note = describePushNote(n)
  const category = CATEGORY_INFO[n.category]
  return (
    <Pressable
      onPress={props.onOpen}
      onLongPress={props.onToggleRead}
      style={({ pressed }) => [styles.row, unread && styles.unread, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${unread ? 'Unread. ' : ''}${category.label}. ${n.title}. ${n.body}. ${stamp(n.createdAt, props.timeZone)}`}
      accessibilityHint="Opens the related screen. Long press to toggle read."
    >
      <View style={[styles.icon, unread && styles.iconUnread]}>
        <Ionicons name={iconFor(n.category) as IconName} size={20} color={unread ? colors.purpleBright : colors.textMuted} />
      </View>
      <View style={styles.text}>
        <View style={styles.meta}>
          <Text style={styles.category}>{category.label}</Text>
          <Text style={type.tiny}>· {timeAgo(n.createdAt)}</Text>
          {n.isDemo ? <Badge text="SAMPLE" tone="warning" /> : null}
          {n.groupCount > 1 ? <Badge text={`${n.groupCount} UPDATES`} tone="muted" /> : null}
        </View>
        <Text style={[styles.title, unread && styles.titleUnread]} numberOfLines={2}>
          {n.title}
        </Text>
        <Text style={type.small} numberOfLines={3}>
          {n.body}
        </Text>
        {note ? <Text style={styles.note}>{note}</Text> : null}
      </View>
      <View style={styles.side}>
        {unread ? <View style={styles.dot} accessibilityLabel="Unread" /> : <View style={styles.dotSpacer} />}
        <Pressable onPress={props.onArchive} hitSlop={12} accessibilityRole="button" accessibilityLabel="Dismiss notification">
          <Ionicons name="close" size={18} color={colors.textDim} />
        </Pressable>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  unread: { borderColor: colors.purple, backgroundColor: '#141020' },
  pressed: { opacity: 0.7 },
  icon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surfaceRaised, alignItems: 'center', justifyContent: 'center' },
  iconUnread: { backgroundColor: colors.purpleDim },
  text: { flex: 1, gap: 3 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  category: { color: colors.purpleBright, fontSize: 12, fontWeight: '700' },
  title: { color: colors.textMuted, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  titleUnread: { color: colors.text, fontWeight: '700' },
  note: { color: colors.textDim, fontSize: 12, fontStyle: 'italic', marginTop: 2 },
  side: { alignItems: 'center', justifyContent: 'space-between' },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.purple },
  dotSpacer: { width: 10, height: 10 },
})
