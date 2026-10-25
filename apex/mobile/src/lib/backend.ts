import 'react-native-url-polyfill/auto'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { AppState, Platform } from 'react-native'
import type { KeyValueStore } from '../notifications/registration.ts'

// Public values only (anon key is safe to ship; RLS protects the data).
const SUPABASE_URL = process.env.EXPO_PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? ''

export const backendConfigured = SUPABASE_URL.startsWith('https://') && SUPABASE_ANON_KEY.length > 20

/** Null when no backend is configured: the app runs in clearly labelled demo mode. */
export const supabase: SupabaseClient | null = backendConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { storage: AsyncStorage, autoRefreshToken: true, persistSession: true, detectSessionInUrl: false },
    })
  : null

if (supabase && Platform.OS !== 'web') {
  // Only refresh sessions while the app is in the foreground (Supabase guidance for React Native).
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh()
    else supabase.auth.stopAutoRefresh()
  })
}

export const storage: KeyValueStore = {
  get: (key) => AsyncStorage.getItem(key),
  set: async (key, value) => {
    if (value === null) await AsyncStorage.removeItem(key)
    else await AsyncStorage.setItem(key, value)
  },
}
