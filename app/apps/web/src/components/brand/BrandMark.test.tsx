// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emitFiled, onFiled } from '../../lib/brandEvents';
import { BrandMark } from './BrandMark';

// jsdom has no AnimationEvent, so React DOM would listen for webkitAnimationEnd and miss these events.
// Define a minimal one before react-dom loads (vi.hoisted runs ahead of the imports).
vi.hoisted(() => {
  if (!('AnimationEvent' in globalThis)) {
    class AnimationEventStub extends Event {
      animationName: string;
      constructor(type: string, init: EventInit & { animationName?: string } = {}) {
        super(type, init);
        this.animationName = init.animationName ?? '';
      }
    }
    Object.assign(globalThis, { AnimationEvent: AnimationEventStub });
  }
});

afterEach(cleanup);

const svgOf = (c: HTMLElement) => c.querySelector('svg')!;
const light = (c: HTMLElement) => c.querySelector('.bm-light')!;
const end = (c: HTMLElement, animationName: string) => fireEvent.animationEnd(light(c), { animationName });

describe('BrandMark (WO-3, WO-4, WO-5)', () => {
  it('maps the state to the light fill and keeps the tile in currentColor', () => {
    const fills = (['quiet', 'attention', 'filed'] as const).map((state) => {
      const { container } = render(<BrandMark state={state} size={64} />);
      expect(container.querySelector('path')!.getAttribute('fill')).toBe('currentColor');
      expect(container.querySelector('path')!.getAttribute('fill-rule')).toBe('evenodd');
      return light(container).getAttribute('fill');
    });
    expect(fills).toEqual(['currentColor', 'var(--mark-attention)', 'var(--mark-filed)']);
  });

  it('is aria-hidden without a title, and role="img" with one', () => {
    const { container, rerender } = render(<BrandMark />);
    expect(svgOf(container).getAttribute('aria-hidden')).toBe('true');
    expect(svgOf(container).getAttribute('role')).toBeNull();
    rerender(<BrandMark title="Work OS" />);
    expect(svgOf(container).getAttribute('role')).toBe('img');
    expect(svgOf(container).getAttribute('aria-hidden')).toBeNull();
    expect(container.querySelector('title')!.textContent).toBe('Work OS');
  });

  it('picks the viewBox by size only: tight crop at 32px and below, room for motion above', () => {
    const box = (size: number, checking = false) => svgOf(render(<BrandMark size={size} checking={checking} />).container).getAttribute('viewBox');
    expect(box(16)).toBe('6 6 52 52');
    expect(box(32)).toBe('6 6 52 52');
    expect(box(33)).toBe('-4 -8 72 72');
    expect(box(88)).toBe('-4 -8 72 72');
    expect(box(88, true)).toBe('-4 -8 72 72');
  });

  it('fills the socket at 16px when the light is coloured, not when quiet', () => {
    const r = (size: number, state: 'quiet' | 'attention' | 'filed') => light(render(<BrandMark size={size} state={state} />).container).getAttribute('r');
    expect(r(16, 'attention')).toBe('6.5');
    expect(r(16, 'filed')).toBe('6.5');
    expect(r(16, 'quiet')).toBe('4');
    expect(r(17, 'attention')).toBe('4');
  });

  it('marks 32px and below as small, so needs you only changes colour', () => {
    expect(svgOf(render(<BrandMark size={26} />).container).classList.contains('bm-small')).toBe(true);
    expect(svgOf(render(<BrandMark size={48} />).container).classList.contains('bm-small')).toBe(false);
  });
});

