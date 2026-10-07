import type { SVGProps } from 'react';

// Icon paths lifted from the Work OS design artboards (24×24, stroke 2).
const PATHS = {
  inbox: <><path d="M3 13h5l2 3h4l2-3h5" /><path d="M5 5h14l2 8v6H3v-6l2-8z" /></>,
  commitments: <><path d="M10 6h11M10 12h11M10 18h11" /><path d="m3 6 1.5 1.5L7 5M3 12l1.5 1.5L7 11" /></>,
  briefs: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>,
  usage: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  poll: <><path d="M20 12a8 8 0 1 1-2.3-5.7L20 8" /><path d="M20 3v5h-5" /></>,
  dollar: <><circle cx="12" cy="12" r="9" /><path d="M15 9.5c0-1.4-1.3-2.5-3-2.5s-3 1-3 2.3c0 3 6 1.7 6 4.9 0 1.3-1.3 2.3-3 2.3s-3-1.1-3-2.5M12 5.5V7M12 17v1.5" /></>,
  hash: <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />,
  dm: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></>,
  meet: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  commit: <><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
  check: <path d="m5 12 5 5 9-10" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  back: <path d="M15 18l-6-6 6-6" />,
  up: <path d="M6 15l6-6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  expand: <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7" />,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" />,
  confluence: <><path d="M6 3h9l5 5v13H6z" /><path d="M14 3v6h6" /></>,
  vault: <><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 19V5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  edit: <path d="M4 20h4L19 9l-4-4L4 16z" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  arrow: <path d="M5 12h14M13 6l6 6-6 6" />,
  alert: <><path d="M12 3 2 20h20L12 3z" /><path d="M12 10v4M12 17v.5" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.5" /></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" /><path d="M10 21h4" /></>,
  flask: <><path d="M9 3h6M10 3v6l-6 10a1.5 1.5 0 0 0 1.3 2h13.4a1.5 1.5 0 0 0 1.3-2L14 9V3" /><path d="M7 15h10" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>,
  wifiOff: <><path d="M2 2l20 20" /><path d="M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.6M19 13a10 10 0 0 0-2.3-1.6M2 9.5a15 15 0 0 1 4.5-2.8M22 9.5A15 15 0 0 0 11 6" /><path d="M12 20h.01" /></>,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  sparkle: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6" />,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
  book: <><path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z" /><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z" /></>, // the guide
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5z" /><path d="m3 13 9 5 9-5" /></>, // topics: pieces stacked into one
  split: <path d="M16 3h5v5M8 3H3v5M21 3l-7 7M3 3l7 7M12 14v7" />, // a piece out of its topic
  // Action buttons and the draft editor toolbar (Lucide-style, to match the set above).
  trash: <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>,
  redraft: <><path d="M4 12a8 8 0 0 1 13.7-5.7L20 8.5" /><path d="M20 4v4.5h-4.5" /><path d="M20 12a8 8 0 0 1-13.7 5.7L4 15.5" /><path d="M4 20v-4.5h4.5" /></>,
  bold: <path d="M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z" />,
  italic: <path d="M19 4h-9M14 20H5M15 4 9 20" />,
  code: <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />,
  heading: <path d="M6 4v16M18 4v16M6 12h12" />,
  listBullet: <><path d="M9 6h12M9 12h12M9 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" strokeWidth="3" /></>,
  listOrdered: <><path d="M10 6h11M10 12h11M10 18h11" /><path d="M4 4h1v4M4 8h2M6 18H4l2-2.5a1 1 0 0 0-2-.5" /></>,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, strokeWidth = 2, ...rest }: { name: IconName; size?: number; strokeWidth?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {PATHS[name]}
    </svg>
  );
}

export function MoreIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

export function DragIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {[6, 12, 18].flatMap((y) => [<circle key={`a${y}`} cx="9" cy={y} r="1.6" />, <circle key={`b${y}`} cx="15" cy={y} r="1.6" />])}
    </svg>
  );
}
