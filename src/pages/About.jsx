import { motion } from 'framer-motion'
import MemberCard from '../components/MemberCard.jsx'
import PartnersBanner from '../components/PartnersBanner.jsx'
import { team } from '../data/team.js'

const page = {
  initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0, transition: { duration: .5 } },
  exit: { opacity: 0, y: -16, transition: { duration: .3 } }
}

export default function About() {
  return (
    <motion.main variants={page} initial="initial" animate="animate" exit="exit">
      {/* Hero — Three-Sided Cube inspired: bold type on a dotted field */}
      <section className="container section" style={{ position: 'relative' }}>
        <div className="glass dotted" style={{ padding: 'clamp(28px,5vw,60px)', borderRadius: 34, position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'relative', zIndex: 2, maxWidth: 720 }}>
            <span className="eyebrow">About Us</span>
            <h1 style={{ fontSize: 'clamp(2.2rem,6vw,4rem)', margin: '16px 0 14px' }}>
              We're a small studio with <span style={{ color: 'var(--purple)' }}>big snouts</span> and bigger ideas.
            </h1>
            <p className="muted" style={{ fontSize: '1.12rem', maxWidth: '56ch', fontWeight: 600 }}>
              Inspired by the bold, playful energy of Three-Sided Cube, we build worlds one panel at a
              time. Hover a card below to uncover a fun fact about each squad member.
            </p>
          </div>
        </div>
      </section>

      {/* Team flip cards */}
      <section className="container section">
        <div className="section-head">
          <div>
            <span className="eyebrow teal">The squad</span>
            <h2 style={{ marginTop: 12 }}>Meet the makers</h2>
            <p className="muted" style={{ marginTop: 8 }}>Give a card a hover (or tap) to flip it. 👀</p>
          </div>
        </div>
        <div className="team-grid">
          {team.map((m, i) => <MemberCard key={m.name} member={m} index={i} />)}
        </div>
      </section>

      {/* Partners on About too */}
      <section className="container section">
        <div className="section-head">
          <div>
            <span className="eyebrow">Our Partners</span>
            <h2 style={{ marginTop: 12 }}>Friends of the Squad</h2>
            <p className="muted" style={{ marginTop: 8 }}>From Three-Sided Cube to the moving banner.</p>
          </div>
        </div>
        <PartnersBanner />
      </section>
    </motion.main>
  )
}
