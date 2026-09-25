'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Alert, LoadingState } from '@/components/ui/Primitives';
import PracticeCard from './PracticeCard';
import { PracticeEmpty, PracticeStats } from './PracticeStats';

export default function PracticeMode({ token, kitId, onBack }) {
  const activeId = useRef(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!token || !kitId) return;
    setLoading(true); setError('');
    try {
      const result = await api.getPractice(token, kitId);
      setSession(result);
      const items = result.items || [];
      const found = activeId.current ? items.findIndex((item) => item.flashcard?.id === activeId.current) : 0;
      setIndex(found >= 0 ? found : 0);
    } catch (requestError) { setError(requestError instanceof ApiError ? requestError.message : 'We could not load Practice Mode.'); } finally { setLoading(false); }
  }, [kitId, token]);

  useEffect(() => { load(); }, [load]);

  const items = session?.items || [];
  const current = items[index];
  const update = async (changes) => {
    if (!current?.flashcard?.id) return;
    setSaving(true); setError('');
    try { await api.updatePractice(token, kitId, current.flashcard.id, changes); await load(); setRevealed(true); } catch (requestError) { setError(requestError instanceof ApiError ? requestError.message : 'We could not save your practice update.'); } finally { setSaving(false); }
  };
  const move = (direction) => { const next = index + direction; if (next < 0 || next >= items.length) return; setIndex(next); activeId.current = items[next]?.flashcard?.id || null; setRevealed(false); };

  if (loading) return <LoadingState detail="The backend is ordering your next practice session." label="Opening Practice Mode" />;
  if (error && !session) return <Alert title="Practice Mode is unavailable">{error}</Alert>;
  if (!items.length) return <PracticeEmpty onBack={onBack} />;
  return <div className="space-y-5"><PracticeStats progress={session.progress || {}} /><PracticeCard index={index} item={current} onMove={move} onReveal={() => setRevealed(true)} onUpdate={update} revealed={revealed} saving={saving} total={items.length} />{error && <Alert>{error}</Alert>}<p className="text-center text-xs text-muted">Practice order comes from the backend: uncovered first, then unrated, then lower confidence.</p></div>;
}
