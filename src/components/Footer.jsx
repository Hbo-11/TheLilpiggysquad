import { Link } from 'react-router-dom'
import Logo from './Logo.jsx'

export default function Footer() {
  return (
    <footer className="container footer">
      <div className="footer-inner glass">
        <div style={{ maxWidth: 320 }}>
          <div className="brand" style={{ marginBottom: 10 }}><Logo /> <span>The Li'l Piggy Squad</span></div>
          <p className="muted" style={{ margin: 0 }}>A comix company making mischievous, heartfelt stories for every little squad member.</p>
        </div>
        <div style={{ display: 'flex', gap: 44, flexWrap: 'wrap' }}>
          <div>
            <h4 style={{ marginBottom: 10 }}>Explore</h4>
            <div style={{ display: 'grid', gap: 8 }}>
              <Link to="/">Home</Link><Link to="/shop">Shop</Link>
              <Link to="/about">About Us</Link><Link to="/profile">Profile</Link>
            </div>
          </div>
          <div>
            <h4 style={{ marginBottom: 10 }}>Squad</h4>
            <div style={{ display: 'grid', gap: 8 }}>
              <span className="muted">Coming Soon</span>
              <span className="muted">New Releases</span>
              <span className="muted">Out Now</span>
            </div>
          </div>
        </div>
      </div>
      <p className="muted" style={{ textAlign: 'center', marginTop: 22, fontSize: '.85rem' }}>
        © {new Date().getFullYear()} The Li'l Piggy Squad · Snouts up! 🐷
      </p>
    </footer>
  )
}
