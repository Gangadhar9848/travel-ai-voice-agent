// Animated sunset-beach illustration (pure SVG, no external images).

const LEAF = 'M0 0 C 45 -28, 105 -22, 150 22 C 108 -4, 52 -6, 0 0 Z';

function Palm({ x, y, height, lean = 0, scale = 1, flip = false }) {
  const topX = x + lean;
  const topY = y - height;
  const angles = [-160, -130, -100, -60, -25, 10, 35];
  return (
    <g className="palm" style={{ transformOrigin: `${topX}px ${topY}px` }}>
      <path
        d={`M${x} ${y} Q ${x + lean * 0.2} ${y - height * 0.55}, ${topX} ${topY}`}
        stroke="var(--silhouette)"
        strokeWidth={14 * scale}
        strokeLinecap="round"
        fill="none"
      />
      <g transform={`translate(${topX} ${topY}) scale(${flip ? -scale : scale} ${scale})`}>
        {angles.map((a) => (
          <path key={a} d={LEAF} fill="var(--silhouette)" transform={`rotate(${a})`} />
        ))}
        <circle r="9" fill="var(--silhouette)" />
      </g>
    </g>
  );
}

export default function Scene() {
  return (
    <svg className="scene" viewBox="0 0 1600 900" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0b1455" />
          <stop offset="0.35" stopColor="#3b2f7a" />
          <stop offset="0.58" stopColor="#c8527a" />
          <stop offset="0.72" stopColor="#ff8a5c" />
          <stop offset="0.8" stopColor="#ffc07a" />
        </linearGradient>
        <radialGradient id="sunGlow">
          <stop offset="0" stopColor="#fff3c4" stopOpacity="0.95" />
          <stop offset="0.35" stopColor="#ffd07a" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ff8a5c" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="sun" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff6d0" />
          <stop offset="1" stopColor="#ffb25e" />
        </linearGradient>
        <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6a4f93" />
          <stop offset="0.25" stopColor="#2e4a8f" />
          <stop offset="1" stopColor="#081a4a" />
        </linearGradient>
        <linearGradient id="sand" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f2b87a" />
          <stop offset="1" stopColor="#c9804f" />
        </linearGradient>
        <linearGradient id="trail" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.7" />
        </linearGradient>
      </defs>

      {/* Sky */}
      <rect width="1600" height="900" fill="url(#sky)" />

      {/* Stars */}
      <g fill="#fff">
        {[
          [120, 60], [260, 140], [410, 50], [560, 110], [720, 40], [880, 120], [1020, 70],
          [1180, 150], [1330, 60], [1480, 120], [200, 230], [640, 210], [1400, 220], [960, 200],
        ].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r={i % 3 ? 1.3 : 2} className="star" style={{ animationDelay: `${(i % 5) * 0.7}s` }} />
        ))}
      </g>

      {/* Sun */}
      <circle cx="1060" cy="590" r="330" fill="url(#sunGlow)" className="glow" />
      <circle cx="1060" cy="590" r="105" fill="url(#sun)" />

      {/* Clouds */}
      <g className="clouds" fill="#ffd9c2" opacity="0.35">
        <ellipse cx="300" cy="330" rx="160" ry="16" />
        <ellipse cx="380" cy="312" rx="90" ry="12" />
        <ellipse cx="1300" cy="380" rx="190" ry="14" />
        <ellipse cx="1220" cy="364" rx="80" ry="10" />
        <ellipse cx="760" cy="420" rx="130" ry="9" />
      </g>

      {/* Plane + contrail */}
      <g className="plane">
        <rect x="-260" y="-1.5" width="250" height="3" rx="1.5" fill="url(#trail)" />
        <path
          d="M0 0 L-8 -3 L-26 -3 L-38 -14 L-44 -14 L-36 -3 L-52 -3 L-58 -9 L-62 -9 L-58 0 L-62 9 L-58 9 L-52 3 L-36 3 L-44 14 L-38 14 L-26 3 L-8 3 Z"
          fill="#fff"
          opacity="0.9"
          transform="scale(0.9)"
        />
      </g>

      {/* Distant islands */}
      <path d="M0 610 C 120 560, 230 585, 330 600 C 420 570, 520 575, 600 610 Z" fill="#4a2d6b" opacity="0.8" />
      <path d="M1250 610 C 1330 540, 1440 560, 1600 590 L1600 610 Z" fill="#4a2d6b" opacity="0.8" />

      {/* Sea */}
      <rect y="608" width="1600" height="292" fill="url(#sea)" />

      {/* Sun reflection */}
      <g className="shimmer" fill="#ffd9a0">
        <rect x="990" y="622" width="140" height="4" rx="2" opacity="0.8" />
        <rect x="1005" y="640" width="110" height="4" rx="2" opacity="0.65" />
        <rect x="1020" y="660" width="80" height="3" rx="2" opacity="0.55" />
        <rect x="1000" y="682" width="120" height="3" rx="2" opacity="0.4" />
        <rect x="1030" y="706" width="60" height="3" rx="2" opacity="0.35" />
        <rect x="1010" y="732" width="100" height="2" rx="1" opacity="0.25" />
      </g>

      {/* Waves */}
      <g fill="none" stroke="#ffffff" strokeLinecap="round">
        <path className="wave w1" d="M-100 700 q 50 -8 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0 t 100 0" strokeWidth="1.5" opacity="0.12" />
        <path className="wave w2" d="M-100 760 q 60 -10 120 0 t 120 0 t 120 0 t 120 0 t 120 0 t 120 0 t 120 0 t 120 0 t 120 0 t 120 0 t 120 0 t 120 0 t 120 0 t 120 0 t 120 0 t 120 0" strokeWidth="2" opacity="0.1" />
      </g>

      {/* Sailboat */}
      <g transform="translate(620 640)"><g className="boat">
        <path d="M-26 0 L26 0 L18 9 L-18 9 Z" fill="var(--silhouette)" />
        <path d="M0 -2 L0 -52 L24 -4 Z" fill="var(--silhouette)" />
        <path d="M-3 -4 L-3 -40 L-20 -4 Z" fill="var(--silhouette)" />
      </g></g>

      {/* Birds */}
      <g transform="translate(420 260)"><g className="birds" fill="none" stroke="var(--silhouette)" strokeWidth="2.2" strokeLinecap="round">
        <path d="M0 0 q 8 -8 16 0 q 8 -8 16 0" />
        <path d="M40 -22 q 6 -6 12 0 q 6 -6 12 0" />
        <path d="M-30 -30 q 5 -5 10 0 q 5 -5 10 0" />
      </g></g>

      {/* Beach */}
      <path d="M0 820 C 260 770, 560 790, 820 850 C 1050 900, 1300 850, 1600 800 L1600 900 L0 900 Z" fill="url(#sand)" />
      <path d="M0 820 C 260 770, 560 790, 820 850 C 1050 900, 1300 850, 1600 800" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="3" />

      {/* Palms */}
      <Palm x={140} y={905} height={420} lean={60} scale={1.25} />
      <Palm x={280} y={915} height={300} lean={-40} scale={0.95} flip />
      <Palm x={1480} y={905} height={380} lean={-70} scale={1.15} flip />
    </svg>
  );
}
