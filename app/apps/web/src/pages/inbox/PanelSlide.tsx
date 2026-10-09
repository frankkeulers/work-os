import type { ReactNode, Ref } from 'react';
import type { Blocker } from 'react-router';
import { ConfirmDialog, cx } from '../../components/ui';

/**
 * The panel's slide-out over the right of the list, with the scrim behind it: the Inbox's item
 * panel, and a source history's (cockpit CK-5). It stays on screen while it slides out, then calls
 * onSlidOut.
 */
export function PanelSlide({ closing = false, panelRef, onSlidOut, className, children }: { closing?: boolean; panelRef?: Ref<HTMLDivElement>; onSlidOut?: () => void; className?: string; children: ReactNode }) {
  return (
    <>
      {/* Visual only: the list stays scrollable and its rows still switch the item. */}
      <div aria-hidden="true" data-state={closing ? 'closed' : 'open'} className="item-panel-backdrop pointer-events-none absolute inset-0 z-20 bg-scrim" />
      <div
        ref={panelRef}
        data-state={closing ? 'closed' : 'open'}
        inert={closing}
        onAnimationEnd={(e) => e.target === e.currentTarget && closing && onSlidOut?.()}
        className={cx('item-panel absolute inset-y-0 right-0 z-30 flex w-full flex-col', className)}
      >
        {children}
      </div>
    </>
  );
}

/** Asked before leaving a draft with unsaved edits. */
export function LeaveDialog({ blocker }: { blocker: Blocker }) {
  if (blocker.state !== 'blocked') return null;
  return (
    <ConfirmDialog
      title="Leave with unsaved edits?"
      body="Your changes to the draft text haven’t been saved. Leaving drops them."
      confirmLabel="Leave"
      danger
      onCancel={() => blocker.reset()}
      onConfirm={() => blocker.proceed()}
    />
  );
}
