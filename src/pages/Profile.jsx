import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useAuth } from '../lib/auth.jsx'
import { api } from '../lib/api.js'

const page = {
  initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0, transition: { duration: .5 } },
  exit: { opacity: 0, y: -16, transition: { duration: .3 } }
}
const COLORS = ['#ff5da2', '#7b2ff7', '#a05cff', '#2fe0c9', '#ffd23f']
const EMOJIS = ['🐷', '🐽', '✨', '🌈', '🎨', '📚', '💜', '🦄']

function ProfileForm({ initial, onDone, cta }) {
  const { saveProfile } = useAuth()
  const [p, setP] = useState({
    displayName: initial.displayName || '', bio: initial.bio || '',
    favouriteBook: initial.favouriteBook || '', location: initial.location || '',
    avatarColor: initial.avatarColor || '#ff5da2', emoji: initial.emoji || '🐷'
  })
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false)
  const upd = k => e => setP(s => ({ ...s, [k]: e.target.value }))

  async function submit(e) {
    e.preventDefault()
    if (!p.displayName.trim()) return setErr('Please add a display name.')
    setErr(null); setBusy(true)
    try { await saveProfile(p); onDone && onDone() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }

  return (
    <form onSubmit={submit} className="glass" style={{ padding: 28 }}>
      {err && <div className="notice err" style={{ marginBottom: 14 }}>{err}</div>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }} className="pf-grid">
        <div className="field"><label>Display name *</label>
          <input className="input" value={p.displayName} onChange={upd('displayName')} placeholder="e.g. Muddy Max" /></div>
        <div className="field"><label>Location</label>
          <input className="input" value={p.location} onChange={upd('location')} placeholder="The sty, UK" /></div>
      </div>
      <div className="field"><label>Bio</label>
        <textarea className="input" value={p.bio} onChange={upd('bio')} placeholder="Tell the squad about yourself…" /></div>
      <div className="field"><label>Favourite book</label>
        <input className="input" value={p.favouriteBook} onChange={upd('favouriteBook')} placeholder="The Little Piggy Squad 1" /></div>

      <div className="field"><label>Avatar colour</label>
        <div className="swatches">
          {COLORS.map(c => (
            <button type="button" key={c} className="swatch" style={{ background: c }}
              aria-pressed={p.avatarColor === c} onClick={() => setP(s => ({ ...s, avatarColor: c }))} />
          ))}
        </div>
      </div>
      <div className="field"><label>Avatar emoji</label>
        <div className="chips">
          {EMOJIS.map(em => (
            <button type="button" key={em} className="chip" style={{ fontSize: '1.2rem', outline: p.emoji === em ? '2px solid var(--purple)' : 'none' }}
              onClick={() => setP(s => ({ ...s, emoji: em }))}>{em}</button>
          ))}
        </div>
      </div>
      <button className="btn" disabled={busy} style={{ marginTop: 8 }}>{busy ? 'Saving…' : (cta || 'Save profile')}</button>
    </form>
  )
}

export default function Profile() {
  const { user, loading } = useAuth()
  const [orders, setOrders] = useState(null)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    if (user?.profileComplete) api.orders().then(d => setOrders(d.orders)).catch(() => setOrders([]))
  }, [user?.profileComplete, user?.id])

  if (loading) return <main className="container section"><p className="muted">Loading…</p></main>

  // --- Not signed in: orders are only for account holders ---
  if (!user) return (
    <motion.main className="container section" variants={page} initial="initial" animate="animate" exit="exit">
      <div className="auth-wrap glass empty-state">
        <div style={{ fontSize: '3.4rem' }}>🐷</div>
        <h1 style={{ fontSize: '2rem' }}>Your profile lives here</h1>
        <p className="muted">You need an account to set up a profile and see your orders.</p>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 14 }}>
          <Link className="btn" to="/signup">Create account</Link>
          <Link className="btn ghost" to="/login">Log in</Link>
        </div>
      </div>
    </motion.main>
  )

  // --- Signed in, profile not set up yet ---
  if (!user.profileComplete) return (
    <motion.main className="container section" variants={page} initial="initial" animate="animate" exit="exit" style={{ maxWidth: 720, marginInline: 'auto' }}>
      <span className="eyebrow pink">One quick step</span>
      <h1 style={{ fontSize: 'clamp(1.8rem,4vw,2.6rem)', margin: '12px 0 6px' }}>Set up your profile</h1>
      <p className="muted" style={{ marginBottom: 20 }}>Make it yours before you start collecting comics.</p>
      <ProfileForm initial={user.profile} cta="Finish setup" onDone={() => {}} />
    </motion.main>
  )

  // --- Signed in with a complete profile ---
  const pr = user.profile
  return (
    <motion.main className="container section" variants={page} initial="initial" animate="animate" exit="exit">
      <div className="profile-head glass">
        <div className="profile-avatar" style={{ background: pr.avatarColor }}>{pr.emoji}</div>
        <div style={{ flex: 1, minWidth: 220 }}>
          <span className="eyebrow teal">Your profile</span>
          <h1 style={{ fontSize: 'clamp(1.7rem,4vw,2.4rem)', margin: '8px 0 4px' }}>{pr.displayName}</h1>
          <p className="muted" style={{ margin: 0 }}>{user.email}{pr.location ? ' · ' + pr.location : ''}</p>
          {pr.bio && <p style={{ marginTop: 10, fontWeight: 600 }}>{pr.bio}</p>}
          {pr.favouriteBook && <p className="muted" style={{ margin: '6px 0 0' }}>Favourite: <b>{pr.favouriteBook}</b></p>}
        </div>
        <button className="btn ghost sm" onClick={() => setEditing(e => !e)}>{editing ? 'Close' : 'Edit profile'}</button>
      </div>

      {editing && (
        <div style={{ marginTop: 20 }}>
          <ProfileForm initial={pr} cta="Update profile" onDone={() => setEditing(false)} />
        </div>
      )}

      {/* Orders — only visible because this is an account holder */}
      <section style={{ marginTop: 34 }}>
        <div className="section-head"><div><span className="eyebrow">Your orders</span><h2 style={{ marginTop: 10 }}>Order history</h2></div></div>
        {orders == null ? (
          <p className="muted">Loading orders…</p>
        ) : orders.length === 0 ? (
          <div className="glass empty-state">
            <div style={{ fontSize: '2.6rem' }}>📚</div>
            <h3 style={{ fontSize: '1.3rem' }}>No orders yet</h3>
            <p className="muted">When you order a comic it'll show up right here.</p>
            <Link className="btn sm" to="/shop" style={{ marginTop: 10 }}>Browse the shop</Link>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 12 }}>
            {orders.map(o => (
              <div className="order-row" key={o.id}>
                <div>
                  <div style={{ fontWeight: 800 }}>{o.title}</div>
                  <div className="muted" style={{ fontSize: '.85rem' }}>{new Date(o.createdAt).toLocaleDateString()}</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <span className="badge">{o.status}</span>
                  <span className="price">£{Number(o.price).toFixed(2)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </motion.main>
  )
}
