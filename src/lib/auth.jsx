import { createContext, useContext, useEffect, useState } from 'react'
import { api } from './api.js'

const AuthCtx = createContext(null)
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.me().then(d => setUser(d.user)).catch(() => {}).finally(() => setLoading(false))
  }, [])

  const value = {
    user, loading, setUser,
    async login(b){ const d = await api.login(b); setUser(d.user); return d.user },
    async signup(b){ const d = await api.signup(b); setUser(d.user); return d.user },
    async logout(){ await api.logout(); setUser(null) },
    async saveProfile(b){ const d = await api.saveProfile(b); setUser(d.user); return d.user }
  }
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>
}
export const useAuth = () => useContext(AuthCtx)
