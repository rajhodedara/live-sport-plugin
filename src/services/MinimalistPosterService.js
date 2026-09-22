/**
 * MinimalistPosterService.js
 *
 * Generates sleek, modern, minimalist vector (SVG) artwork for:
 * - Sports Replay Categories (Football, Motorsport, Baseball, Rugby, Basketball, Cricket, etc.)
 * - Replay Date Hubs (e.g., September 19, 2026 with clean calendar typography)
 * - Nuvio Collection Folder Tiles (Landscape 16:9) and Catalog Posters (Vertical 2:3)
 *
 * Replaces high-contrast, dark, cluttered AI-generated imagery with
 * clean, balanced, aesthetic streaming platform designs.
 */

const SPORT_CONFIGS = {
  football: {
    title: 'FOOTBALL',
    badge: 'REPLAYS',
    accent: '#10b981', // emerald
    bgTop: '#0d1f18',
    bgBottom: '#07120e',
    glow: 'rgba(16, 185, 129, 0.18)',
    icon: (w, h, cx, cy) => `
      <!-- Minimalist Football / Soccer Ball -->
      <g transform="translate(${cx - 36}, ${cy - 36})" stroke="#f8fafc" stroke-width="2.5" fill="none" stroke-linejoin="round" stroke-linecap="round">
        <circle cx="36" cy="36" r="34" stroke="rgba(248,250,252,0.9)" stroke-width="2.5"/>
        <polygon points="36,20 49,29 44,45 28,45 23,29" fill="rgba(16, 185, 129, 0.35)" stroke="#10b981" stroke-width="2"/>
        <line x1="36" y1="20" x2="36" y2="2"/>
        <line x1="49" y1="29" x2="68" y2="24"/>
        <line x1="44" y1="45" x2="57" y2="60"/>
        <line x1="28" y1="45" x2="15" y2="60"/>
        <line x1="23" y1="29" x2="4" y2="24"/>
      </g>
    `
  },
  motorsport: {
    title: 'MOTORSPORT',
    badge: 'RACE ARCHIVE',
    accent: '#ef4444', // race red
    bgTop: '#1f1315',
    bgBottom: '#120b0c',
    glow: 'rgba(239, 68, 68, 0.18)',
    icon: (w, h, cx, cy) => `
      <!-- Minimalist Racing / F1 Silhouette -->
      <g transform="translate(${cx - 40}, ${cy - 28})" stroke="#f8fafc" stroke-width="2.2" fill="none" stroke-linejoin="round" stroke-linecap="round">
        <!-- Front wing -->
        <path d="M4 42 L24 38 L30 38 L36 34 L44 34 L50 38 L56 38 L76 42" stroke="#ef4444" stroke-width="2.5"/>
        <!-- Chassis profile -->
        <path d="M40 14 C36 20, 32 30, 24 38 M40 14 C44 20, 48 30, 56 38" fill="rgba(239, 68, 68, 0.25)"/>
        <!-- Cockpit & Halo -->
        <circle cx="40" cy="22" r="5" fill="#f8fafc"/>
        <path d="M33 22 Q40 16 47 22" stroke="#f8fafc" stroke-width="2.5"/>
        <!-- Wheels -->
        <rect x="8" y="26" width="10" height="20" rx="3" fill="#18181b" stroke="#f8fafc" stroke-width="2"/>
        <rect x="62" y="26" width="10" height="20" rx="3" fill="#18181b" stroke="#f8fafc" stroke-width="2"/>
        <!-- Rear Wing -->
        <line x1="20" y1="52" x2="60" y2="52" stroke="#ef4444" stroke-width="2.5"/>
        <line x1="30" y1="46" x2="30" y2="52"/>
        <line x1="50" y1="46" x2="50" y2="52"/>
      </g>
    `
  },
  baseball: {
    title: 'BASEBALL',
    badge: 'MLB REPLAYS',
    accent: '#38bdf8', // sky blue
    bgTop: '#0f172a',
    bgBottom: '#090d16',
    glow: 'rgba(56, 189, 248, 0.18)',
    icon: (w, h, cx, cy) => `
      <!-- Minimalist Baseball -->
      <g transform="translate(${cx - 36}, ${cy - 36})" fill="none" stroke-linejoin="round" stroke-linecap="round">
        <circle cx="36" cy="36" r="34" stroke="#f8fafc" stroke-width="2.5" fill="rgba(56, 189, 248, 0.08)"/>
        <!-- Curved stitch arcs -->
        <path d="M18 12 Q30 36 18 60" stroke="#ef4444" stroke-width="2.2" stroke-dasharray="3,3"/>
        <path d="M54 12 Q42 36 54 60" stroke="#ef4444" stroke-width="2.2" stroke-dasharray="3,3"/>
      </g>
    `
  },
  rugby: {
    title: 'RUGBY',
    badge: 'MATCH ARCHIVE',
    accent: '#f59e0b', // amber
    bgTop: '#1b1710',
    bgBottom: '#100e0a',
    glow: 'rgba(245, 158, 11, 0.18)',
    icon: (w, h, cx, cy) => `
      <!-- Minimalist Rugby Ball -->
      <g transform="translate(${cx - 38}, ${cy - 32})" stroke="#f8fafc" stroke-width="2.5" fill="none" stroke-linejoin="round" stroke-linecap="round">
        <ellipse cx="38" cy="32" rx="34" ry="22" transform="rotate(-25 38 32)" stroke="#f8fafc" fill="rgba(245, 158, 11, 0.15)"/>
        <path d="M12 44 Q38 32 64 20" stroke="#f59e0b" stroke-width="2"/>
        <!-- Centered laces -->
        <line x1="34" y1="28" x2="42" y2="36" stroke="#f8fafc" stroke-width="2.5"/>
        <line x1="28" y1="24" x2="33" y2="29" stroke="#f8fafc" stroke-width="2"/>
        <line x1="43" y1="35" x2="48" y2="40" stroke="#f8fafc" stroke-width="2"/>
      </g>
    `
  },
  basketball: {
    title: 'BASKETBALL',
    badge: 'NBA REPLAYS',
    accent: '#f97316', // orange
    bgTop: '#1c130c',
    bgBottom: '#100b07',
    glow: 'rgba(249, 115, 22, 0.18)',
    icon: (w, h, cx, cy) => `
      <!-- Minimalist Basketball -->
      <g transform="translate(${cx - 36}, ${cy - 36})" stroke="#f8fafc" stroke-width="2.5" fill="none">
        <circle cx="36" cy="36" r="34" stroke="#f8fafc" fill="rgba(249, 115, 22, 0.15)"/>
        <line x1="2" y1="36" x2="70" y2="36" stroke="#f97316" stroke-width="2"/>
        <line x1="36" y1="2" x2="36" y2="70" stroke="#f97316" stroke-width="2"/>
        <path d="M14 12 Q28 36 14 60" stroke="#f97316" stroke-width="2"/>
        <path d="M58 12 Q44 36 58 60" stroke="#f97316" stroke-width="2"/>
      </g>
    `
  },
  cricket: {
    title: 'CRICKET',
    badge: 'MATCH ARCHIVE',
    accent: '#14b8a6', // teal
    bgTop: '#0b1917',
    bgBottom: '#07100f',
    glow: 'rgba(20, 184, 166, 0.18)',
    icon: (w, h, cx, cy) => `
      <!-- Minimalist Cricket Bat & Ball -->
      <g transform="translate(${cx - 34}, ${cy - 34})" stroke="#f8fafc" stroke-width="2.5" fill="none" stroke-linecap="round">
        <!-- Bat -->
        <rect x="18" y="24" width="16" height="38" rx="3" transform="rotate(-35 26 43)" stroke="#f8fafc" fill="rgba(20, 184, 166, 0.2)"/>
        <line x1="36" y1="20" x2="52" y2="6" stroke="#14b8a6" stroke-width="3"/>
        <!-- Ball -->
        <circle cx="48" cy="46" r="10" stroke="#ef4444" stroke-width="2" fill="rgba(239, 68, 68, 0.3)"/>
        <line x1="42" y1="46" x2="54" y2="46" stroke="#f8fafc" stroke-width="1.5"/>
      </g>
    `
  },
  tennis: {
    title: 'TENNIS',
    badge: 'MATCH ARCHIVE',
    accent: '#84cc16', // lime
    bgTop: '#131b0e',
    bgBottom: '#0b1008',
    glow: 'rgba(132, 204, 22, 0.18)',
    icon: (w, h, cx, cy) => `
      <g transform="translate(${cx - 36}, ${cy - 36})" stroke="#f8fafc" stroke-width="2.5" fill="none">
        <circle cx="36" cy="36" r="32" stroke="#84cc16" stroke-width="2.5" fill="rgba(132, 204, 22, 0.15)"/>
        <path d="M12 18 Q36 36 12 54" stroke="#f8fafc" stroke-width="2"/>
        <path d="M60 18 Q36 36 60 54" stroke="#f8fafc" stroke-width="2"/>
      </g>
    `
  },
  hockey: {
    title: 'ICE HOCKEY',
    badge: 'MATCH ARCHIVE',
    accent: '#06b6d4', // cyan
    bgTop: '#0a1a1f',
    bgBottom: '#060f12',
    glow: 'rgba(6, 182, 212, 0.18)',
    icon: (w, h, cx, cy) => `
      <!-- Minimalist Hockey Stick & Puck -->
      <g transform="translate(${cx - 36}, ${cy - 36})" stroke="#f8fafc" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M26 6 L26 42 Q26 54 38 54 L58 54" stroke="#f8fafc"/>
        <rect x="46" y="58" width="22" height="9" rx="3" fill="rgba(6, 182, 212, 0.30)" stroke="#06b6d4"/>
        <circle cx="18" cy="58" r="7" stroke="#06b6d4"/>
      </g>
    `
  },
  american_football: {
    title: 'AMERICAN FOOTBALL',
    badge: 'MATCH ARCHIVE',
    accent: '#3b82f6', // blue
    bgTop: '#0d1524',
    bgBottom: '#080d16',
    glow: 'rgba(59, 130, 246, 0.18)',
    icon: (w, h, cx, cy) => `
      <!-- Minimalist Gridiron Ball -->
      <g transform="translate(${cx - 38}, ${cy - 30})" stroke="#f8fafc" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <ellipse cx="38" cy="30" rx="34" ry="21" transform="rotate(-20 38 30)" fill="rgba(59, 130, 246, 0.18)" stroke="#f8fafc"/>
        <line x1="26" y1="30" x2="50" y2="30" stroke="#3b82f6"/>
        <line x1="32" y1="24" x2="32" y2="36"/>
        <line x1="38" y1="23" x2="38" y2="37"/>
        <line x1="44" y1="24" x2="44" y2="36"/>
      </g>
    `
  },
  mma: {
    title: 'MMA',
    badge: 'FIGHT ARCHIVE',
    accent: '#dc2626', // crimson
    bgTop: '#1c1012',
    bgBottom: '#0f0809',
    glow: 'rgba(220, 38, 38, 0.18)',
    icon: (w, h, cx, cy) => `
      <!-- Minimalist Fight Octagon -->
      <g transform="translate(${cx - 36}, ${cy - 36})" stroke="#f8fafc" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <polygon points="36,4 62,18 62,46 36,60 10,46 10,18" stroke="rgba(248,250,252,0.85)" fill="rgba(220, 38, 38, 0.10)"/>
        <circle cx="36" cy="32" r="12" fill="rgba(220, 38, 38, 0.25)" stroke="#dc2626"/>
      </g>
    `
  },
  golf: {
    title: 'GOLF',
    badge: 'TOUR ARCHIVE',
    accent: '#22c55e', // green
    bgTop: '#0c1a10',
    bgBottom: '#07100a',
    glow: 'rgba(34, 197, 94, 0.18)',
    icon: (w, h, cx, cy) => `
      <!-- Minimalist Flag & Ball -->
      <g transform="translate(${cx - 34}, ${cy - 34})" stroke="#f8fafc" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <line x1="22" y1="10" x2="22" y2="58"/>
        <path d="M22 12 L48 20 L22 30 Z" fill="rgba(34, 197, 94, 0.25)" stroke="#22c55e"/>
        <circle cx="48" cy="56" r="6" stroke="#22c55e"/>
      </g>
    `
  },
  darts: {
    title: 'DARTS',
    badge: 'TOUR ARCHIVE',
    accent: '#eab308', // yellow
    bgTop: '#1c1808',
    bgBottom: '#100d05',
    glow: 'rgba(234, 179, 8, 0.18)',
    icon: (w, h, cx, cy) => `
      <!-- Minimalist Dartboard -->
      <g transform="translate(${cx - 36}, ${cy - 36})" stroke="#f8fafc" stroke-width="2.5" fill="none">
        <circle cx="36" cy="36" r="32" stroke="rgba(248,250,252,0.85)"/>
        <circle cx="36" cy="36" r="20" stroke="#eab308"/>
        <circle cx="36" cy="36" r="9" fill="rgba(234, 179, 8, 0.30)" stroke="#eab308"/>
        <line x1="36" y1="4" x2="36" y2="14" stroke="#eab308"/>
        <line x1="36" y1="58" x2="36" y2="68" stroke="#eab308"/>
      </g>
    `
  },
  networks: {
    title: 'LIVE TV',
    badge: '24/7 NETWORK',
    accent: '#94a3b8', // slate
    bgTop: '#141821',
    bgBottom: '#0a0d13',
    glow: 'rgba(148, 163, 184, 0.16)',
    icon: (w, h, cx, cy) => `
      <!-- Minimalist Broadcast TV Set -->
      <g transform="translate(${cx - 36}, ${cy - 30})" stroke="#f8fafc" stroke-width="2.5" fill="none" stroke-linejoin="round" stroke-linecap="round">
        <rect x="6" y="10" width="60" height="42" rx="6" fill="rgba(148, 163, 184, 0.12)" stroke="rgba(248,250,252,0.9)"/>
        <line x1="26" y1="4" x2="36" y2="12" stroke="#94a3b8"/>
        <line x1="46" y1="4" x2="36" y2="12" stroke="#94a3b8"/>
        <circle cx="36" cy="31" r="7" fill="rgba(148, 163, 184, 0.30)" stroke="#94a3b8"/>
      </g>
    `
  },
  college: {
    title: 'COLLEGE SPORTS',
    badge: 'CAMPUS ARCHIVE',
    accent: '#d946ef', // fuchsia
    bgTop: '#1a1020',
    bgBottom: '#0e0812',
    glow: 'rgba(217, 70, 239, 0.18)',
    icon: (w, h, cx, cy) => `
      <!-- Minimalist Trophy -->
      <g transform="translate(${cx - 34}, ${cy - 34})" stroke="#f8fafc" stroke-width="2.5" fill="none" stroke-linejoin="round" stroke-linecap="round">
        <path d="M24 8 H44 V26 C44 36 38 42 34 42 C30 42 24 36 24 26 Z" fill="rgba(217, 70, 239, 0.20)" stroke="#d946ef"/>
        <path d="M24 12 H14 C14 24 20 30 26 30"/>
        <path d="M44 12 H54 C54 24 48 30 42 30"/>
        <line x1="34" y1="42" x2="34" y2="54"/>
        <rect x="22" y="54" width="24" height="8" rx="2" stroke="#d946ef"/>
      </g>
    `
  },
  other: {
    title: 'LIVE SPORTS',
    badge: 'LIVE',
    accent: '#64748b', // slate
    bgTop: '#12161f',
    bgBottom: '#090c12',
    glow: 'rgba(100, 116, 139, 0.16)',
    icon: (w, h, cx, cy) => `
      <!-- Minimalist Generic Ball -->
      <g transform="translate(${cx - 36}, ${cy - 36})" stroke="#f8fafc" stroke-width="2.5" fill="none">
        <circle cx="36" cy="36" r="32" stroke="rgba(248,250,252,0.85)" fill="rgba(100, 116, 139, 0.12)"/>
        <path d="M14 20 Q36 36 14 52" stroke="#94a3b8"/>
        <path d="M58 20 Q36 36 58 52" stroke="#94a3b8"/>
      </g>
    `
  },
  all: {
    title: 'ALL SPORTS',
    badge: 'REPLAY HUB',
    accent: '#a855f7', // purple
    bgTop: '#171124',
    bgBottom: '#0d0a14',
    glow: 'rgba(168, 85, 247, 0.20)',
    icon: (w, h, cx, cy) => `
      <!-- Minimalist Replay / Trophy Icon -->
      <g transform="translate(${cx - 36}, ${cy - 36})" stroke="#f8fafc" stroke-width="2.5" fill="none" stroke-linejoin="round" stroke-linecap="round">
        <path d="M16 24 L36 36 L16 48 Z" fill="rgba(168, 85, 247, 0.3)" stroke="#a855f7"/>
        <path d="M36 24 L56 36 L36 48 Z" fill="rgba(168, 85, 247, 0.3)" stroke="#a855f7"/>
        <circle cx="36" cy="36" r="32" stroke="rgba(248,250,252,0.8)" stroke-dasharray="4,4"/>
      </g>
    `
  }
};

