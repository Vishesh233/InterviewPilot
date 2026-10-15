'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, LoadingState } from '@/components/ui/Primitives';
import { Icon } from '@/components/ui/Icon';
import PracticeCard from './PracticeCard';
import { PracticeEmpty, PracticeStats } from './PracticeStats';

// The card order is fixed for a practice session: it is taken from the
// backend's priority order when the session starts (or on "Reorder by
// priority") and kept while ratings are saved, so the current card never jumps.
const sessionOrder = (current, ids, reorder) => {
  if (reorder || !current) return ids;
  const kept = current.filter((id) => ids.includes(id));
  return [...kept, ...ids.filter((id) => !kept.includes(id))];
};

export default function PracticeMode({ token, kitId, onBack }) {
  const [session, setSession] = useState(null);
  const [order, setOrder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);

  // Loads practice state. The full-page loading state is shown only when a
  // session starts; refreshes after a rating keep the current card on screen.
  const load = useCallback(async ({ reorder = false, initial = false } = {}) => {
    if (!token || !kitId) return;
    if (initial) setLoading(true);
    setError('');
    try {
      const result = await api.getPractice(token, kitId);
      const ids = (result.items || []).map((item) => item.flashcard?.id).filter(Boolean);
      setSession(result);
      setOrder((current) => sessionOrder(current, ids, reorder || initial));
      if (reorder || initial) { setIndex(0); setRevealed(false); }
    } catch (requestError) { setError(requestError instanceof ApiError ? requestError.message : 'We could not load Practice Mode.'); } finally { if (initial) setLoading(false); }
  }, [kitId, token]);

  useEffect(() => { load({ initial: true }); }, [load]);

  const items = useMemo(() => {
    const byId = new Map((session?.items || []).map((item) => [item.flashcard?.id, item]));
    return (order || []).map((id) => byId.get(id)).filter(Boolean);
  }, [order, session]);
  useEffect(() => { if (index > 0 && index >= items.length) setIndex(Math.max(0, items.length - 1)); }, [index, items.length]);
  const current = items[index];
  const update = async (changes) => {
    if (!current?.flashcard?.id) return;
    setSaving(true); setError('');
    try { await api.updatePractice(token, kitId, current.flashcard.id, changes); await load(); setRevealed(true); } catch (requestError) { setError(requestError instanceof ApiError ? requestError.message : 'We could not save your practice update.'); } finally { setSaving(false); }
  };
  const move = (direction) => { const next = index + direction; if (next < 0 || next >= items.length) return; setIndex(next); setRevealed(false); };

  if (loading) return <LoadingState detail="Putting your cards in order." label="Opening Practice Mode" />;
  if (error && !session) return <Alert title="Practice Mode is unavailable">{error}</Alert>;
  if (!items.length) return <PracticeEmpty onBack={onBack} />;
  return <div className="space-y-5"><PracticeStats progress={session.progress || {}} /><PracticeCard index={index} item={current} onMove={move} onReveal={() => setRevealed(true)} onUpdate={update} revealed={revealed} saving={saving} total={items.length} />{error && <Alert>{error}</Alert>}<div className="flex flex-col items-center gap-2 text-center"><p className="text-xs text-muted">The order stays fixed while you practice. Reordering puts uncovered cards first, then unrated, then lower confidence.</p><Button disabled={saving} onClick={() => load({ reorder: true })} type="button" variant="quiet"><Icon name="refresh" size={15} />Reorder by priority</Button></div></div>;
}
