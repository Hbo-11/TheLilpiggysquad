import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useAuth } from '../lib/auth.jsx'

export default function Login() {
  const { login } = useAuth()
  const nav = useNavigate()
  const [form, setForm] = useState({ email: '', password: '' })
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault(); setErr(null); setBusy(true)
    try { await login(form); nav('/profile') }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const upd = k => e => setForm(f => ({ ...f, [k]: e.target.value }))

  return (
    <motion.main initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <div className="container">
        <div className="auth-wrap glass">
          <h1 style={{ fontSize: '2rem' }}>Welcome back 🐷</h1>
          <p className="muted">Log in to see your profile and orders.</p>
          {err && <div className="notice err" style={{ margin: '10px 0' }}>{err}</div>}
          <form onSubmit={submit} style={{ marginTop: 12 }}>
            <div className="field"><label>Email</label>
              <input className="input" type="email" value={form.email} onChange={upd('email')} required /></div>
            <div className="field"><label>Password</label>
              <input className="input" type="password" value={form.password} onChange={upd('password')} required /></div>
            <button className="btn" style={{ width: '100%' }} disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
          </form>
          <p className="muted" style={{ marginTop: 16, textAlign: 'center' }}>
            New here? <Link to="/signup" style={{ color: 'var(--purple)', fontWeight: 800 }}>Join the squad</Link>
          </p>
        </div>
      </div>
    </motion.main>
  )
}
