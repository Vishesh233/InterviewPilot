'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PageFrame } from '@/components/layout/AppHeader';
import { useAuth } from '@/components/auth/AuthProvider';
import { api, ApiError } from '@/lib/api';
import { formatDate, getKitId, percent } from '@/lib/format';
import { Alert, Button, Card, LinkButton } from '@/components/ui/Primitives';
import { DashboardSkeleton } from '@/components/ui/Skeleton';
import { ProgressBar, Stat } from '@/components/ui/DataDisplay';
import { Icon } from '@/components/ui/Icon';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';

// Practice cards still worth revisiting: not marked covered, or rated 1–2.
const cardsToRevisit = (kit) => (Array.isArray(kit?.flashcards) ? kit.flashcards : [])
  .filter((card) => card?.practice?.covered !== true || (Number.isInteger(card?.practice?.confidence) && card.practice.confidence <= 2)).length;

function KitCard({ kit, onDelete }) {
  const id = getKitId(kit);
  const coverage = percent(kit?.coverage?.coveragePercent);
  const company = kit?.company_brief?.name || kit?.source?.companyUrl || 'Company workspace';
  const role = kit?.role?.title || 'Interview preparation';
  const days = kit?.schedule?.interviewDays || kit?.source?.interviewDays || '—';
  // The delete button sits outside the link: interactive elements cannot nest.
  return <Card className="group flex h-full flex-col p-5 transition hover:-translate-y-0.5 hover:border-brand-200">
    <Link className="block flex-1" href={id ? `/kits/${encodeURIComponent(id)}` : '/dashboard'}>
      <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-sm font-bold text-brand-700">{company.slice(0, 1).toUpperCase()}</span><div className="min-w-0"><h3 className="truncate text-sm font-semibold text-ink" title={company}>{company}</h3><p className="mt-0.5 truncate text-xs text-muted">{role}</p></div></div><Icon className="shrink-0 text-faint transition group-hover:text-brand-600" name="arrow" size={17} /></div>
      <div className="mt-6 grid grid-cols-2 gap-3 border-y border-line py-4"><div><p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-muted">Interview days</p><p className="mt-1 text-sm font-semibold text-ink">{days}</p></div><div><p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-muted">Last updated</p><p className="mt-1 text-sm font-semibold text-ink">{formatDate(kit.updatedAt || kit.createdAt)}</p></div></div>
      <div className="mt-4"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium text-muted">Requirement coverage</span><span className="text-xs font-semibold text-brand-700">{coverage}%</span></div><ProgressBar label="Requirement coverage" value={coverage} /></div>
    </Link>
    {id && <div className="mt-4 flex justify-end border-t border-line pt-3"><Button aria-label={`Delete kit for ${company}`} onClick={() => onDelete(kit)} type="button" variant="quiet"><Icon name="trash" size={15} />Delete</Button></div>}
  </Card>;
}

// Shown to a new user instead of an empty grid: what a kit is, in three
// steps, and the one action that matters.
const FIRST_KIT_STEPS = [
  ['clipboard', 'Paste a job description', 'Add the role, the job description and the company website.'],
  ['spark', 'Get your kit', 'Requirements, grounded questions, flashcards and a schedule, built in the background.'],
  ['book', 'Practice', 'Work through the kit until interview day and track what still needs work.'],
];

function FirstKitWelcome() {
  return <div className="card px-6 py-10 sm:px-10">
    <div className="mx-auto max-w-2xl text-center">
      <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-control bg-brand-50 text-brand-700"><Icon name="spark" size={22} /></span>
      <h2 className="mt-5 font-display text-3xl tracking-tight text-ink">Your first kit starts here</h2>
      <p className="mt-3 text-sm leading-6 text-muted">Pick a role you are applying for. InterviewPilot turns its job description into a preparation kit you can practice with.</p>
    </div>
    <ol className="mx-auto mt-8 grid max-w-4xl gap-4 md:grid-cols-3">
      {FIRST_KIT_STEPS.map(([icon, title, body], index) => <li className="rounded-control border border-line bg-subtle p-5" key={title}>
        <div className="flex items-center gap-2 text-xs font-semibold text-brand-700"><Icon name={icon} size={16} />Step {index + 1}</div>
        <p className="mt-3 text-sm font-semibold text-ink">{title}</p>
        <p className="mt-1 text-sm leading-6 text-muted">{body}</p>
      </li>)}
    </ol>
    <div className="mt-8 text-center"><LinkButton href="/kits/new" variant="primary"><Icon name="plus" size={17} />Create your first kit</LinkButton></div>
  </div>;
}

