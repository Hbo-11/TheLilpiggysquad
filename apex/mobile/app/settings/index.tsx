import Ionicons from '@expo/vector-icons/Ionicons'
import { useRouter } from 'expo-router'
import { Pressable, Text, View } from 'react-native'
import { Row, Screen, Section, type IconName } from '../../src/components/ui.tsx'
import { useAuth } from '../../src/lib/auth.tsx'
import { backendConfigured } from '../../src/lib/backend.ts'
import { colors, type } from '../../src/theme.ts'

function LinkRow({ icon, label, detail, href, last }: { icon: IconName; label: string; detail: string; href: string; last?: boolean }) {
  const router = useRouter()
  return (
    <Pressable onPress={() => router.push(href as never)} accessibilityRole="button">
      <Row last={last}>
        <Ionicons name={icon} size={22} color={colors.purpleBright} />
        <View style={{ flex: 1 }}>
          <Text style={type.body}>{label}</Text>
          <Text style={type.small}>{detail}</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
      </Row>
    </Pressable>
  )
}

export default function SettingsScreen() {
  const { userId, email } = useAuth()
  return (
    <Screen>
      <Section title="Preferences">
        <LinkRow icon="notifications-outline" label="Notifications" detail="Reminders, follows, news, quiet hours and timezone" href="/settings/notifications" last />
      </Section>
      <Section title="Account">
        {backendConfigured ? (
          userId ? (
            <LinkRow icon="shield-checkmark-outline" label="Account security" detail={email ?? ''} href="/account/security" last />
          ) : (
            <LinkRow icon="log-in-outline" label="Sign in" detail="Sync preferences and receive notifications" href="/sign-in" last />
          )
        ) : (
          <Row last>
            <Text style={type.small}>Accounts are not configured in this build (demo mode).</Text>
          </Row>
        )}
      </Section>
    </Screen>
  )
}
