// Simple original monogram marks (not trademarked artwork) for each partner.
const G = {
  gmail:  <svg viewBox="0 0 24 24"><path d="M3 5h18v14H3z" fill="none" stroke="#111" strokeWidth="2"/><path d="M3 6l9 7 9-7" fill="none" stroke="#ff5da2" strokeWidth="2"/></svg>,
  teams:  <svg viewBox="0 0 24 24"><circle cx="9" cy="7" r="3" fill="#7b2ff7"/><rect x="4" y="11" width="10" height="9" rx="3" fill="#111"/><circle cx="17" cy="8" r="2.3" fill="#a05cff"/></svg>,
  word:   <svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="#111" strokeWidth="2"/><path d="M7 8l1.6 8L10 10l1.4 6L13 8" fill="none" stroke="#7b2ff7" strokeWidth="2" strokeLinejoin="round"/></svg>,
  claude: <svg viewBox="0 0 24 24"><g stroke="#111" strokeWidth="2" strokeLinecap="round"><path d="M12 3v18M3 12h18M6 6l12 12M18 6L6 18"/></g></svg>,
  gpt:    <svg viewBox="0 0 24 24"><path d="M12 4a5 5 0 013 9 5 5 0 11-6 0 5 5 0 013-9z" fill="none" stroke="#111" strokeWidth="2"/><circle cx="12" cy="12" r="2" fill="#2fe0c9"/></svg>
}
const partners = [
  { key: 'gmail',  name: 'Gmail' },
  { key: 'teams',  name: 'Microsoft Teams' },
  { key: 'word',   name: 'Microsoft Word' },
  { key: 'claude', name: 'Claude' },
  { key: 'gpt',    name: 'ChatGPT' }
]

export default function PartnersBanner() {
  const row = [...partners, ...partners] // duplicated for seamless loop
  return (
    <div className="partners-banner">
      <div className="partners-track">
        {row.map((p, i) => (
          <div className="partner-item" key={i}>
            <span className="partner-logo">{G[p.key]}</span>
            <span>{p.name}</span>
            <span className="partner-dot" />
          </div>
        ))}
      </div>
    </div>
  )
}
