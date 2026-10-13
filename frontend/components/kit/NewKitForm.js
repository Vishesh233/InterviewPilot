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

// The backend enforces the same rules again (extension + media type allowlist,
// 2 MB decoded limit). This client check exists only for fast feedback.
const RESUME_MAX_BYTES = 2 * 1024 * 1024;
const RESUME_EXTENSIONS = ['pdf', 'txt', 'md'];

const resumeExtension = (name) => (String(name || '').split('.').pop() || '').toLowerCase();

const validateResumeFile = (file) => {
  if (!RESUME_EXTENSIONS.includes(resumeExtension(file.name))) {
    return 'Upload a PDF (.pdf) or a text file (.txt, .md).';
  }
  if (!Number.isFinite(file.size) || file.size <= 0) return 'That file looks empty.';
  if (file.size > RESUME_MAX_BYTES) return 'Keep the resume under 2 MB.';
  return '';
};

const readFileAsBase64 = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('The file could not be read.'));
    reader.onload = () => {
      const result = String(reader?.result || '');
      const separator = result.indexOf(',');
      resolve(separator === -1 ? '' : result.slice(separator + 1));
    };
    reader.readAsDataURL(file);
  });

const formatFileSize = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

export default function NewKitForm() {
  const router = useRouter();
  const { token, loading: authLoading } = useAuth();
  const [form, setForm] = useState({ jobRole: '', jobDescription: '', companyUrl: '', interviewDays: 7 });
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const [stage, setStage] = useState(1);
  const [resume, setResume] = useState(null);
  const [resumeError, setResumeError] = useState('');
  const [readingResume, setReadingResume] = useState(false);

  useEffect(() => { if (!authLoading && !token) router.replace('/login'); }, [authLoading, router, token]);
  useEffect(() => { if (!generating) return undefined; const timer = setInterval(() => setStage((current) => Math.min(generationStages.length, current + 1)), 4200); return () => clearInterval(timer); }, [generating]);

  const update = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: name === 'interviewDays' ? Number(value) : value }));
    setErrors((current) => ({ ...current, [name]: '' }));
  };

  const onResumeSelected = async (event) => {
    const file = event.target.files?.[0];
    // Allow re-selecting the same file after a removal.
    event.target.value = '';
    setResumeError('');
    if (!file) return;
    const problem = validateResumeFile(file);
    if (problem) { setResume(null); setResumeError(problem); return; }
    setReadingResume(true);
    try {
      const dataBase64 = await readFileAsBase64(file);
      setResume({ fileName: file.name, mimeType: file.type || '', size: file.size, dataBase64 });
    } catch {
      setResume(null);
      setResumeError('That file could not be read. Please try another file.');
    } finally { setReadingResume(false); }
  };

  const removeResume = () => { setResume(null); setResumeError(''); };

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
      const body = { jobRole: form.jobRole.trim(), jobDescription: form.jobDescription, companyUrl: form.companyUrl.trim(), interviewDays: form.interviewDays };
      if (resume) body.resume = { fileName: resume.fileName, mimeType: resume.mimeType, dataBase64: resume.dataBase64 };
      const generated = await api.generateKit(token, body);
      const saved = await api.createKit(token, kitFromPipeline(form, generated));
      router.push(`/kits/${encodeURIComponent(saved._id || saved.id)}`);
    } catch (requestError) {
      setGenerating(false);
      setError(requestError instanceof ApiError ? requestError.message : 'We could not generate this kit. Your input is still here—please try again.');
    }
  };

  if (authLoading || !token) return <PageFrame><LoadingState label="Checking your session" /></PageFrame>;
  if (generating) return <PageFrame><div className="mx-auto max-w-3xl"><BackLink href="/dashboard">Back to dashboard</BackLink><div className="mt-8"><GenerationProgress stage={stage} /></div></div></PageFrame>;

  return <PageFrame><div className="mx-auto max-w-5xl"><BackLink href="/dashboard">Back to dashboard</BackLink><div className="mt-8 grid gap-8 lg:grid-cols-[1fr_300px] lg:items-start"><div><p className="eyebrow">New preparation kit</p><h1 className="mt-3 max-w-2xl font-display text-4xl tracking-tight text-ink sm:text-5xl">Give the next interview a head start.</h1><p className="mt-4 max-w-xl text-sm leading-6 text-muted">Share the role and the company. We’ll turn the brief into a practical set of questions, coverage, and a day-by-day plan.</p><FormFields errors={errors} form={form} onSubmit={submit} onUpdate={update} onCancel={() => router.push('/dashboard')} error={error} onRemoveResume={removeResume} onResumeSelected={onResumeSelected} readingResume={readingResume} resume={resume} resumeError={resumeError} /></div><CreateKitAside /></div></div></PageFrame>;
}

