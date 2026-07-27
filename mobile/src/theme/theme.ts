/**
 * NearNest design tokens — mirrors design_handoff_nearnest_app/README.md.
 * Colors, typography, spacing, radii and shadows are the final-intent values
 * from the handoff. Keep this file as the single source of truth for styling.
 */

export const colors = {
  // Shell gradients (see `gradients` for the full stops)
  primaryGreenDark: '#2F6E48', // icons, brand mark, primary accents
  primaryGreenMid: '#4F9868', // gradient button start
  ink: '#22422E', // headings, card titles, emphasis
  body: '#4F6B58', // secondary / body copy
  muted: '#7C9686', // timestamps, meta, footnotes
  faint: '#8A9E8F', // tertiary / dismiss links / pending
  statusGreen: '#3D7A54', // status labels, "Nearby", progress %
  warnText: '#A6863F', // "Needs review" text
  warnDot: '#C9922F',
  warnDeep: '#8A5A16', // review badge text
  destructive: '#8A3D22', // delete / unpair / log out
  highReviewText: '#8A3D22',

  // Surfaces
  glassStrong: 'rgba(255,255,255,0.6)',
  glassSoft: 'rgba(255,255,255,0.55)',
  // Modal/dialog containers: near-opaque so text stays legible over the busy
  // content behind (RN has no backdrop blur to frost it).
  modalSurface: 'rgba(247,250,245,0.985)',
  glassBorder: 'rgba(255,255,255,0.8)',
  glassBorderStrong: 'rgba(255,255,255,0.9)',
  glassFieldBg: 'rgba(255,255,255,0.6)',

  track: 'rgba(61,122,84,0.12)', // progress rail / tint chip bg
  tintChip: 'rgba(61,122,84,0.12)',
  tintChipStrong: 'rgba(61,122,84,0.15)',

  warnSurfaceBg: 'rgba(255,251,235,0.7)',
  warnSurfaceBorder: 'rgba(239,217,166,0.8)',
  reviewBadgeBg: 'rgba(198,146,47,0.18)',
  allClearBg: 'rgba(61,122,84,0.15)',
  highReviewBg: 'rgba(166,86,62,0.15)',
  infoBadgeBg: 'rgba(79,107,88,0.12)',

  destructiveBorder: 'rgba(138,61,34,0.3)',
  primaryDisabledBg: 'rgba(61,122,84,0.25)',
  outlineTint: 'rgba(61,122,84,0.08)', // ghost/outline press tint

  scrimDialog: 'rgba(34,66,46,0.32)',
  scrimSheet: 'rgba(34,66,46,0.36)',

  white: '#ffffff',
  pageBackdrop: '#E4E7E0',
  notifDotBorder: '#F4F8F1',
} as const;

/** Shell gradient stops (deep default). Used with react-native-linear-gradient. */
export const gradients: {
  shellDeep: { colors: string[]; locations: number[]; start: { x: number; y: number }; end: { x: number; y: number } };
  shellSoft: { colors: string[]; locations: number[]; start: { x: number; y: number }; end: { x: number; y: number } };
  primaryButton: { colors: string[]; start: { x: number; y: number }; end: { x: number; y: number } };
  progress: { colors: string[]; start: { x: number; y: number }; end: { x: number; y: number } };
} = {
  shellDeep: {
    colors: ['#B4D2B3', '#CFE4CD', '#E2EEDF', '#EDF4EA', '#F3F8F1'],
    locations: [0, 0.26, 0.55, 0.8, 1],
    // 168deg ≈ down and slightly left. RN uses start/end points.
    start: { x: 0.1, y: 0 },
    end: { x: -0.1, y: 1 },
  },
  shellSoft: {
    colors: ['#DEEBDD', '#F1F6EE', '#F8FAF6'],
    locations: [0, 0.45, 1],
    start: { x: 0.12, y: 0 },
    end: { x: -0.05, y: 1 },
  },
  // 135deg primary button gradient
  primaryButton: {
    colors: ['#4F9868', '#2F6E48'],
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
  },
  // 90deg allowance / progress fill
  progress: {
    colors: ['#4F9868', '#2F6E48'],
    start: { x: 0, y: 0.5 },
    end: { x: 1, y: 0.5 },
  },
};

/** Font families. Google's static Work Sans registers 500/600 under their own
 * family names, so reference those directly rather than relying on fontWeight. */
export const fonts = {
  serif: 'Instrument Serif',
  regular: 'Work Sans',
  medium: 'Work Sans Medium',
  semibold: 'Work Sans SemiBold',
  bold: 'Work Sans',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  base: 16,
  gutter: 22, // screen gutter
  lg: 24,
  onboardGutter: 32,
  xl: 48,
} as const;

export const radii = {
  shell: 18,
  card: 16,
  cardSm: 12,
  button: 12,
  dialogButton: 10,
  chip: 8,
  chipSm: 6,
  progress: 6,
  tileSm: 10,
  tile: 14,
  sheet: 20,
} as const;

export const shadows = {
  shell: {
    shadowColor: 'rgba(34,66,46,1)',
    shadowOpacity: 0.28,
    shadowRadius: 35,
    shadowOffset: { width: 0, height: 30 },
    elevation: 24,
  },
  card: {
    shadowColor: 'rgba(60,100,70,1)',
    shadowOpacity: 0.14,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 12 },
    elevation: 6,
  },
  bar: {
    shadowColor: 'rgba(60,100,70,1)',
    shadowOpacity: 0.1,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 },
    elevation: 12,
  },
  button: {
    shadowColor: 'rgba(47,110,72,1)',
    shadowOpacity: 0.3,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  dialog: {
    shadowColor: 'rgba(34,66,46,1)',
    shadowOpacity: 0.25,
    shadowRadius: 25,
    shadowOffset: { width: 0, height: 20 },
    elevation: 24,
  },
  smallTile: {
    shadowColor: 'rgba(60,100,70,1)',
    shadowOpacity: 0.1,
    shadowRadius: 7,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
} as const;

export type Severity = 'high' | 'review' | 'info';
