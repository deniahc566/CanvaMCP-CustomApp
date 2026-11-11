// A small slide that touches every kind of element scripts/svg2canva.mjs converts.
export const sampleSvg = `<svg width="1280" height="720" viewBox="0 0 1280 720" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#01382F"/>
      <stop offset="100%" stop-color="#0C8067"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1280" height="720" fill="url(#bg)"/>
  <rect x="100" y="100" width="200" height="50" fill="#FFFFFF"/>
  <rect x="100" y="200" width="200" height="50" rx="8" fill="#FFFFFF" fill-opacity="0.1" stroke="#FFFFFF" stroke-opacity="0.3" stroke-width="2" stroke-dasharray="4,4"/>
  <g transform="translate(10,20)" opacity="0.5" fill="#F5B301">
    <circle cx="50" cy="50" r="10"/>
  </g>
  <line x1="64" y1="300" x2="1216" y2="300" stroke="#FFFFFF" stroke-opacity="0.2"/>
  <path d="M10 10 L20 20 L10 30" fill="none" stroke="#F5B301" stroke-width="4"/>
  <path d="M400 400 q50 -50 100 0 t100 0 z" fill="#123456"/>
  <text x="72" y="70" font-size="20" font-weight="700" letter-spacing="2" fill="#F5B301">Title<tspan x="72" dy="24" fill="#FFFFFF" font-weight="400">Second line</tspan></text>
  <text x="640" y="600" font-size="16" text-anchor="middle" fill="#FFFFFF" fill-opacity="0.5">Centered</text>
  <image href="photo.png" x="0" y="0" width="10" height="10"/>
</svg>`;
