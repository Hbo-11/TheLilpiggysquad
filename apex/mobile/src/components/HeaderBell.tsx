import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useNotifications } from '../notifications/NotificationsProvider.tsx'
import { colors } from '../theme.ts'

export function HeaderBell() {
  const router = useRouter()
  const { unreadCount } = useNotifications()
  const label = unreadCount > 99 ? '99+' : String(unreadCount)
  return (
    <Pressable
      onPress={() => router.push('/notifications')}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications'}
      style={styles.wrap}
    >
      <Ionicons name={unreadCount ? 'notifications' : 'notifications-outline'} size={24} color={colors.text} />
      {unreadCount > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{label}</Text>
        </View>
      ) : null}
    </Pressable>
  )
}

export function HeaderSettings() {
  const router = useRouter()
  return (
    <Pressable onPress={() => router.push('/settings')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Settings" style={styles.wrap}>
      <Ionicons name="settings-outline" size={22} color={colors.text} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 6 },
  badge: {
    position: 'absolute',
    top: -4,
    right: -2,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.purple,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
    borderWidth: 2,
    borderColor: colors.bg,
  },
  badgeText: { color: colors.text, fontSize: 10, fontWeight: '800' },
})
