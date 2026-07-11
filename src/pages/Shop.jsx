import { motion } from 'framer-motion'
import BookCard from '../components/BookCard.jsx'
import { bySection } from '../data/books.js'

const page = {
  initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0, transition: { duration: .5 } },
  exit: { opacity: 0, y: -16, transition: { duration: .3 } }
}
const groups = [
  { key: 'coming-soon', title: 'Coming Soon', cls: '' },
  { key: 'new', title: 'New', cls: 'teal' },
  { key: 'out-now', title: 'Out Now', cls: 'pink' }
]

export default function Shop() {
  return (
    <motion.main className="container section" variants={page} initial="initial" animate="animate" exit="exit">
      <span className="eyebrow pink">The shop</span>
      <h1 style={{ fontSize: 'clamp(2rem,5vw,3.2rem)', margin: '14px 0 8px' }}>Every comic in the squad</h1>
      <p className="muted" style={{ maxWidth: '56ch' }}>Browse what's coming, what's new and what's out now.</p>

      {groups.map(g => (
        <section key={g.key} style={{ marginTop: 46 }}>
          <div className="section-head">
            <span className={'eyebrow ' + g.cls}>{g.title}</span>
          </div>
          <div className="grid books">
            {bySection(g.key).map((b, i) => <BookCard key={b.id + g.key} book={b} index={i} />)}
          </div>
        </section>
      ))}
    </motion.main>
  )
}