/**
 * Minimalist line-art glyph for a sport, in the shared 0..72 drawing box.
 * Returned untranslated so callers can place it with their own transform.
 */
function sportGlyphMarkup(category) {
  const key = String(category || 'other').toLowerCase().trim();
  const cfg = SPORT_CONFIGS[key] || SPORT_CONFIGS.other;
  return cfg.icon(0, 0, 0, 0);
}

/**
 * Generate a minimalist sport poster or landscape banner.
 *
 * @param {string} sport - Sport identifier (e.g. 'football', 'motorsport', 'baseball', 'rugby', 'all')
 * @param {string} shape - 'poster' (600x900, 2:3) or 'landscape' (800x450, 16:9)
 * @param {object} overrides - Optional title/badge overrides
 */
function generateSportSvg(sport = 'football', shape = 'poster', overrides = {}) {
  const isLandscape = shape === 'landscape';
  const w = isLandscape ? 800 : 600;
  const h = isLandscape ? 450 : 900;

  const key = String(sport || 'all').toLowerCase().trim();
  const cfg = SPORT_CONFIGS[key] || SPORT_CONFIGS.all;

  const title = (overrides.title || cfg.title).toUpperCase();
  const badge = (overrides.badge || cfg.badge).toUpperCase();

  const cx = w / 2;
  const cy = isLandscape ? h * 0.42 : h * 0.38;

  const titleY = isLandscape ? h * 0.72 : h * 0.65;
  const badgeY = isLandscape ? h * 0.85 : h * 0.74;

  const titleFontSize = isLandscape ? 30 : 36;
  const badgeFontSize = isLandscape ? 12 : 14;

  const iconSvg = cfg.icon(w, h, cx, cy);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${cfg.bgTop}"/>
      <stop offset="60%" stop-color="${cfg.bgBottom}"/>
      <stop offset="100%" stop-color="#050608"/>
    </linearGradient>
    <radialGradient id="ambientGlow" cx="50%" cy="${(cy / h * 100).toFixed(0)}%" r="45%">
      <stop offset="0%" stop-color="${cfg.glow}"/>
      <stop offset="55%" stop-color="${cfg.glow.replace(/[\d\.]+\)$/, '0.04)')}"/>
      <stop offset="100%" stop-color="transparent"/>
    </radialGradient>
  </defs>

  <!-- Smooth minimalist background -->
  <rect width="${w}" height="${h}" fill="url(#bgGrad)"/>
  <rect width="${w}" height="${h}" fill="url(#ambientGlow)"/>

  <!-- Subtle refined 1px border -->
  <rect x="1.5" y="1.5" width="${w - 3}" height="${h - 3}" rx="12" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1.5"/>

  <!-- Top accent indicator -->
  <rect x="${(w - 60) / 2}" y="12" width="60" height="3" rx="1.5" fill="${cfg.accent}" opacity="0.85"/>

  <!-- Minimalist Vector Icon -->
  ${iconSvg}

  <!-- Typography -->
  <text x="50%" y="${titleY}" 
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif" 
        font-size="${titleFontSize}" 
        font-weight="700" 
        letter-spacing="5" 
        fill="#f8fafc" 
        text-anchor="middle">
    ${escapeXml(title)}
  </text>

  <!-- Clean Subtitle Pill Badge -->
  <g transform="translate(${cx}, ${badgeY})">
    <rect x="-70" y="-14" width="140" height="28" rx="14" 
          fill="rgba(255,255,255,0.05)" 
          stroke="rgba(255,255,255,0.12)" 
          stroke-width="1"/>
    <text x="0" y="5" 
          font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif" 
          font-size="${badgeFontSize}" 
          font-weight="600" 
          letter-spacing="2.5" 
          fill="${cfg.accent}" 
          text-anchor="middle">
      ${escapeXml(badge)}
    </text>
  </g>
</svg>`;
}

/**
 * Generate a clean, minimalist Date Card poster.
 *
 * @param {string} displayDate - E.g. "September 19, 2026" or "2026-09-19"
 * @param {number|string} count - Number of matches, e.g. 13
 * @param {string} sportKey - Optional sport (e.g. 'football', 'motorsport')
 * @param {string} shape - 'poster' (600x900) or 'landscape' (800x450)
 */
function generateDateSvg(displayDate, count = 0, sportKey = null, shape = 'poster') {
  const isLandscape = shape === 'landscape';
  const w = isLandscape ? 800 : 600;
  const h = isLandscape ? 450 : 900;

  let monthStr = 'REPLAYS';
  let dayStr = '';
  let yearStr = '';

  const dateObj = new Date(displayDate.includes('T') ? displayDate : `${displayDate}T00:00:00Z`);
  if (!isNaN(dateObj.getTime())) {
    monthStr = dateObj.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
    dayStr = String(dateObj.getUTCDate());
    yearStr = String(dateObj.getUTCFullYear());
  } else {
    dayStr = displayDate;
  }

  const cfg = SPORT_CONFIGS[sportKey] || {
    accent: '#38bdf8', // sky blue
    bgTop: '#0f172a',
    bgBottom: '#090d16',
    glow: 'rgba(56, 189, 248, 0.15)'
  };

  const cx = w / 2;
  const cy = isLandscape ? h * 0.40 : h * 0.38;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="dateBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="${cfg.bgTop}"/>
      <stop offset="60%" stop-color="${cfg.bgBottom}"/>
      <stop offset="100%" stop-color="#05070b"/>
    </linearGradient>
    <radialGradient id="dateGlow" cx="50%" cy="38%" r="45%">
      <stop offset="0%" stop-color="${cfg.glow}"/>
      <stop offset="60%" stop-color="transparent"/>
    </radialGradient>
  </defs>

  <!-- Background -->
  <rect width="${w}" height="${h}" fill="url(#dateBg)"/>
  <rect width="${w}" height="${h}" fill="url(#dateGlow)"/>
  <rect x="1.5" y="1.5" width="${w - 3}" height="${h - 3}" rx="12" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1.5"/>

  <!-- Minimalist Calendar / Date Block -->
  <g transform="translate(${cx}, ${cy})">
    <!-- Calendar Card Frame -->
    <rect x="-55" y="-55" width="110" height="110" rx="18" 
          fill="rgba(255,255,255,0.04)" 
          stroke="rgba(255,255,255,0.12)" 
          stroke-width="1.5"/>
    <!-- Top colored bar of calendar -->
    <rect x="-55" y="-55" width="110" height="26" rx="6" fill="${cfg.accent}" opacity="0.85"/>
    <text x="0" y="-37" 
          font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif" 
          font-size="12" 
          font-weight="800" 
          letter-spacing="2" 
          fill="#ffffff" 
          text-anchor="middle">
      ${escapeXml(monthStr)}
    </text>
    <!-- Day Number -->
    <text x="0" y="24" 
          font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif" 
          font-size="${dayStr.length > 2 ? '28' : '44'}" 
          font-weight="800" 
          fill="#f8fafc" 
          text-anchor="middle">
      ${escapeXml(dayStr)}
    </text>
  </g>

  <!-- Year / Full Date -->
  <text x="50%" y="${isLandscape ? h * 0.74 : h * 0.62}" 
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif" 
        font-size="${isLandscape ? 18 : 22}" 
        font-weight="600" 
        letter-spacing="3" 
        fill="rgba(248,250,252,0.85)" 
        text-anchor="middle">
    ${escapeXml(displayDate)}
  </text>

  <!-- Matches Badge -->
  <g transform="translate(${cx}, ${isLandscape ? h * 0.86 : h * 0.72})">
    <rect x="-65" y="-14" width="130" height="28" rx="14" 
          fill="rgba(255,255,255,0.05)" 
          stroke="rgba(255,255,255,0.12)" 
          stroke-width="1"/>
    <text x="0" y="5" 
          font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif" 
          font-size="12" 
          font-weight="700" 
          letter-spacing="2" 
          fill="${cfg.accent}" 
          text-anchor="middle">
      ${Number(count) > 0 ? `${count} MATCHES` : 'REPLAYS'}
    </text>
  </g>
</svg>`;
}

