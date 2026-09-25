'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth/AuthProvider';

export default function HomePage() {
  const { token, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!loading) router.replace(token ? '/dashboard' : '/login');
  }, [loading, router, token]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-6">
      <div className="text-center">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-xl font-bold text-white">T</div>
        <p className="eyebrow">Trao</p>
        <h1 className="mt-3 font-display text-4xl tracking-tight text-ink">InterviewPilot</h1>
        <p className="mt-3 text-sm text-muted">Opening your workspace…</p>
      </div>
    </main>
  );
}
