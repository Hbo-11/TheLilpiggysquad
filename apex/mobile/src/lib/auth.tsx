import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { syncLocalReminders } from '../notifications/localReminders.ts'
import { expoLocalScheduler, isNativePlatform, supabasePushBackend } from '../notifications/expoPlatform.ts'
import { signOutWithCleanup } from '../notifications/registration.ts'
import { recommendedPreferences } from '@apex/notifications-core'
import { storage, supabase } from './backend.ts'

interface AuthState {
  userId: string | null
  email: string | null
  loading: boolean
  signIn(email: string, password: string): Promise<string | null>
  signUp(email: string, password: string): Promise<string | null>
  signOut(): Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(null)
  const [email, setEmail] = useState<string | null>(null)
  const [loading, setLoading] = useState(!!supabase)

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => {
      setUserId(data.session?.user.id ?? null)
      setEmail(data.session?.user.email ?? null)
      setLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user.id ?? null)
      setEmail(session?.user.email ?? null)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  const value = useMemo<AuthState>(
    () => ({
      userId,
      email,
      loading,
      async signIn(e, p) {
        if (!supabase) return 'Sign-in is not configured in this build.'
        const { error } = await supabase.auth.signInWithPassword({ email: e.trim(), password: p })
        return error ? error.message : null
      },
      async signUp(e, p) {
        if (!supabase) return 'Sign-up is not configured in this build.'
        const { error } = await supabase.auth.signUp({ email: e.trim(), password: p })
        return error ? error.message : null
      },
      async signOut() {
        await signOutWithCleanup({
          backend: supabasePushBackend,
          store: storage,
          cancelLocalReminders: async () => {
            if (!isNativePlatform) return
            await syncLocalReminders({ scheduler: expoLocalScheduler, sessions: [], prefs: recommendedPreferences(), timeZone: 'UTC', now: new Date(), enabled: false })
          },
          signOut: async () => {
            await supabase?.auth.signOut()
          },
        })
      },
    }),
    [userId, email, loading],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth outside AuthProvider')
  return ctx
}
