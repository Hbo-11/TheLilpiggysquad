import { Link, Stack } from 'expo-router'
import { Text } from 'react-native'
import { EmptyState, Screen } from '../src/components/ui.tsx'
import { colors } from '../src/theme.ts'

export default function NotFound() {
  return (
    <Screen>
      <Stack.Screen options={{ title: 'Not found' }} />
      <EmptyState
        icon="compass-outline"
        title="This page doesn't exist"
        body="The link may be out of date."
        action={
          <Link href="/notifications">
            <Text style={{ color: colors.purpleBright, fontWeight: '700' }}>Go to notifications</Text>
          </Link>
        }
      />
    </Screen>
  )
}
