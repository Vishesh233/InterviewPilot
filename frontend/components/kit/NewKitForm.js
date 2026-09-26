'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageFrame, BackLink } from '@/components/layout/AppHeader';
import { useAuth } from '@/components/auth/AuthProvider';
import { api, ApiError } from '@/lib/api';
import { kitFromPipeline } from '@/lib/kitAdapter';
import { GenerationProgress, generationStages } from '@/components/loading/GenerationProgress';
import { Alert, Badge, Button, Card, LoadingState } from '@/components/ui/Primitives';
import { Icon } from '@/components/ui/Icon';

export default function NewKitForm() {
  const router = useRouter();
  const { token, loading: authLoading } = useAuth();
  const [form, setForm] = useState({ jobRole: '', jobDescription: '', companyUrl: '', interviewDays: 7 });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [stage, setStage] = useState(1);

  useEffect(() => { if (!authLoading && !token) router.replace('/login'); }, [authLoading, router, token]);
  useEffect(() => { if (!generating) return undefined; const timer = setInterval(() => setStage((current) => Math.min(generationStages.length, current + 1)), 4200); return () => clearInterval(timer); }, [generating]);

  const update = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: name === 'interviewDays' ? Number(value) : value }));
    setErrors((current) => ({ ...current, [name]: '' }));
  };

  const validate = () => {
    const next = {};
    if (!form.jobRole.trim()) next.jobRole = 'Add the job role so we can target the right position.';
    else if (form.jobRole.length > 200) next.jobRole = 'Keep the job role under 200 characters.';
    if (!form.jobDescription.trim()) next.jobDescription = 'Add the job description so we can ground the preparation.';
    else if (form.jobDescription.length > 50000) next.jobDescription = 'Keep the job description under 50,000 characters.';
    try {
      const url = new URL(form.companyUrl.trim());
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
    } catch { next.companyUrl = 'Enter a public http:// or https:// company URL.'; }
    if (!Number.isInteger(form.interviewDays) || form.interviewDays < 1 || form.interviewDays > 60) next.interviewDays = 'Choose a whole number from 1 to 60.';
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (!validate()) return;
    setGenerating(true);
    setStage(1);
    try {
      const generated = await api.generateKit(token, { jobRole: form.jobRole.trim(), jobDescription: form.jobDescription, companyUrl: form.companyUrl.trim(), interviewDays: form.interviewDays });
      const saved = await api.createKit(token, kitFromPipeline(form, generated));
      router.push(`/kits/${encodeURIComponent(saved._id || saved.id)}`);
    } catch (requestError) {
      setGenerating(false);
      setError(requestError instanceof ApiError ? requestError.message : 'We could not generate this kit. Your input is still here—please try again.');
    }
  };

  if (authLoading || !token) return <PageFrame><LoadingState label="Checking your session" /></PageFrame>;
  if (generating) return <PageFrame><div className="mx-auto max-w-3xl"><BackLink href="/dashboard">Back to dashboard</BackLink><div className="mt-8"><GenerationProgress stage={stage} /></div></div></PageFrame>;

  return <PageFrame><div className="mx-auto max-w-5xl"><BackLink href="/dashboard">Back to dashboard</BackLink><div className="mt-8 grid gap-8 lg:grid-cols-[1fr_300px] lg:items-start"><div><p className="eyebrow">New preparation kit</p><h1 className="mt-3 max-w-2xl font-display text-4xl tracking-tight text-ink sm:text-5xl">Give the next interview a head start.</h1><p className="mt-4 max-w-xl text-sm leading-6 text-muted">Share the role and the company. We’ll turn the brief into a practical set of questions, coverage, and a day-by-day plan.</p><FormFields errors={errors} form={form} onSubmit={submit} onUpdate={update} onCancel={() => router.push('/dashboard')} error={error} /></div><CreateKitAside /></div></div></PageFrame>;
}

function FormFields({ errors, form, onSubmit, onUpdate, onCancel, error }) {
  return <form className="mt-9 space-y-7" onSubmit={onSubmit} noValidate>
    {error && <Alert title="Generation could not be completed">{error}</Alert>}
    <div><label className="field-label" htmlFor="jobRole">Job role <span className="font-normal text-muted">(required)</span></label><input className={`field-input ${errors.jobRole ? 'border-[#c96c61]' : ''}`} id="jobRole" maxLength={200} name="jobRole" onChange={onUpdate} placeholder="e.g. Backend Developer" type="text" value={form.jobRole} />{errors.jobRole && <p className="mt-2 text-xs text-[#a24a3f]">{errors.jobRole}</p>}</div>
    <div><label className="field-label" htmlFor="jobDescription">Job description <span className="font-normal text-muted">(required)</span></label><textarea className={`field-input min-h-[240px] resize-y ${errors.jobDescription ? 'border-[#c96c61]' : ''}`} id="jobDescription" maxLength={50000} name="jobDescription" onChange={onUpdate} placeholder="Paste the full job description here…" value={form.jobDescription} /><div className="mt-2 flex justify-between gap-3 text-xs text-muted"><span>{errors.jobDescription || 'More context helps us ground every question.'}</span><span>{form.jobDescription.length.toLocaleString()} / 50,000</span></div></div>
    <div><label className="field-label" htmlFor="companyUrl">Company URL <span className="font-normal text-muted">(required)</span></label><input className={`field-input ${errors.companyUrl ? 'border-[#c96c61]' : ''}`} id="companyUrl" name="companyUrl" onChange={onUpdate} placeholder="https://company.com" type="url" value={form.companyUrl} />{errors.companyUrl && <p className="mt-2 text-xs text-[#a24a3f]">{errors.companyUrl}</p>}</div>
    <div><div className="flex items-center justify-between gap-4"><label className="field-label" htmlFor="interviewDays">Interview days</label><Badge>1–60 days</Badge></div><input className={`field-input max-w-[180px] ${errors.interviewDays ? 'border-[#c96c61]' : ''}`} id="interviewDays" max="60" min="1" name="interviewDays" onChange={onUpdate} step="1" type="number" value={form.interviewDays} />{errors.interviewDays && <p className="mt-2 text-xs text-[#a24a3f]">{errors.interviewDays}</p>}</div>
    <div className="flex flex-col-reverse gap-3 border-t border-line pt-6 sm:flex-row sm:justify-end"><Button onClick={onCancel} type="button" variant="secondary">Cancel</Button><Button type="submit"><Icon name="spark" size={17} />Generate preparation kit</Button></div>
  </form>;
}

function CreateKitAside() {
  return <Card className="p-6 lg:sticky lg:top-8"><p className="eyebrow">What you’ll get</p><ul className="mt-5 space-y-4">{['Company context grounded in public research', 'Role-specific questions with answer outlines', 'A visible requirement coverage map', 'A schedule built around your interview days', 'Flashcards and practice progress'].map((item) => <li className="flex gap-3 text-sm leading-5 text-muted" key={item}><Icon className="mt-0.5 shrink-0 text-brand-600" name="check" size={16} />{item}</li>)}</ul></Card>;
}