describe('BrandMark one-off animations (WO-6)', () => {
  it('does not play on mount, plays once per new playKey and clears on the light’s animationend', () => {
    const { container, rerender } = render(<BrandMark state="attention" playKey={0} />);
    expect(svgOf(container).classList.contains('bm-nd')).toBe(false);
    rerender(<BrandMark state="attention" playKey={1} />);
    expect(svgOf(container).classList.contains('bm-nd')).toBe(true);
    expect(container.querySelectorAll('.bm-ring')).toHaveLength(2);
    end(container, 'ndRing'); // a ring ending is not the end of the run
    expect(svgOf(container).classList.contains('bm-nd')).toBe(true);
    end(container, 'ndLight');
    expect(svgOf(container).classList.contains('bm-nd')).toBe(false);
    expect(container.querySelectorAll('.bm-ring')).toHaveLength(0);
  });

  it('restarts a running animation on a new playKey by remounting the animated group', () => {
    const { container, rerender } = render(<BrandMark state="attention" playKey={0} />);
    rerender(<BrandMark state="attention" playKey={1} />);
    const before = container.querySelector('.bm-body');
    rerender(<BrandMark state="attention" playKey={2} />);
    expect(container.querySelector('.bm-body')).not.toBe(before);
    expect(svgOf(container).classList.contains('bm-nd')).toBe(true);
  });

  it('plays filed over a quiet or attention resting state, and never animates quiet', () => {
    const { container, rerender } = render(<BrandMark state="quiet" playKey={0} />);
    rerender(<BrandMark state="quiet" playKey={1} />);
    expect(svgOf(container).getAttribute('class')).not.toMatch(/bm-(nd|fl)/);
    rerender(<BrandMark state="quiet" play="filed" playKey={2} />);
    expect(svgOf(container).classList.contains('bm-fl')).toBe(true);
    expect(light(container).getAttribute('fill')).toBe('currentColor'); // the resting colour is unchanged
    end(container, 'flLight');
    expect(svgOf(container).classList.contains('bm-fl')).toBe(false);
  });

  it('lets attention win over a filed request while it plays, and replace a running filed', () => {
    const { container, rerender } = render(<BrandMark state="attention" playKey={0} />);
    rerender(<BrandMark state="attention" play="attention" playKey={1} />);
    rerender(<BrandMark state="attention" play="filed" playKey={2} />);
    expect(svgOf(container).classList.contains('bm-nd')).toBe(true);
    end(container, 'ndLight');
    rerender(<BrandMark state="attention" play="filed" playKey={3} />);
    expect(svgOf(container).classList.contains('bm-fl')).toBe(true);
    rerender(<BrandMark state="attention" play="attention" playKey={4} />);
    expect(svgOf(container).classList.contains('bm-nd')).toBe(true);
  });

  it('clears the reduced-motion stand-ins too', () => {
    const { container, rerender } = render(<BrandMark state="quiet" playKey={0} />);
    rerender(<BrandMark state="quiet" play="filed" playKey={1} />);
    end(container, 'flLightStill');
    expect(svgOf(container).classList.contains('bm-fl')).toBe(false);
  });
});

describe('BrandMark checking sources (WO-6)', () => {
  const iterate = (c: HTMLElement) => fireEvent.animationIteration(c.querySelector('.bm-body')!, { animationName: 'ckHop' });

  it('loops while checking and stops only at the end of a cycle', () => {
    const { container, rerender } = render(<BrandMark size={88} checking />);
    expect(svgOf(container).classList.contains('bm-ck')).toBe(true);
    iterate(container); // still checking: keeps going
    expect(svgOf(container).classList.contains('bm-ck')).toBe(true);
    rerender(<BrandMark size={88} checking={false} />);
    expect(svgOf(container).classList.contains('bm-ck')).toBe(true); // mid-cycle: no snap
    iterate(container);
    expect(svgOf(container).classList.contains('bm-ck')).toBe(false);
  });

  it('does not check below 48px', () => {
    const { container } = render(<BrandMark size={32} checking />);
    expect(svgOf(container).classList.contains('bm-ck')).toBe(false);
  });

  it('stops at once with reduced motion, where no iteration events fire', () => {
    const mm = vi.fn().mockReturnValue({ matches: true });
    vi.stubGlobal('matchMedia', mm);
    try {
      const { container, rerender } = render(<BrandMark size={88} checking />);
      rerender(<BrandMark size={88} checking={false} />);
      expect(svgOf(container).classList.contains('bm-ck')).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('brandEvents (WO-14)', () => {
  it('delivers emitFiled to subscribers and coalesces a burst into one', () => {
    const cb = vi.fn();
    const off = onFiled(cb);
    act(() => {
      emitFiled(10_000);
      emitFiled(10_200);
    });
    expect(cb).toHaveBeenCalledTimes(1);
    emitFiled(10_600);
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    emitFiled(20_000);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
