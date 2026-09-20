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
  generateDateSvg
};
