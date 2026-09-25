'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { PageFrame } from '@/components/layout/AppHeader';
import PracticeMode from '@/components/practice/PracticeMode';
import { useAuth } from '@/components/auth/AuthProvider';
import { Button, LoadingState } from '@/components/ui/Primitives';

export default function PracticePage() {
  const router = useRouter();
  const params = useParams();
  const { token, loading } = useAuth();
  useEffect(() => { if (!loading && !token) router.replace('/login'); }, [loading, router, token]);
  if (loading || !token) return <PageFrame><LoadingState label="Checking your session" /></PageFrame>;
  return <PageFrame className="max-w-5xl"><div className="mb-7 flex items-center justify-between gap-4"><div><p className="eyebrow">Practice Mode</p><h1 className="mt-2 font-display text-4xl tracking-tight text-ink">Build recall, one card at a time.</h1></div><Button onClick={() => router.push(`/kits/${encodeURIComponent(params.id)}`)} variant="secondary">Back to kit</Button></div><PracticeMode kitId={params.id} token={token} /></PageFrame>;
}