// ─── Composed Match Card ─────────────────────────────────────────────────────
// A designed "broadcast" card for fixtures that have no official provider
// artwork. Pure string composition: every badge arrives already embedded as a
// data URI (done by ImageService), so this function performs no I/O and is
// directly unit-testable. It degrades gracefully from two badges, to one, to a
// purely typographic card, and always returns a complete SVG.

// Cinematic Broadcast tokens: film-grade warm/cool volumetrics on a near-black
// base. Condensed type for names, a neutral grotesque for chrome.
const CARD_COND = "'Arial Narrow','Roboto Condensed','Helvetica Neue',Arial,sans-serif";
const CARD_SANS = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const CARD_FALLBACK_ACCENT = '#ff7a1a';
const CARD_HOT = '#ff7a1a';
const CARD_HOT_SOFT = '#ff9a45';
const CARD_SAFE_MARGIN = 44;

/**
 * Very faint diagonal terracing.
 *
 * Deliberate texture instead of a decorative blob or a white wash: it reads as a
 * sports surface and adds depth without brightening the middle of the card.
 */
function pitchLines(w, h) {
  const out = [];
  const step = Math.max(48, Math.round(w / 12));
  for (let x = -h; x < w + h; x += step) {
    out.push('<line x1="' + x + '" y1="' + h + '" x2="' + (x + h) + '" y2="0" stroke="#ffffff" stroke-opacity="0.035" stroke-width="1"/>');
  }
  return out.join('');
}

