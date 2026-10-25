// Explains the benefit before the OS permission dialog appears. The system prompt is
// only shown if the user taps "Turn on notifications" here.

import Ionicons from '@expo/vector-icons/Ionicons'
import { Modal, StyleSheet, Text, View } from 'react-native'
import { colors, radius, spacing, type } from '../theme.ts'
import { Button } from './ui.tsx'

const BENEFITS: { icon: 'alarm-outline' | 'calendar-outline' | 'sparkles-outline' | 'options-outline'; text: string }[] = [
  { icon: 'alarm-outline', text: 'Reminders before the sessions you follow, in your timezone' },
  { icon: 'calendar-outline', text: 'Confirmed schedule changes and cancellations' },
  { icon: 'sparkles-outline', text: 'When an Apex AI analysis or Track Lab design you started is ready' },
  { icon: 'options-outline', text: 'You choose exactly what you get, and can set quiet hours' },
]

export function PermissionPrimer({ visible, onAccept, onDecline }: { visible: boolean; onAccept(): void; onDecline(): void }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onDecline}>
      <View style={styles.backdrop}>
        <View style={styles.sheet} accessibilityViewIsModal>
          <Ionicons name="notifications" size={36} color={colors.purple} />
          <Text style={type.title}>Stay on top of race weekends</Text>
          <Text style={type.small}>Apex AI can notify you on this device even when the app is closed:</Text>
          <View style={styles.list}>
            {BENEFITS.map((b) => (
              <View key={b.text} style={styles.item}>
                <Ionicons name={b.icon} size={18} color={colors.purpleBright} />
                <Text style={[type.body, styles.itemText]}>{b.text}</Text>
              </View>
            ))}
          </View>
          <Text style={type.tiny}>Your device will ask for permission next. You can change this at any time in Settings.</Text>
          <Button label="Turn on notifications" onPress={onAccept} />
          <Button label="Not now" onPress={onDecline} variant="secondary" />
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', padding: spacing.lg },
  sheet: { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.purple, padding: spacing.xl, gap: spacing.md, maxWidth: 480, width: '100%', alignSelf: 'center' },
  list: { gap: spacing.sm, marginVertical: spacing.sm },
  item: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  itemText: { flex: 1 },
})
