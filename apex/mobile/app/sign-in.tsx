import { useRouter } from 'expo-router'
import { useState } from 'react'
import { StyleSheet, Text, TextInput } from 'react-native'
import { Button, Screen } from '../src/components/ui.tsx'
import { useAuth } from '../src/lib/auth.tsx'
import { colors, radius, spacing, type } from '../src/theme.ts'

export default function SignIn() {
  const router = useRouter()
  const { signIn, signUp } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(kind: 'in' | 'up') {
    setBusy(true)
    setError(null)
    const err = kind === 'in' ? await signIn(email, password) : await signUp(email, password)
    setBusy(false)
    if (err) setError(err)
    else router.back()
  }

  return (
    <Screen>
      <Text style={type.title}>Sign in to Apex AI</Text>
      <Text style={type.small}>Your notification preferences and history are stored with your account.</Text>
      <TextInput style={styles.input} value={email} onChangeText={setEmail} placeholder="Email" placeholderTextColor={colors.textDim} autoCapitalize="none" keyboardType="email-address" autoComplete="email" accessibilityLabel="Email" />
      <TextInput style={styles.input} value={password} onChangeText={setPassword} placeholder="Password" placeholderTextColor={colors.textDim} secureTextEntry autoComplete="password" accessibilityLabel="Password" />
      {error ? <Text style={[type.small, { color: colors.danger }]}>{error}</Text> : null}
      <Button label="Sign in" onPress={() => submit('in')} busy={busy} disabled={!email || !password} />
      <Button label="Create account" variant="secondary" onPress={() => submit('up')} disabled={busy || !email || password.length < 8} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  input: { backgroundColor: colors.surface, color: colors.text, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, fontSize: 16 },
})