function truncateLabel(value, maxChars) {
  const str = String(value === undefined || value === null ? '' : value).trim();
  if (!str) return '';
  if (str.length <= maxChars) return str;
  return str.slice(0, Math.max(1, maxChars - 1)).trimEnd() + '\u2026';
}

function badgeImage(dataUri, x, y, size) {
  return '<image href="' + dataUri + '" xlink:href="' + dataUri + '" x="' + x + '" y="' + y + '" width="' + size + '" height="' + size + '" preserveAspectRatio="xMidYMid meet"/>';
}

function buildHeroLines(spec, team1, team2, maxChars) {
  if (team1 && team2) return [team1, 'VS', team2];
  const raw = String(spec.title || spec.league || 'Live Sports').trim();
  const split = raw.split(/\s+(?:vs\.?|@|[-\u2013\u2014])\s+/i).map(s => s.trim()).filter(Boolean);
  const lines = split.length >= 2 ? [split[0], 'VS', split.slice(1).join(' - ')] : [raw];
  return lines.slice(0, 3).map(l => (l.toUpperCase() === 'VS' ? 'VS' : truncateLabel(l, maxChars))).filter(Boolean);
}

/** Truncate a single label so it fits the given pixel width at a given font size. */
function truncateToWidth(value, maxPx, fontSize) {
  const str = String(value === undefined || value === null ? '' : value).trim();
  if (!str) return '';
  // Condensed uppercase glyphs average ~0.5em; stay conservative at 0.56em.
  const maxChars = Math.max(6, Math.floor(maxPx / (fontSize * 0.56)));
  return truncateLabel(str, maxChars);
}

