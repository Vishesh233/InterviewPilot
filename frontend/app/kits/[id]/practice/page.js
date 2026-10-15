'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { PageFrame } from '@/components/layout/AppHeader';
import PracticeMode from '@/components/practice/PracticeMode';
import { useAuth } from '@/components/auth/AuthProvider';
import { Button, LoadingState } from '@/components/ui/Primitives';
import { api } from '@/lib/api';
import { companyNameOf } from '@/lib/companyBrief';
import { withFeedbackAttempt } from '@/lib/answerFeedback';

export default function PracticePage() {
  const router = useRouter();
  const params = useParams();
  const { token, loading } = useAuth();
  const [kit, setKit] = useState(null);
  useEffect(() => { if (!loading && !token) router.replace('/login'); }, [loading, router, token]);
  // The kit labels the page and gives answer practice its questions and history.
  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    api.getKit(token, params.id)
      .then((loaded) => { if (active) setKit(loaded); })
      .catch((error) => { console.warn('Could not load the kit name for practice.', error?.message || error); });
    return () => { active = false; };
  }, [params.id, token]);
  const kitLabel = kit ? `${kit.role?.title || 'Interview'} at ${companyNameOf(kit)}` : '';
  const answers = { token, kitId: params.id, onAttempt: (questionId, attempt) => setKit((current) => withFeedbackAttempt(current, questionId, attempt)) };
  if (loading || !token) return <PageFrame><LoadingState label="Checking your session" /></PageFrame>;
  return <PageFrame className="max-w-5xl"><div className="mb-5 flex items-start justify-between gap-4 sm:mb-7 sm:items-center"><div><p className="eyebrow">Practice Mode</p><h1 className="mt-2 font-display text-2xl tracking-tight text-ink sm:text-4xl">Build recall, one card at a time.</h1>{kitLabel && <p className="mt-2 text-sm text-muted">{kitLabel}</p>}</div><Button onClick={() => router.push(`/kits/${encodeURIComponent(params.id)}`)} variant="secondary">Back to kit</Button></div><PracticeMode answers={kit ? answers : undefined} kit={kit} kitId={params.id} token={token} /></PageFrame>;
}
