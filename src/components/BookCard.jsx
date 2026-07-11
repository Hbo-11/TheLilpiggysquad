import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'

const tagText = { new: 'New', soon: 'Coming Soon', out: 'Out Now' }

export default function BookCard({ book, index = 0 }) {
  return (
    <motion.div
      className="book glass"
      initial={{ opacity: 0, y: 26 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-60px' }}
      transition={{ duration: .5, delay: index * .07, ease: [.2, .8, .2, 1] }}
    >
      <Link to={`/book/${book.id}`} className="book-cover" style={{ background: book.gradient }}>
        <span className="shine" />
        <span className="pig">🐷</span>
        <div>
          <div className="cov-title">{book.title}</div>
          <div className="cov-sub">Li'l Piggy Squad</div>
        </div>
      </Link>
      <div className="book-body">
        <span className={'tag ' + book.accent}>{tagText[book.accent]}</span>
        <h3>{book.title}</h3>
        <p className="muted" style={{ margin: 0, fontSize: '.92rem' }}>{book.blurb}</p>
        <div className="book-actions">
          {book.price != null
            ? <span className="price">£{book.price.toFixed(2)}</span>
            : <span className="price" style={{ color: 'var(--purple)' }}>Soon</span>}
          <Link className="btn sm" to={`/book/${book.id}`} style={{ marginLeft: 'auto' }}>
            {book.price != null ? 'View' : 'Notify me'}
          </Link>
        </div>
      </div>
    </motion.div>
  )
}
