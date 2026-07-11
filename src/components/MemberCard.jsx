import { motion } from 'framer-motion'

export default function MemberCard({ member, index = 0 }) {
  return (
    <motion.div
      className="member"
      tabIndex={0}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: .5, delay: index * .06 }}
    >
      <div className="member-inner">
        {/* FRONT: photo on a dotted background */}
        <div className="member-face member-front">
          <div className="member-photo dotted" style={{ background: '#faf5ff' }}>
            <div className="dotted" style={{ position: 'absolute', inset: 0, opacity: .5 }} />
            <span className="avatar">{member.emoji}</span>
          </div>
          <div className="member-meta">
            <h3>{member.name}</h3>
            <div className="role">{member.role}</div>
          </div>
        </div>
        {/* BACK: fun fact */}
        <div className="member-face member-back" style={{ background: member.color }}>
          <div className="ff-label">Fun fact</div>
          <p>{member.fact}</p>
          <span className="flip-hint">— {member.name}</span>
        </div>
      </div>
    </motion.div>
  )
}
