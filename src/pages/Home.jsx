import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import BookCard from '../components/BookCard.jsx'
import PartnersBanner from '../components/PartnersBanner.jsx'
import { bySection } from '../data/books.js'

const page = {
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0, transition: { duration: .5 } },
  exit: { opacity: 0, y: -16, transition: { duration: .3 } }
}

function Section({ eyebrow, eyebrowClass, title, sub, books, to }) {
  return (
    <section className="section container">
      <div className="section-head">
        <div>
          <span className={'eyebrow ' + (eyebrowClass || '')}>{eyebrow}</span>
          <h2 style={{ marginTop: 12 }}>{title}</h2>
          {sub && <p className="muted" style={{ maxWidth: '52ch', marginTop: 8 }}>{sub}</p>}
        </div>
        {to && <Link className="btn ghost" to={to}>See all</Link>}
      </div>
      <div className="grid books">
        {books.map((b, i) => <BookCard key={b.id + eyebrow} book={b} index={i} />)}
      </div>
    </section>
  )
}

export default function Home() {
  return (
    <motion.main variants={page} initial="initial" animate="animate" exit="exit">
      {/* HERO */}
      <section className="hero container">
        <div className="hero-grid">
          <div>
            <span className="eyebrow pink">🐷 A comix company</span>
            <h1 style={{ marginTop: 16 }}>
              Big adventures,<br /><span className="grad">little piggies.</span>
            </h1>
            <p className="lead">
              Mischievous, heartfelt comics starring the Li'l Piggy Squad. New drops, sneak peeks
              and a whole muddy world to fall in love with.
            </p>
            <div className="hero-cta">
              <Link className="btn" to="/shop">Explore the comics</Link>
              <Link className="btn ghost" to="/about">Meet the squad</Link>
            </div>
            <div className="chips" style={{ marginTop: 24 }}>
              <span className="chip">✨ Coming Soon</span>
              <span className="chip">🆕 New Releases</span>
              <span className="chip">📚 Out Now</span>
            </div>
          </div>
          <motion.div className="hero-art"
            initial={{ opacity: 0, scale: .9 }} animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: .6, ease: [.2, .8, .2, 1] }}>
            <motion.div className="glass" style={{ padding: 40, borderRadius: 40 }}
              animate={{ y: [0, -12, 0] }} transition={{ duration: 5, repeat: Infinity, ease: 'easeInOut' }}>
              <div style={{ fontSize: '9rem', lineHeight: 1 }}>🐷</div>
            </motion.div>
            <motion.div className="hero-badge glass" style={{ top: 12, right: 6, color: 'var(--purple)' }}
              animate={{ y: [0, 8, 0] }} transition={{ duration: 4, repeat: Infinity }}>Snouts up! ✨</motion.div>
            <motion.div className="hero-badge glass" style={{ bottom: 18, left: 0, color: 'var(--pink)' }}
              animate={{ y: [0, -8, 0] }} transition={{ duration: 4.5, repeat: Infinity }}>3 comics & counting</motion.div>
          </motion.div>
        </div>
      </section>

      {/* COMING SOON */}
      <Section
        eyebrow="Coming Soon" eyebrowClass=""
        title="Coming Soon"
        sub="The next chapter is nearly here. Get the first look at what the squad is up to next."
        books={bySection('coming-soon')} to="/shop"
      />

      {/* NEW */}
      <Section
        eyebrow="New" eyebrowClass="teal"
        title="New"
        sub="Fresh off the drawing board — the newest addition to the Li'l Piggy Squad shelf."
        books={bySection('new')} to="/shop"
      />

      {/* OUT NOW */}
      <Section
        eyebrow="Out Now" eyebrowClass="pink"
        title="Out Now"
        sub="Available today. Grab your copy and dive straight into the mischief."
        books={bySection('out-now')} to="/shop"
      />

      {/* OUR PARTNERS */}
      <section className="section container">
        <div className="section-head">
          <div>
            <span className="eyebrow">Our Partners</span>
            <h2 style={{ marginTop: 12 }}>Our Partners</h2>
            <p className="muted" style={{ maxWidth: '54ch', marginTop: 8 }}>
              From Three-Sided Cube to the moving banner — the friends and tools that help the squad
              make the magic happen.
            </p>
          </div>
        </div>
        <PartnersBanner />
      </section>
    </motion.main>
  )
}