function FormFields({ errors, form, onSubmit, onUpdate, onCancel, error, resume, resumeError, readingResume, onResumeSelected, onRemoveResume }) {
  return <form className="mt-9 space-y-7" onSubmit={onSubmit} noValidate>
    {error && <Alert title="Generation could not be completed">{error}</Alert>}
    <div><label className="field-label" htmlFor="jobRole">Job role <span className="font-normal text-muted">(required)</span></label><input className={`field-input ${errors.jobRole ? 'border-[#c96c61]' : ''}`} id="jobRole" maxLength={200} name="jobRole" onChange={onUpdate} placeholder="e.g. Backend Developer" type="text" value={form.jobRole} />{errors.jobRole && <p className="mt-2 text-xs text-[#a24a3f]">{errors.jobRole}</p>}</div>
    <div><label className="field-label" htmlFor="jobDescription">Job description <span className="font-normal text-muted">(required)</span></label><textarea className={`field-input min-h-[240px] resize-y ${errors.jobDescription ? 'border-[#c96c61]' : ''}`} id="jobDescription" maxLength={50000} name="jobDescription" onChange={onUpdate} placeholder="Paste the full job description here…" value={form.jobDescription} /><div className="mt-2 flex justify-between gap-3 text-xs text-muted"><span>{errors.jobDescription || 'More context helps us ground every question.'}</span><span>{form.jobDescription.length.toLocaleString()} / 50,000</span></div></div>
    <div><label className="field-label" htmlFor="companyUrl">Company URL <span className="font-normal text-muted">(required)</span></label><input className={`field-input ${errors.companyUrl ? 'border-[#c96c61]' : ''}`} id="companyUrl" name="companyUrl" onChange={onUpdate} placeholder="https://company.com" type="url" value={form.companyUrl} />{errors.companyUrl && <p className="mt-2 text-xs text-[#a24a3f]">{errors.companyUrl}</p>}</div>
    <ResumeField onRemove={onRemoveResume} onSelect={onResumeSelected} reading={readingResume} resume={resume} error={resumeError} />
    <div><div className="flex items-center justify-between gap-4"><label className="field-label" htmlFor="interviewDays">Interview days</label><Badge>1–60 days</Badge></div><input className={`field-input max-w-[180px] ${errors.interviewDays ? 'border-[#c96c61]' : ''}`} id="interviewDays" max="60" min="1" name="interviewDays" onChange={onUpdate} step="1" type="number" value={form.interviewDays} />{errors.interviewDays && <p className="mt-2 text-xs text-[#a24a3f]">{errors.interviewDays}</p>}</div>
    <div className="flex flex-col-reverse gap-3 border-t border-line pt-6 sm:flex-row sm:justify-end"><Button onClick={onCancel} type="button" variant="secondary">Cancel</Button><Button type="submit"><Icon name="spark" size={17} />Generate preparation kit</Button></div>
  </form>;
}

function ResumeField({ resume, error, reading, onSelect, onRemove }) {
  return <div className="rounded-xl border border-dashed border-line bg-[#fbfcfa] p-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="field-label mb-1">Resume <span className="font-normal text-muted">(optional)</span></p>
        <p className="text-xs leading-5 text-muted">Add a resume to get questions grounded in your real projects and a requirement-by-requirement match.</p>
      </div>
      <Badge tone="gray">PDF, TXT, MD · max 2 MB</Badge>
    </div>
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <label className="button-secondary inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-line bg-white px-5 text-sm font-semibold text-ink transition hover:border-brand-500 hover:text-brand-700">
        <Icon name={resume ? 'refresh' : 'plus'} size={16} />
        {reading ? 'Reading file…' : resume ? 'Replace resume' : 'Choose file'}
        <input accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown" className="sr-only" disabled={reading} onChange={onSelect} type="file" />
      </label>
      {resume && <Button onClick={onRemove} type="button" variant="quiet">Remove</Button>}
    </div>
    {resume && <p className="mt-4 flex items-center gap-2 text-xs font-medium text-ink"><Icon className="text-brand-600" name="check" size={14} />{resume.fileName} · {formatFileSize(resume.size)} · stored privately in this kit</p>}
    {error && <p className="mt-3 text-xs text-[#a24a3f]">{error}</p>}
    <p className="mt-3 text-xs leading-5 text-muted">Your resume is only used for this kit. It is never published, logged, or added to a URL.</p>
  </div>;
}

function CreateKitAside() {
  return <Card className="p-6 lg:sticky lg:top-8"><p className="eyebrow">What you’ll get</p><ul className="mt-5 space-y-4">{['Company context grounded in public research', 'Role-specific questions with answer outlines', 'Resume-grounded questions when you attach one', 'A visible requirement coverage map', 'A schedule built around your interview days', 'Flashcards and practice progress'].map((item) => <li className="flex gap-3 text-sm leading-5 text-muted" key={item}><Icon className="mt-0.5 shrink-0 text-brand-600" name="check" size={16} />{item}</li>)}</ul></Card>;
}

