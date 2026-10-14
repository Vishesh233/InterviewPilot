'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth/AuthProvider';

// Signed-in visitors skip the landing page and go straight to their dashboard.
export function SignedInRedirect() {
  const { token, loading } = useAuth();
  const router = useRouter();
  useEffect(() => {
    if (!loading && token) router.replace('/dashboard');
  }, [loading, router, token]);
  return null;
}
