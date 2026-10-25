// Apex AI visual identity: dark, premium, black/charcoal surfaces, neon purple accents.
export const colors = {
  bg: '#07070B',
  surface: '#111118',
  surfaceRaised: '#191922',
  border: '#26263A',
  purple: '#A855F7',
  purpleBright: '#C084FC',
  purpleDim: 'rgba(168, 85, 247, 0.16)',
  text: '#F4F4F8',
  textMuted: '#A1A1B5',
  textDim: '#6B6B80',
  success: '#34D399',
  warning: '#FBBF24',
  danger: '#F87171',
}

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 }
export const radius = { sm: 8, md: 12, lg: 16, pill: 999 }

export const type = {
  title: { fontSize: 22, fontWeight: '700' as const, color: colors.text, letterSpacing: 0.2 },
  heading: { fontSize: 13, fontWeight: '700' as const, color: colors.textMuted, letterSpacing: 1, textTransform: 'uppercase' as const },
  body: { fontSize: 15, color: colors.text, lineHeight: 21 },
  small: { fontSize: 13, color: colors.textMuted, lineHeight: 18 },
  tiny: { fontSize: 12, color: colors.textDim },
}
