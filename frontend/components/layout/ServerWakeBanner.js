'use client';

import { useEffect, useState } from 'react';
import { getWakeState, subscribeWake } from '@/lib/serverWake';
import { retryServerWake, wakeServer } from '@/lib/api';
import { Button } from '@/components/ui/Primitives';

// Notice for a sleeping free-tier API: shown while it wakes up, and with a
// Retry button if it did not wake within the budget.
export function ServerWakeBanner() {
  const [state, setState] = useState('idle');
  const [retrying, setRetrying] = useState(false);
  useEffect(() => {
    setState(getWakeState());
    return subscribeWake(setState);
  }, []);

  const retry = async () => {
    setRetrying(true);
    const awake = await retryServerWake();
    setRetrying(false);
    // Reload so every part of the page fetches its data again.
    if (awake) window.location.reload();
  };

  if (state === 'idle') return null;
  return <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center px-4">
    {state === 'waking'
      ? <div className="pointer-events-auto flex max-w-xl items-start gap-3 rounded-card border border-info-200 bg-surface px-4 py-3 text-sm text-ink shadow-raised" role="status">
        <span aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brand-100 border-t-brand-600" />
        <span>Waking up the server — free hosting sleeps when idle, this can take up to a minute.</span>
      </div>
      : <div className="pointer-events-auto flex max-w-xl flex-col gap-3 rounded-card border border-danger-200 bg-surface px-4 py-3 text-sm text-ink shadow-raised sm:flex-row sm:items-center" role="alert">
        <span>The server did not wake up in time. Check your connection, then try again.</span>
        <Button disabled={retrying} onClick={retry} type="button" variant="secondary">{retrying ? 'Waking…' : 'Retry'}</Button>
      </div>}
  </div>;
}

// Starts waking the API as soon as a public page opens (no notice shown).
export function ServerWakePing() {
  useEffect(() => { wakeServer(); }, []);
  return null;
}
