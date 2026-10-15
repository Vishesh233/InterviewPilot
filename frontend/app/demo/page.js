import Link from 'next/link';
import { DemoFrame } from '@/components/demo/DemoFrame';
import { ProgressBar } from '@/components/ui/DataDisplay';
import { Card } from '@/components/ui/Primitives';
import { Icon } from '@/components/ui/Icon';
import { demoKits } from '@/lib/demoKits';
import { percent } from '@/lib/format';

function DemoKitCard({ kit }) {
  const company = kit.company_brief?.name || 'Company';
  const role = kit.role?.title || 'Interview preparation';
  const coverage = percent(kit.coverage?.coveragePercent);
  return <Card className="group flex h-full flex-col p-5 transition hover:-translate-y-0.5 hover:border-brand-200">
    <Link className="block flex-1" href={`/demo/${kit.slug}`}>
      <div className="flex items-start justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-sm font-bold text-brand-700">{company.slice(0, 1).toUpperCase()}</span><div className="min-w-0"><h2 className="truncate text-sm font-semibold text-ink">{company}</h2><p className="mt-0.5 truncate text-xs text-muted">{role}</p></div></div><Icon className="shrink-0 text-faint transition group-hover:text-brand-600" name="arrow" size={17} /></div>
      <p className="mt-4 line-clamp-3 text-sm leading-6 text-muted">{kit.company_brief?.about || kit.company_brief?.summary}</p>
      <div className="mt-5 grid grid-cols-3 gap-3 border-y border-line py-4 text-sm">
        <div><p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-muted">Questions</p><p className="mt-1 font-semibold text-ink">{kit.questions?.length || 0}</p></div>
        <div><p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-muted">Requirements</p><p className="mt-1 font-semibold text-ink">{kit.role?.requirements?.length || 0}</p></div>
        <div><p className="text-[10px] font-semibold uppercase tracking-[0.13em] text-muted">Days</p><p className="mt-1 font-semibold text-ink">{kit.schedule?.interviewDays || kit.source?.interviewDays || '—'}</p></div>
      </div>
      <div className="mt-4"><div className="mb-2 flex items-center justify-between"><span className="text-xs font-medium text-muted">Requirement coverage</span><span className="text-xs font-semibold text-brand-700">{coverage}%</span></div><ProgressBar label="Requirement coverage" value={coverage} /></div>
    </Link>
  </Card>;
}

export default function DemoIndexPage() {
  return <DemoFrame>
    <p className="eyebrow">Demo</p>
    <h1 className="mt-3 max-w-2xl font-display text-3xl tracking-tight text-ink sm:text-4xl">See a finished interview kit.</h1>
    <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">Two kits generated from real-style job descriptions. Open one to explore the company brief, coverage map, questions, flashcards, schedule and practice mode.</p>
    <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{demoKits.map((kit) => <DemoKitCard key={kit.slug} kit={kit} />)}</div>
  </DemoFrame>;
}
