import express from 'express'
import cookieParser from 'cookie-parser'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = process.env.PORT || 4123
const DATA_DIR = path.join(__dirname, 'data')
const DB_FILE = path.join(DATA_DIR, 'db.json')

// ---------- tiny JSON store (no native deps) ----------
fs.mkdirSync(DATA_DIR, { recursive: true })
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }
  catch { return { users: {}, sessions: {}, orders: [] } }
}
let db = loadDB()
let writeTimer = null
function saveDB() {
  clearTimeout(writeTimer)
  writeTimer = setTimeout(() => {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2))
  }, 50)
}

const app = express()
app.use(express.json())
app.use(cookieParser())

// ---------- helpers ----------
function newId(p = 'id') { return p + '_' + crypto.randomBytes(8).toString('hex') }
function sessionUser(req) {
  const sid = req.cookies?.sid
  if (!sid) return null
  const s = db.sessions[sid]
  if (!s) return null
  return db.users[s.userId] || null
}
function publicUser(u) {
  if (!u) return null
  const { passwordHash, ...rest } = u
  return rest
}
function requireAuth(req, res, next) {
  const u = sessionUser(req)
  if (!u) return res.status(401).json({ error: 'You need an account to do that.' })
  req.user = u
  next()
}

// ---------- auth ----------
app.post('/api/signup', async (req, res) => {
  const { email, password, name } = req.body || {}
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' })
  const emailLc = String(email).toLowerCase().trim()
  if (Object.values(db.users).some(u => u.email === emailLc))
    return res.status(409).json({ error: 'An account with that email already exists.' })
  const id = newId('user')
  const passwordHash = await bcrypt.hash(password, 10)
  db.users[id] = {
    id, email: emailLc, passwordHash,
    createdAt: Date.now(),
    profileComplete: false,
    profile: {
      displayName: name || '',
      bio: '', favouriteBook: '', location: '',
      avatarColor: '#ff5da2', emoji: '🐷'
    }
  }
  const sid = newId('sess')
  db.sessions[sid] = { userId: id, createdAt: Date.now() }
  saveDB()
  res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30 })
  res.json({ user: publicUser(db.users[id]) })
})

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {}
  const emailLc = String(email || '').toLowerCase().trim()
  const user = Object.values(db.users).find(u => u.email === emailLc)
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' })
  const ok = await bcrypt.compare(String(password || ''), user.passwordHash)
  if (!ok) return res.status(401).json({ error: 'Invalid email or password.' })
  const sid = newId('sess')
  db.sessions[sid] = { userId: user.id, createdAt: Date.now() }
  saveDB()
  res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30 })
  res.json({ user: publicUser(user) })
})

app.post('/api/logout', (req, res) => {
  const sid = req.cookies?.sid
  if (sid) { delete db.sessions[sid]; saveDB() }
  res.clearCookie('sid')
  res.json({ ok: true })
})

app.get('/api/me', (req, res) => {
  const u = sessionUser(req)
  res.json({ user: publicUser(u) })
})

// ---------- profile ----------
app.put('/api/profile', requireAuth, (req, res) => {
  const { displayName, bio, favouriteBook, location, avatarColor, emoji } = req.body || {}
  const u = req.user
  u.profile = {
    ...u.profile,
    displayName: (displayName ?? u.profile.displayName) || '',
    bio: (bio ?? u.profile.bio) || '',
    favouriteBook: (favouriteBook ?? u.profile.favouriteBook) || '',
    location: (location ?? u.profile.location) || '',
    avatarColor: avatarColor || u.profile.avatarColor,
    emoji: emoji || u.profile.emoji
  }
  if (u.profile.displayName.trim()) u.profileComplete = true
  saveDB()
  res.json({ user: publicUser(u) })
})

// ---------- orders (only for account holders) ----------
app.get('/api/orders', requireAuth, (req, res) => {
  const orders = db.orders
    .filter(o => o.userId === req.user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
  res.json({ orders })
})

app.post('/api/orders', requireAuth, (req, res) => {
  const { bookId, title, price } = req.body || {}
  if (!title) return res.status(400).json({ error: 'Missing book.' })
  const order = {
    id: newId('ord'),
    userId: req.user.id,
    bookId: bookId || null,
    title,
    price: Number(price) || 0,
    status: 'Confirmed',
    createdAt: Date.now()
  }
  db.orders.push(order)
  saveDB()
  res.json({ order })
})

// ---------- static (production build) ----------
const dist = path.join(__dirname, 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' })
    res.sendFile(path.join(dist, 'index.html'))
  })
}

app.listen(PORT, '0.0.0.0', () => {
  console.log('Li\'l Piggy Squad server running on http://localhost:' + PORT)
})
