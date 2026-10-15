'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { PageFrame } from '@/components/layout/AppHeader';
import MockInterview from '@/components/interview/MockInterview';
import { useAuth } from '@/components/auth/AuthProvider';
import { Button, LoadingState } from '@/components/ui/Primitives';
import { api } from '@/lib/api';
import { companyNameOf } from '@/lib/companyBrief';

export default function InterviewPage() {
  const router = useRouter();
  const params = useParams();
  const { token, loading } = useAuth();
  const [kitLabel, setKitLabel] = useState('');
  useEffect(() => { if (!loading && !token) router.replace('/login'); }, [loading, router, token]);
  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    api.getKit(token, params.id)
      .then((kit) => { if (active) setKitLabel(`${kit?.role?.title || 'Interview'} at ${companyNameOf(kit)}`); })
      .catch((error) => { console.warn('Could not load the kit name for the mock interview.', error?.message || error); });
    return () => { active = false; };
  }, [params.id, token]);
  if (loading || !token) return <PageFrame><LoadingState label="Checking your session" /></PageFrame>;
  return <PageFrame className="max-w-4xl"><div className="mb-5 flex items-start justify-between gap-4 sm:mb-7 sm:items-center"><div><p className="eyebrow">Mock interview</p><h1 className="mt-2 font-display text-2xl tracking-tight text-ink sm:text-4xl">One question at a time.</h1>{kitLabel && <p className="mt-2 text-sm text-muted">{kitLabel}</p>}</div><Button onClick={() => router.push(`/kits/${encodeURIComponent(params.id)}`)} variant="secondary">Back to kit</Button></div><MockInterview kitId={params.id} token={token} /></PageFrame>;
}
