'use client';

import { useEffect, useId, useRef } from 'react';
import { Button } from './Primitives';

// Accessible confirmation built on the native <dialog>: showModal() traps
// focus, makes the page behind it inert and closes on Escape (routed to
// onCancel). Focus starts on the safe "Cancel" action (first in DOM order and
// marked autoFocus, which showModal() honours).
export function ConfirmDialog({ open, title, children, confirmLabel = 'Confirm', busyLabel = 'Working…', busy = false, onConfirm, onCancel }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return <dialog
    aria-describedby={bodyId}
    aria-labelledby={titleId}
    className="w-[min(92vw,420px)] rounded-2xl border border-line bg-white p-0 text-ink shadow-xl backdrop:bg-black/40"
    onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}
    ref={dialogRef}
  >
    <div className="p-6">
      <h2 className="text-lg font-semibold" id={titleId}>{title}</h2>
      <div className="mt-2 text-sm leading-6 text-muted" id={bodyId}>{children}</div>
      <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button autoFocus disabled={busy} onClick={onCancel} type="button" variant="secondary">Cancel</Button>
        <Button className="!bg-[#a24a3f] hover:!bg-[#8a3d33]" disabled={busy} onClick={onConfirm} type="button">{busy ? busyLabel : confirmLabel}</Button>
      </div>
    </div>
  </dialog>;
}
