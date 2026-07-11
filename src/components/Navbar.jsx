import { useState } from 'react'
import { NavLink, Link, useNavigate } from 'react-router-dom'
import Logo from './Logo.jsx'
import { useAuth } from '../lib/auth.jsx'

export default function Navbar() {
  const { user, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const nav = useNavigate()
  const close = () => setOpen(false)

  return (
    <div className="container nav">
      <nav className="nav-inner glass glass-strong">
        <Link to="/" className="brand" onClick={close}>
          <Logo /> <span>The Li'l Piggy Squad</span>
        </Link>
        <div className={'nav-links glass glass-strong' + (open ? ' open' : '')}>
          <NavLink to="/" end onClick={close}>Home</NavLink>
          <NavLink to="/shop" onClick={close}>Shop</NavLink>
          <NavLink to="/about" onClick={close}>About Us</NavLink>
          {user && <NavLink to="/profile" onClick={close}>Profile</NavLink>}
        </div>
        <div className="nav-cta">
          {user ? (
            <>
              <Link className="btn ghost sm" to="/profile" onClick={close}>
                {user.profile?.emoji || '🐷'} {user.profile?.displayName || 'You'}
              </Link>
              <button className="btn sm" onClick={async () => { await logout(); nav('/') }}>Log out</button>
            </>
          ) : (
            <>
              <Link className="btn ghost sm" to="/login" onClick={close}>Log in</Link>
              <Link className="btn sm" to="/signup" onClick={close}>Join</Link>
            </>
          )}
          <button className="nav-toggle" onClick={() => setOpen(o => !o)} aria-label="Menu">☰</button>
        </div>
      </nav>
    </div>
  )
}