/**
 * Compose a premium match card.
 *
 * @param {object} spec
 * @param {string}  [spec.category]      sport/category key (accent + watermark + shape)
 * @param {string}  [spec.title]         event title, used when no team names exist
 * @param {string}  [spec.team1]         home team name
 * @param {string}  [spec.team2]         away team name
 * @param {string}  [spec.badge1]        home badge as an embedded data URI
 * @param {string}  [spec.badge2]        away badge as an embedded data URI
 * @param {string}  [spec.league]        competition name (header chip)
 * @param {string}  [spec.leagueBadge]   competition badge as an embedded data URI
 * @param {string}  [spec.channel]       channel/broadcaster name (footer chip)
 * @param {string}  [spec.channelBadge]  channel badge as an embedded data URI
 * @param {string}  [spec.channelMark]   channel logo to draw on the HERO slot
 *                                       (24/7 stations, where the logo IS the art)
 * @param {string}  [spec.status]        live | upcoming | replay | 247
 * @param {string}  [spec.score]         live/final score, e.g. "2:1"; ignored when implausible
 * @param {string}  [spec.time]          already-formatted display time
 * @param {string}  [spec.shape]         landscape (800x450, default) | poster (600x900)
 */
function generateMatchCardSvg(spec = {}) {
  const isPoster = spec.shape === 'poster';
  // Canvas ratios follow the Stremio meta spec: posterShape "landscape" = 1:1.77
  // (16:9) and "poster" = 1:0.675. Resolution is free, so we keep it modest.
  const w = isPoster ? 600 : 800;
  const h = isPoster ? 889 : 450;

  const catKey = String(spec.category || 'other').toLowerCase().trim();
  const cfg = SPORT_CONFIGS[catKey] || SPORT_CONFIGS.other;
  const accent = cfg.accent || CARD_FALLBACK_ACCENT;

  const margin = CARD_SAFE_MARGIN;
  const headerY = isPoster ? 54 : 54;

  const nameMax = isPoster ? 13 : 21;
  const team1 = truncateLabel(spec.team1, nameMax);
  const team2 = truncateLabel(spec.team2, nameMax);
  const leagueName = truncateLabel(spec.league, isPoster ? 20 : 26);
  const channelName = truncateLabel(spec.channel, 18);
  const timeText = truncateLabel(spec.time, 32);

  const badge1 = spec.badge1 || null;
  const badge2 = spec.badge2 || null;
  const leagueBadge = spec.leagueBadge || null;
  const channelBadge = spec.channelBadge || null;
  const channelMark = spec.channelMark || null;
  const available = (badge1 ? 1 : 0) + (badge2 ? 1 : 0);

  // Only a plausible H:MM / H-MM score is ever displayed. Anything else
  // (empty, "TBD", a stray title) is dropped rather than drawn as noise.
  const scoreRaw = String(spec.score === undefined || spec.score === null ? '' : spec.score).trim();
  const scoreText = /^\d{1,3}\s*[:\u2013\u2014-]\s*\d{1,3}$/.test(scoreRaw) ? scoreRaw : '';

  const stRaw = String(spec.status || '').toLowerCase();
  const status = (stRaw === 'live' || stRaw === 'upcoming' || stRaw === 'replay' || stRaw === '247') ? stRaw : '';

  // "2:3" -> "2 – 3" so the score reads as a scoreboard rather than a timestamp.
  const scoreBits = scoreText.split(/\s*[:\u2013\u2014-]\s*/);
  const scoreDisplay = scoreBits.length === 2 ? scoreBits[0] + ' \u2013 ' + scoreBits[1] : scoreText;
  // A live fixture's score IS the headline, so it takes the hero slot instead of
  // being reduced to a footnote in the status pill.
  const scoreHero = !!scoreText && (status === 'live' || status === 'replay');
  // League chrome follows the sport identity, but stays bright enough to read
  // on the dark base.
  const leagueAccent = accent;

  // The hero score is sized to the gap between the two crest plates rather than
  // fixed, so a two-digit score such as "10 – 12" shrinks instead of colliding
  // with the badges. Measured in condensed-bold glyph widths (~0.55em).
  const scoreLetterspace = isPoster ? 2.6 : 3;
  const heroGap = isPoster ? 250 : 300;
  const heroScoreSize = Math.max(
    30,
    Math.min(96, Math.floor((heroGap - (scoreDisplay.length - 1) * scoreLetterspace) / (scoreDisplay.length * 0.55)))
  );

  const parts = [];

  // ── Background ──
  // One deep neutral base, one soft arena light in the sport accent, faint
  // terracing for texture, then a bottom weight so the eye settles on the hero.
  // Deliberately NOT a stack of coloured washes: warm glow + teal glow + a white
  // streak + tint + vignette averaged into flat grey-brown and the teal fought
  // the accent.
  parts.push('<rect width="' + w + '" height="' + h + '" fill="url(#cardBg)"/>');
  parts.push('<rect width="' + w + '" height="' + h + '" fill="url(#arenaLight)"/>');
  parts.push('<g>' + pitchLines(w, h) + '</g>');
  parts.push('<rect width="' + w + '" height="' + h + '" fill="url(#floor)"/>');
  // Per-sport identity, confined to the edges. A full-card tint desaturated the
  // middle into grey; a corner wash keeps football and basketball cards
  // distinguishable at a glance without touching the hero area.
  parts.push('<rect width="' + w + '" height="' + h + '" fill="url(#sportTint)"/>');

  // ── Sport watermark (behind all content) ──
  const glyphOpacity = available === 0 ? 0.12 : 0.05;
  const glyphSize = isPoster ? 280 : 320;
  const gx = isPoster ? w - 70 : w - 140;
  const gy = isPoster ? h - 190 : h - 120;
  parts.push('<g transform="translate(' + gx.toFixed(1) + ', ' + gy.toFixed(1) + ') scale(' + (glyphSize / 72).toFixed(2) + ')" opacity="' + glyphOpacity + '">' + sportGlyphMarkup(catKey) + '</g>');

  // ── Frame ──
  parts.push('<rect x="1.5" y="1.5" width="' + (w - 3) + '" height="' + (h - 3) + '" rx="10" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="1.5"/>');
  parts.push('<rect x="0" y="0" width="' + w + '" height="3" fill="' + accent + '" opacity="0.95"/>');
  parts.push('<rect x="0" y="0" width="' + (w * 0.42).toFixed(1) + '" height="3" fill="' + CARD_HOT + '" opacity="0.95"/>');

  // ── Header: league chip (left) ──
  if (leagueName || leagueBadge) {
    const label = (leagueName || 'LIVE SPORTS').toUpperCase();
    let lx = margin;
    if (leagueBadge) {
      parts.push('<circle cx="' + (margin + 8) + '" cy="' + (headerY - 4) + '" r="9" fill="rgba(255,255,255,0.10)"/>');
      parts.push(badgeImage(leagueBadge, margin, headerY - 12, 16));
      lx = margin + 24;
    }
    parts.push('<text x="' + lx + '" y="' + (headerY + 1) + '" font-family="' + CARD_COND + '" font-size="14" font-weight="700" letter-spacing="2.2" fill="' + leagueAccent + '">' + escapeXml(label) + '</text>');
  }

  // ── Header: status pill (right) - status word only; the score lives in the hero slot ──
  if (status) {
    const conf = {
      live: { t: 'LIVE', dot: true, color: '#ff8a8a', dotColor: '#ff3b3b' },
      upcoming: { t: 'UPCOMING', dot: true, color: CARD_HOT_SOFT, dotColor: CARD_HOT },
      replay: { t: 'REPLAY', dot: false, color: CARD_HOT_SOFT },
      '247': { t: '24/7', dot: false, color: CARD_HOT_SOFT }
    }[status];
    const dotR = 4.5;

    // Status-only pill. A score is never squeezed in here: when a score exists
    // it takes the hero slot, so the pill stays a compact status chip.
    const pillW = 30 + (conf.dot ? dotR * 2 + 8 : 0) + conf.t.length * 8.8;
    const pillH = 26;
    const pillY = headerY - pillH / 2;
    const pillX = w - margin - pillW;
    const pillStroke = status === 'live' ? 'rgba(255,90,90,0.5)' : 'rgba(255,154,69,0.45)';
    const pillFill = status === 'live' ? 'rgba(255,60,60,0.14)' : 'rgba(255,122,26,0.12)';
    parts.push('<rect x="' + pillX.toFixed(1) + '" y="' + pillY.toFixed(1) + '" width="' + pillW.toFixed(1) + '" height="' + pillH + '" rx="' + (pillH / 2) + '" fill="' + pillFill + '" stroke="' + pillStroke + '" stroke-width="1"/>');
    let px = pillX + 15;
    if (conf.dot) {
      parts.push('<circle cx="' + (px + dotR).toFixed(1) + '" cy="' + headerY + '" r="' + dotR + '" fill="' + conf.dotColor + '"/>');
      px += dotR * 2 + 8;
    }
    parts.push('<text x="' + px.toFixed(1) + '" y="' + (headerY + 4).toFixed(1) + '" font-family="' + CARD_SANS + '" font-size="12" font-weight="800" letter-spacing="1.4" fill="' + conf.color + '">' + escapeXml(conf.t) + '</text>');

  }

  // Circular crest plates: soft glass disc, thin rim.
  //
  // Three cases, and the plate is never left as a bare ring in any of them:
  //   1. a crest resolved  -> draw it inside the disc;
  //   2. no crest, but the side is named -> draw the side's initial, so the slot
  //      still carries meaning instead of reading as a broken image;
  //   3. neither            -> omit the plate entirely.
  const crest = (cx, cy, r, img, label) => {
    if (!img) {
      const m = String(label === undefined || label === null ? '' : label).match(/\p{L}|\p{N}/u);
      if (!m) return '';
      const plateOnly = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="rgba(255,255,255,0.05)" stroke="rgba(255,255,255,0.13)" stroke-width="1.2"/>';
      return plateOnly +
        '<text x="' + cx + '" y="' + (cy + r * 0.33).toFixed(1) + '" font-family="' + CARD_COND + '" font-size="' + Math.round(r * 0.88) + '" font-weight="800" fill="url(#nameFill)" text-anchor="middle">' + escapeXml(m[0].toUpperCase()) + '</text>';
    }
    return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="rgba(255,255,255,0.045)" stroke="rgba(255,255,255,0.14)" stroke-width="1.2"/>' +
      badgeImage(img, cx - r * 0.66, cy - r * 0.66, r * 1.32);
  };

  const vsBadge = (mx, my, r) =>
    '<circle cx="' + mx + '" cy="' + my + '" r="' + r + '" fill="rgba(255,255,255,0.06)" stroke="' + CARD_HOT + '" stroke-width="1.5"/>' +
    '<text x="' + mx + '" y="' + (my + 5) + '" font-family="' + CARD_SANS + '" font-size="' + Math.round(r * 0.6) + '" font-weight="800" letter-spacing="1.5" fill="' + CARD_HOT_SOFT + '" text-anchor="middle">VS</text>';

  const teamName = (x, y, name, size) => name
    ? '<text x="' + x + '" y="' + y + '" font-family="' + CARD_COND + '" font-size="' + size + '" font-weight="700" letter-spacing="1.1" fill="url(#nameFill)" text-anchor="middle">' + escapeXml(name.toUpperCase()) + '</text>'
    : '';

  if (!isPoster) {
    // ── Landscape: cinematic fixture row ──
    if (scoreHero) {
      // Live scoreboard. The score is the hero: crests anchor the two sides,
      // names sit beneath them, and the score owns the centre of the card.
      parts.push(crest(168, 190, 76, badge1, team1));
      parts.push(crest(632, 190, 76, badge2, team2));
      parts.push('<text x="400" y="246" font-family="' + CARD_COND + '" font-size="' + heroScoreSize + '" font-weight="800" letter-spacing="' + scoreLetterspace + '" fill="url(#scoreFill)" text-anchor="middle">' + escapeXml(scoreDisplay) + '</text>');
      const heroRule = Math.min(heroGap * 0.5, scoreDisplay.length * heroScoreSize * 0.29);
      parts.push('<rect x="' + (400 - heroRule / 2).toFixed(1) + '" y="264" width="' + heroRule.toFixed(1) + '" height="3" rx="1.5" fill="' + CARD_HOT + '" opacity="0.85"/>');
      parts.push(teamName(168, 312, team1, 21));
      parts.push(teamName(632, 312, team2, 21));
      parts.push('<line x1="' + margin + '" y1="392" x2="' + (w - margin) + '" y2="392" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>');
    } else if (available === 2) {
      parts.push(crest(200, 188, 104, badge1, team1));
      parts.push(crest(600, 188, 104, badge2, team2));
      parts.push(vsBadge(400, 188, 30));
      parts.push(teamName(200, 346, team1, 25));
      parts.push(teamName(600, 346, team2, 25));
      parts.push('<line x1="' + margin + '" y1="392" x2="' + (w - margin) + '" y2="392" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>');
    } else if (available === 1) {
      const shownBadge = badge1 || badge2;
      const shownName = badge1 ? team1 : team2;
      const otherName = badge1 ? team2 : team1;
      parts.push(crest(400, 170, 96, shownBadge, shownName));
      parts.push(teamName(400, 312, shownName, 25));
      if (otherName) {
        parts.push('<text x="400" y="350" font-family="' + CARD_SANS + '" font-size="15" font-weight="600" letter-spacing="2" fill="rgba(255,255,255,0.60)" text-anchor="middle">' + escapeXml(otherName.toUpperCase()) + '</text>');
      }
      parts.push('<line x1="' + margin + '" y1="392" x2="' + (w - margin) + '" y2="392" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>');
    } else {
      // No fixture crests. If a channel logo exists it becomes the hero mark
      // (24/7 stations, where the logo IS the artwork); otherwise typographic.
      if (channelMark) {
        const heroName = truncateToWidth(spec.title || leagueName || channelName, 620, 34);
        parts.push('<circle cx="400" cy="180" r="98" fill="rgba(255,255,255,0.045)" stroke="rgba(255,255,255,0.14)" stroke-width="1.2"/>');
        parts.push(badgeImage(channelMark, 400 - 98 * 0.68, 180 - 98 * 0.68, 98 * 1.36));
        if (heroName) {
          parts.push('<text x="400" y="324" font-family="' + CARD_COND + '" font-size="34" font-weight="700" letter-spacing="1.1" fill="url(#nameFill)" text-anchor="middle">' + escapeXml(heroName.toUpperCase()) + '</text>');
        }
      } else {
        const heroLines = buildHeroLines(spec, team1, team2, 22);
        const fs = heroLines.length >= 3 ? 36 : heroLines.length === 2 ? 46 : 54;
        const lh = fs + 16;
        const startY = 200 - ((heroLines.length - 1) * lh) / 2;
        heroLines.forEach((line, i) => {
          const isVs = line.toUpperCase() === 'VS';
          parts.push('<text x="' + (w / 2) + '" y="' + (startY + i * lh + fs * 0.35).toFixed(1) + '" font-family="' + CARD_COND + '" font-size="' + (isVs ? Math.round(fs * 0.6) : fs) + '" font-weight="800" letter-spacing="' + (isVs ? 4 : 1) + '" fill="' + (isVs ? CARD_HOT_SOFT : 'url(#nameFill)') + '" text-anchor="middle">' + escapeXml(line) + '</text>');
        });
      }
      parts.push('<line x1="' + margin + '" y1="392" x2="' + (w - margin) + '" y2="392" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>');
    }
  } else {
    // ── Poster (2:3): cinematic vertical stack ──
    if (scoreHero) {
      // Same live scoreboard language, stacked for the portrait canvas.
      parts.push(crest(110, 296, 58, badge1, team1));
      parts.push(crest(490, 296, 58, badge2, team2));
      parts.push('<text x="300" y="322" font-family="' + CARD_COND + '" font-size="' + heroScoreSize + '" font-weight="800" letter-spacing="' + scoreLetterspace + '" fill="url(#scoreFill)" text-anchor="middle">' + escapeXml(scoreDisplay) + '</text>');
      const heroRule = Math.min(heroGap * 0.5, scoreDisplay.length * heroScoreSize * 0.29);
      parts.push('<rect x="' + (300 - heroRule / 2).toFixed(1) + '" y="338" width="' + heroRule.toFixed(1) + '" height="3" rx="1.5" fill="' + CARD_HOT + '" opacity="0.85"/>');
      parts.push(teamName(110, 390, team1, 20));
      parts.push(teamName(490, 390, team2, 20));
      parts.push('<line x1="' + margin + '" y1="512" x2="' + (w - margin) + '" y2="512" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>');
    } else if (available === 2) {
      parts.push(crest(186, 296, 78, badge1, team1));
      parts.push(crest(414, 296, 78, badge2, team2));
      parts.push(vsBadge(300, 296, 26));
      parts.push(teamName(186, 432, team1, 24));
      parts.push(teamName(414, 432, team2, 24));
      parts.push('<line x1="' + margin + '" y1="512" x2="' + (w - margin) + '" y2="512" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>');
    } else if (available === 1) {
      const shownBadge = badge1 || badge2;
      const shownName = badge1 ? team1 : team2;
      const otherName = badge1 ? team2 : team1;
      parts.push(crest(300, 286, 80, shownBadge, shownName));
      parts.push(teamName(300, 424, shownName, 24));
      if (otherName) {
        parts.push('<text x="300" y="462" font-family="' + CARD_SANS + '" font-size="15" font-weight="600" letter-spacing="2" fill="rgba(255,255,255,0.60)" text-anchor="middle">' + escapeXml(otherName.toUpperCase()) + '</text>');
      }
      parts.push('<line x1="' + margin + '" y1="532" x2="' + (w - margin) + '" y2="532" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>');
    } else {
      if (channelMark) {
        const heroName = truncateToWidth(spec.title || leagueName || channelName, 460, 34);
        parts.push('<circle cx="300" cy="240" r="98" fill="rgba(255,255,255,0.045)" stroke="rgba(255,255,255,0.14)" stroke-width="1.2"/>');
        parts.push(badgeImage(channelMark, 300 - 98 * 0.68, 240 - 98 * 0.68, 98 * 1.36));
        if (heroName) {
          parts.push('<text x="300" y="384" font-family="' + CARD_COND + '" font-size="34" font-weight="700" letter-spacing="1.1" fill="url(#nameFill)" text-anchor="middle">' + escapeXml(heroName.toUpperCase()) + '</text>');
        }
      } else {
        const heroLines = buildHeroLines(spec, team1, team2, 16);
        const fs = heroLines.length >= 3 ? 38 : heroLines.length === 2 ? 48 : 56;
        const lh = fs + 18;
        const startY = 400 - ((heroLines.length - 1) * lh) / 2;
        heroLines.forEach((line, i) => {
          const isVs = line.toUpperCase() === 'VS';
          parts.push('<text x="' + (w / 2) + '" y="' + (startY + i * lh + fs * 0.35).toFixed(1) + '" font-family="' + CARD_COND + '" font-size="' + (isVs ? Math.round(fs * 0.6) : fs) + '" font-weight="800" letter-spacing="' + (isVs ? 4 : 1) + '" fill="' + (isVs ? CARD_HOT_SOFT : 'url(#nameFill)') + '" text-anchor="middle">' + escapeXml(line) + '</text>');
        });
      }
      parts.push('<line x1="' + margin + '" y1="560" x2="' + (w - margin) + '" y2="560" stroke="rgba(255,255,255,0.14)" stroke-width="1"/>');
    }
  }

  // ── Footer: centred time + channel mark ──
  const footerY = isPoster ? h - 58 : 412;
  if (timeText) {
    parts.push('<text x="' + (w / 2) + '" y="' + footerY + '" font-family="' + CARD_SANS + '" font-size="14" font-weight="600" letter-spacing="2" fill="rgba(255,255,255,0.68)" text-anchor="middle">' + escapeXml(timeText.toUpperCase()) + '</text>');
  }
  if (channelName || channelBadge) {
    const label = channelName.toUpperCase();
    const chipW = (channelBadge ? 20 + 8 : 0) + label.length * 7.8;
    let px = w - margin - chipW;
    if (channelBadge) {
      parts.push(badgeImage(channelBadge, px, footerY - 14, 20));
      px += 28;
    }
    if (label) {
      parts.push('<text x="' + px.toFixed(1) + '" y="' + (footerY + 3) + '" font-family="' + CARD_SANS + '" font-size="12.5" font-weight="600" letter-spacing="1.4" fill="rgba(255,255,255,0.58)">' + escapeXml(label) + '</text>');
    }
  }

  const defs = '<defs>' +
    // Deep neutral graphite with a slight cool bias. Avoids both pure black and
    // the warm brown cast the previous orange-based base introduced.
    '<linearGradient id="cardBg" x1="0%" y1="0%" x2="0%" y2="100%">' +
      '<stop offset="0%" stop-color="#141821"/>' +
      '<stop offset="52%" stop-color="#0d1017"/>' +
      '<stop offset="100%" stop-color="#07090d"/>' +
    '</linearGradient>' +
    // A single soft overhead light in the sport accent. This is the only
    // large-area colour on the card, so the accent never competes with itself.
    '<radialGradient id="arenaLight" cx="50%" cy="-14%" r="92%">' +
      '<stop offset="0%" stop-color="' + accent + '" stop-opacity="0.22"/>' +
      '<stop offset="42%" stop-color="' + accent + '" stop-opacity="0.06"/>' +
      '<stop offset="100%" stop-color="' + accent + '" stop-opacity="0"/>' +
    '</radialGradient>' +
    // Bottom weight: darkens toward the footer so the crests and hero sit on
    // solid ground instead of floating in haze.
    '<linearGradient id="floor" x1="0%" y1="0%" x2="0%" y2="100%">' +
      '<stop offset="0%" stop-color="#000000" stop-opacity="0"/>' +
      '<stop offset="62%" stop-color="#000000" stop-opacity="0.14"/>' +
      '<stop offset="100%" stop-color="#000000" stop-opacity="0.52"/>' +
    '</linearGradient>' +
    // Per-sport identity: a corner-biased wash of the sport accent. Kept away
    // from the centre so it never desaturates the hero.
    '<radialGradient id="sportTint" cx="6%" cy="4%" r="78%">' +
      '<stop offset="0%" stop-color="' + accent + '" stop-opacity="0.20"/>' +
      '<stop offset="40%" stop-color="' + accent + '" stop-opacity="0.05"/>' +
      '<stop offset="100%" stop-color="' + accent + '" stop-opacity="0"/>' +
    '</radialGradient>' +
    '<linearGradient id="nameFill" x1="0%" y1="0%" x2="0%" y2="100%">' +
      '<stop offset="0%" stop-color="#ffffff"/>' +
      '<stop offset="100%" stop-color="#c9cfda"/>' +
    '</linearGradient>' +
    // The hero score reads brightest at the top and falls off, so it holds up
    // against the light behind it without needing a plate.
    '<linearGradient id="scoreFill" x1="0%" y1="0%" x2="0%" y2="100%">' +
      '<stop offset="0%" stop-color="#ffffff"/>' +
      '<stop offset="72%" stop-color="#f2f5f9"/>' +
      '<stop offset="100%" stop-color="#c2c9d6"/>' +
    '</linearGradient>' +
  '</defs>';

  return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">\n  ' +
    defs + '\n  ' + parts.join('\n  ') + '\n</svg>';
}

function escapeXml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

module.exports = {
  SPORT_CONFIGS,
  generateSportSvg,
  generateDateSvg,
  generateMatchCardSvg,
  sportGlyphMarkup
};
