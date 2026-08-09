// ProductSwitch — the segmented Merv | Nisa tabs at the top of the sidebar;
// the app's only brand mark. Each product is its own SPA under one origin,
// so crossing over is a plain full-page anchor, never a router link.

// Icons share the sidebar's 24-grid stroke language (see IconSidebar).
const GLYPH = {
  width: 13,
  height: 13,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
};

// Merv: an Erlenmeyer flask — the experiments suite.
function IconFlask() {
  return (
    <svg {...GLYPH}>
      <path d="M9.5 3h5" />
      <path d="M10 3v5.2L4.8 16.6a2.4 2.4 0 0 0 2.1 3.4h10.2a2.4 2.4 0 0 0 2.1-3.4L14 8.2V3" />
      <path d="M7 14h10" />
    </svg>
  );
}

// Map: a small constellation — the literature map.
function IconConstellation() {
  return (
    <svg {...GLYPH}>
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="12" cy="6" r="2.2" />
      <circle cx="18" cy="16" r="2.2" />
      <path d="M7 16 11 8" />
      <path d="m13.1 7.9 3.8 6.2" />
      <path d="m8.2 17.6 7.6-1.2" />
    </svg>
  );
}

// Dev runs the products on separate ports; production mounts both on one
// origin (rapidreview.io/nisa + /merv), so the cross-link is a same-origin path.
const IS_DEV_HOST = /^(localhost|127\.)/.test(window.location.hostname);
const MAP_HREF = IS_DEV_HOST ? 'http://localhost:4000/nisa/' : '/nisa';

// Nisa sits left, Merv right.
const PRODUCTS = [
  { id: 'map', label: 'Nisa', href: MAP_HREF, Icon: IconConstellation },
  { id: 'merv', label: 'Merv', href: '/', Icon: IconFlask },
];

export default function ProductSwitch({ active = 'merv' }) {
  return (
    <nav className="product-switch" aria-label="Product">
      {PRODUCTS.map(({ id, label, href, Icon }) =>
        id === active ? (
          <span key={id} className="product-tab product-tab--active" aria-current="true">
            <Icon />{label}
          </span>
        ) : (
          <a key={id} className="product-tab" href={href}>
            <Icon />{label}
          </a>
        )
      )}
    </nav>
  );
}
