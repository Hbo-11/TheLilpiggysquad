import { useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { getBook } from '../data/books.js'
import { useAuth } from '../lib/auth.jsx'
import { api } from '../lib/api.js'

const page = {
  initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0, transition: { duration: .5 } },
  exit: { opacity: 0, y: -16, transition: { duration: .3 } }
}

export default function BookDetail() {
  const { id } = useParams()
  const book = getBook(id)
  const { user } = useAuth()
  const nav = useNavigate()
  const [msg, setMsg] = useState(null)
  const [busy, setBusy] = useState(false)

  if (!book) return (
    <main className="container section"><h1>Book not found 🐷</h1><Link className="btn" to="/shop">Back to shop</Link></main>
  )

  const comingSoon = book.price == null

  async function addOrder() {
    setBusy(true); setMsg(null)
    try {
      await api.order({ bookId: book.id, title: book.title, price: book.price })
      setMsg({ type: 'ok', text: 'Added to your orders! Find it on your profile.' })
    } catch (e) {
      setMsg({ type: 'err', text: e.message })
    } finally { setBusy(false) }
  }

  return (
    <motion.main className="container section" variants={page} initial="initial" animate="animate" exit="exit">
      <Link to="/shop" className="muted" style={{ fontWeight: 700 }}>← Back to shop</Link>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px,380px) 1fr', gap: 40, marginTop: 18, alignItems: 'start' }}
           className="book-detail-grid">
        <div className="book-cover glass" style={{ background: book.gradient, aspectRatio: '3/4', borderRadius: 26 }}>
          <span className="shine" /><span className="pig">🐷</span>
          <div><div className="cov-title">{book.title}</div><div className="cov-sub">Li'l Piggy Squad</div></div>
        </div>
        <div>
          <span className={'tag ' + book.accent}>{comingSoon ? 'Coming Soon' : book.accent === 'new' ? 'New' : 'Out Now'}</span>
          <h1 style={{ fontSize: 'clamp(2rem,5vw,3rem)', margin: '14px 0' }}>{book.title}</h1>
          <p className="muted" style={{ fontSize: '1.1rem', fontWeight: 600, maxWidth: '52ch' }}>{book.blurb}</p>
          <div style={{ margin: '22px 0', fontFamily: 'var(--font-head)', fontWeight: 800, fontSize: '2rem', color: comingSoon ? 'var(--purple)' : 'var(--ink)' }}>
            {comingSoon ? 'Coming soon' : '£' + book.price.toFixed(2)}
          </div>

          {msg && <div className={'notice ' + (msg.type === 'ok' ? 'ok' : 'err')} style={{ marginBottom: 14 }}>{msg.text}</div>}

          {comingSoon ? (
            <div className="chips"><span className="chip">🔔 We'll shout when it drops</span></div>
          ) : user ? (
            <button className="btn" onClick={addOrder} disabled={busy}>{busy ? 'Adding…' : 'Add to my orders'}</button>
          ) : (
            <div className="glass" style={{ padding: 20, maxWidth: 440 }}>
              <p style={{ marginTop: 0, fontWeight: 700 }}>You need an account to order.</p>
              <div style={{ display: 'flex', gap: 10 }}>
                <button className="btn sm" onClick={() => nav('/signup')}>Create account</button>
                <button className="btn ghost sm" onClick={() => nav('/login')}>Log in</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </motion.main>
  )
}
