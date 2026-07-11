export default function Logo({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-label="Li'l Piggy Squad logo">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff5da2" />
          <stop offset="1" stopColor="#7b2ff7" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="18" fill="url(#lg)" />
      <path d="M16 22 L23 19 L21 28 Z" fill="#ffb3d4" />
      <path d="M48 22 L41 19 L43 28 Z" fill="#ffb3d4" />
      <ellipse cx="32" cy="35" rx="18" ry="15" fill="#ffe3f0" />
      <ellipse cx="32" cy="39" rx="8" ry="6" fill="#ff9ec7" />
      <circle cx="29" cy="39" r="1.5" fill="#7b2ff7" />
      <circle cx="35" cy="39" r="1.5" fill="#7b2ff7" />
      <circle cx="25.5" cy="31" r="2.2" fill="#2a1b3d" />
      <circle cx="38.5" cy="31" r="2.2" fill="#2a1b3d" />
      <circle cx="24.5" cy="30.4" r=".7" fill="#fff" />
      <circle cx="37.5" cy="30.4" r=".7" fill="#fff" />
    </svg>
  )
}