export default function DashboardPage() {
  const router = useRouter();
  const { token, loading: authLoading } = useAuth();
  const [kits, setKits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [pendingDelete, setPendingDelete] = useState(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!authLoading && !token) router.replace('/login');
  }, [authLoading, router, token]);

  useEffect(() => {
    if (!token) return undefined;
    let active = true;
    setLoading(true);
    api.listKits(token).then((result) => { if (active) setKits(Array.isArray(result) ? result : []); }).catch((requestError) => { if (active) setError(requestError instanceof ApiError ? requestError.message : 'We could not load your kits.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [token]);

  // Optimistic delete: the card disappears at once and comes back (at its old
  // position) with an error if the backend refuses, e.g. 409 while generating.
  const confirmDelete = async () => {
    const kit = pendingDelete;
    setPendingDelete(null);
    const id = getKitId(kit);
    const position = kits.findIndex((item) => getKitId(item) === id);
    setError(''); setNotice('');
    setKits((current) => current.filter((item) => getKitId(item) !== id));
    try {
      await api.deleteKit(token, id);
      setNotice('Kit deleted.');
    } catch (requestError) {
      setKits((current) => { const next = [...current]; next.splice(Math.max(0, position), 0, kit); return next; });
      setError(requestError instanceof ApiError ? requestError.message : 'We could not delete this kit.');
    }
  };

  const stats = useMemo(() => ({ total: kits.length, average: kits.length ? Math.round(kits.reduce((sum, kit) => sum + percent(kit.coverage?.coveragePercent), 0) / kits.length) : 0 }), [kits]);

  if (authLoading || loading) return <PageFrame><DashboardSkeleton /></PageFrame>;

  return <PageFrame>
    {kits.length === 0
      ? <section className="flex flex-col justify-between gap-6 border-b border-line pb-8 sm:flex-row sm:items-end"><div><p className="eyebrow">Your workspace</p><h1 className="mt-3 max-w-2xl font-display text-4xl tracking-tight text-ink sm:text-5xl">Good preparation starts with a clear brief.</h1><p className="mt-4 max-w-xl text-sm leading-6 text-muted">Keep your company research, interview questions, schedule, and practice progress in one focused place.</p></div><LinkButton href="/kits/new" variant="primary"><Icon name="plus" size={17} />Create new kit</LinkButton></section>
      // Returning users: a compact greeting so their kits stay above the fold.
      : <section className="flex items-center justify-between gap-4"><div className="min-w-0"><h1 className="font-display text-2xl tracking-tight text-ink sm:text-3xl">Welcome back</h1><p className="mt-1 text-sm text-muted">Pick up where you left off.</p></div><LinkButton className="shrink-0" href="/kits/new" variant="primary"><Icon name="plus" size={17} />Create new kit</LinkButton></section>}
    {error && <Alert className="mt-7" title="Something went wrong">{error}</Alert>}
    {notice && <Alert className="mt-7" tone="success">{notice}</Alert>}
    {kits.length > 0 && <section className="mt-6 grid grid-cols-3 gap-2 sm:gap-3"><Stat compact label="Saved kits" value={stats.total} /><Stat compact label="Average coverage" value={`${stats.average}%`} tone="green" /><Stat compact label="Questions to revisit" value={kits.reduce((sum, kit) => sum + cardsToRevisit(kit), 0)} detail="Practice cards not yet covered or rated 1–2" /></section>}
    <section className={kits.length > 0 ? 'mt-8' : 'mt-12'}><div className="mb-5 flex items-end justify-between gap-4"><div><p className="eyebrow">Saved kits</p><h2 className="mt-2 text-xl font-semibold tracking-tight text-ink">Your preparation workspaces</h2></div>{kits.length > 0 && <span className="text-xs text-muted">{kits.length} {kits.length === 1 ? 'kit' : 'kits'}</span>}</div>{kits.length === 0 ? <FirstKitWelcome /> : <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{kits.map((kit, index) => <KitCard key={getKitId(kit) || index} kit={kit} onDelete={setPendingDelete} />)}</div>}</section>
    <ConfirmDialog confirmLabel="Delete kit" onCancel={() => setPendingDelete(null)} onConfirm={confirmDelete} open={Boolean(pendingDelete)} title="Delete this kit?">
      {pendingDelete ? `“${pendingDelete.company_brief?.name || 'This kit'}” (${pendingDelete.role?.title || 'interview kit'}) will be deleted with its questions, flashcards and practice progress. This cannot be undone.` : ''}
    </ConfirmDialog>
  </PageFrame>;
}
