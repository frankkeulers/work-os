import { useState, type AnimationEvent, type CSSProperties } from 'react';
import { cx } from '../ui';
import { LIGHT, TILE, VIEWBOX_ROOMY, VIEWBOX_TIGHT } from './paths';

// The Work OS mark: a status tile whose light shows the app's state (specs/WORKOS-IDENTITY.md §5.1).
// The viewBox depends on size only, never on whether an animation runs, so nothing jumps when one starts.

export type MarkState = 'quiet' | 'attention' | 'filed';
type OneOff = 'attention' | 'filed';

const FILL: Record<MarkState, string> = { quiet: 'currentColor', attention: 'var(--mark-attention)', filed: 'var(--mark-filed)' };
const ANIM = { attention: 'nd', filed: 'fl' } as const;
/** The light's animation ends the run; the rings and the tilt finish on or before it. */
const RUN_ENDS = new Set(['ndLight', 'flLight', 'ndLightStill', 'flLightStill']);

const reducedMotion = () => (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) || false;

export function BrandMark({ size = 24, state = 'quiet', playKey, play, checking = false, title, className }: {
  size?: number;
  /** The resting light colour. */
  state?: MarkState;
  /** Changing it plays `play` (default: `state`) once. Quiet never animates. */
  playKey?: number;
  /** The one-off animation the next `playKey` plays, when it differs from the resting state (filed over attention). */
  play?: OneOff;
  /** Loops "checking sources" while true, at 48px and up. When it turns false, the current cycle finishes. */
  checking?: boolean;
  /** Set it, and the mark is role="img" with a <title>; leave it out, and it is aria-hidden. */
  title?: string;
  className?: string;
}) {
  const small = size <= 32;
  const canCheck = size >= 48;

  // A new playKey starts a one-off; attention wins over a filed request that arrives while it plays.
  const [seenKey, setSeenKey] = useState(playKey);
  const [run, setRun] = useState<{ anim: OneOff; key: number } | null>(null);
  if (playKey !== seenKey) {
    setSeenKey(playKey);
    const anim = play ?? state;
    if (playKey !== undefined && anim !== 'quiet' && !(anim === 'filed' && run?.anim === 'attention')) setRun({ anim, key: playKey });
  }

  // Checking starts at once and stops only at the end of a cycle (or at once when nothing moves).
  const [looping, setLooping] = useState(checking && canCheck);
  if (checking && canCheck && !looping) setLooping(true);
  if (looping && (!canCheck || (!checking && reducedMotion()))) setLooping(false);

  const onAnimationEnd = (e: AnimationEvent) => {
    if (RUN_ENDS.has(e.animationName)) setRun(null);
  };
  const onAnimationIteration = (e: AnimationEvent) => {
    if (e.animationName === 'ckHop' && !checking) setLooping(false);
  };

  const anim = run ? ANIM[run.anim] : looping ? 'ck' : undefined;
  const fill = FILL[state];
  const r = size <= 16 && state !== 'quiet' ? LIGHT.rFull : LIGHT.r;

  return (
    <svg
      width={size}
      height={size}
      viewBox={small ? VIEWBOX_TIGHT : VIEWBOX_ROOMY}
      className={cx('bm', small && 'bm-small', anim && `bm-${anim}`, className)}
      data-mark-state={state}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      onAnimationEnd={onAnimationEnd}
      onAnimationIteration={onAnimationIteration}
    >
      {title && <title>{title}</title>}
      <g key={run?.key} className="bm-body">
        <path fill="currentColor" fillRule="evenodd" d={TILE} />
        {run && (
          <>
            <circle className="bm-ring bm-ring1" cx={LIGHT.cx} cy={LIGHT.cy} r={LIGHT.r} fill="none" strokeWidth={0.9} />
            <circle className="bm-ring bm-ring2" cx={LIGHT.cx} cy={LIGHT.cy} r={LIGHT.r} fill="none" strokeWidth={0.6} />
          </>
        )}
        <circle className="bm-light" cx={LIGHT.cx} cy={LIGHT.cy} r={r} fill={fill} style={{ '--light-rest': fill } as CSSProperties} />
      </g>
    </svg>
  );
}
