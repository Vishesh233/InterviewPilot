'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AuthShell } from '@/components/layout/AppHeader';
import { useAuth } from '@/components/auth/AuthProvider';
import { Alert, Button } from '@/components/ui/Primitives';

export function AuthForm({ mode = 'login' }) {
  const router = useRouter();
  const { token, loading, login, register } = useAuth();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && token) router.replace('/dashboard');
  }, [loading, router, token]);

  const isLogin = mode === 'login';
  const update = (event) => setForm((current) => ({ ...current, [event.target.name]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (!form.email.trim() || !form.password) {
      setError('Enter your email and password to continue.');
      return;
    }
    setSubmitting(true);
    try {
      if (isLogin) await login({ email: form.email, password: form.password });
      else await register({ email: form.email, password: form.password });
      router.replace('/dashboard');
    } catch (requestError) {
      setError(requestError?.message || 'We could not complete that request. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return <AuthShell title={isLogin ? 'Welcome back' : 'Start preparing'} description={isLogin ? 'Sign in to return to your interview workspace.' : 'Create a focused preparation workspace in under a minute.'}>
    <form className="space-y-5" onSubmit={submit}>
      {error && <Alert>{error}</Alert>}
      <div><label className="field-label" htmlFor="email">Email address</label><input autoComplete="email" className="field-input" id="email" name="email" onChange={update} placeholder="you@example.com" required type="email" value={form.email} /></div>
      <div><div className="flex items-center justify-between"><label className="field-label" htmlFor="password">Password</label>{isLogin && <span className="mb-2 text-xs text-muted">At least 1 character</span>}</div><input autoComplete={isLogin ? 'current-password' : 'new-password'} className="field-input" id="password" name="password" onChange={update} placeholder="Enter your password" required type="password" value={form.password} /></div>
      <Button className="w-full" disabled={submitting} type="submit">{submitting ? 'Connecting…' : isLogin ? 'Sign in' : 'Create account'}</Button>
    </form>
    <p className="mt-7 text-center text-sm text-muted">{isLogin ? 'New to the workspace?' : 'Already have an account?'} <Link className="font-semibold text-brand-700 hover:text-brand-600" href={isLogin ? '/register' : '/login'}>{isLogin ? 'Create an account' : 'Sign in'}</Link></p>
  </AuthShell>;
}
