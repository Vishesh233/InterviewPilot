'use client';

import { Card } from '@/components/ui/Primitives';
import { Icon } from '@/components/ui/Icon';
import { briefForDisplay } from '@/lib/companyBrief';

function BriefList({ title, items, icon }) {
  if (items.length === 0) return null;
  return <div className="mt-6">
    <h3 className="text-sm font-semibold text-ink">{title}</h3>
    <ul className="mt-3 space-y-2.5">{items.map((item) => <li className="flex gap-3 text-sm leading-6 text-muted" key={item}><Icon className="mt-1 shrink-0 text-brand-600" name={icon} size={15} />{item}</li>)}</ul>
  </div>;
}

const sourceLabel = (source) => {
  try {
    const url = new URL(source.url);
    return `${url.hostname.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}`;
  } catch {
    return source.url;
  }
};

export default function CompanyBriefPanel({ kit }) {
  const brief = briefForDisplay(kit);
  return <Card className="max-w-3xl p-6 sm:p-8">
    <p className="eyebrow">Company brief</p>
    <h2 className="mt-3 font-display text-3xl tracking-tight text-ink">{brief.name}</h2>
    <p className="mt-4 text-[15px] leading-7 text-ink">{brief.about || 'No company summary is available yet.'}</p>
    <BriefList icon="layers" items={brief.offerings} title="What they build" />
    <BriefList icon="target" items={brief.roleRelevance} title="Why it matters for this role" />
    {brief.sources.length > 0 && <div className="mt-7 border-t border-line pt-5">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Sources</p>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">{brief.sources.map((source, index) => <li key={`${source.url}-${index}`}><a className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline" href={source.url} rel="noopener noreferrer" target="_blank"><Icon name="external" size={14} />{sourceLabel(source)}</a></li>)}</ul>
      <p className="mt-4 text-xs leading-5 text-muted">Summarized from the company’s public website. Check the details before your interview.</p>
    </div>}
  </Card>;
}
