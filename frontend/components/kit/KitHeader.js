import { Badge, Button } from '@/components/ui/Primitives';
import { ProgressBar } from '@/components/ui/DataDisplay';
import { Icon } from '@/components/ui/Icon';

const sectionIds = [
  ['brief', 'Company brief'],
  ['requirements', 'Role & coverage'],
  ['questions', 'Questions'],
  ['flashcards', 'Flashcards'],
  ['schedule', 'Schedule'],
  ['practice', 'Practice'],
];

export function KitHeader({ kit, active, onSection, onPractice }) {
  const coverage = Number(kit?.coverage?.coveragePercent) || 0;
  return <div className="border-b border-line bg-white"><div className="container-shell pt-7 sm:pt-9"><div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end"><div><div className="flex flex-wrap items-center gap-2"><Badge tone="green">{kit?.company_brief?.name || 'Company workspace'}</Badge><Badge tone="gray">{kit?.role?.title || 'Interview role'}</Badge></div><h1 className="mt-4 max-w-3xl font-display text-3xl tracking-tight text-ink sm:text-4xl">Your interview preparation kit</h1><p className="mt-2 text-sm text-muted">Built from the role, the company brief, and your preparation days.</p></div><div className="flex items-center gap-4"><div className="min-w-[150px]"><div className="mb-2 flex items-center justify-between text-xs"><span className="font-medium text-muted">Coverage</span><span className="font-semibold text-brand-700">{coverage}%</span></div><ProgressBar value={coverage} /></div><Button onClick={onPractice} variant="secondary"><Icon name="book" size={16} />Practice</Button></div></div><nav aria-label="Kit sections" className="mt-8 flex gap-1 overflow-x-auto pb-px">{sectionIds.map(([id, label]) => <button aria-current={active === id ? 'page' : undefined} className={`whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition ${active === id ? 'border-brand-600 text-brand-700' : 'border-transparent text-muted hover:border-line hover:text-ink'}`} key={id} onClick={() => onSection(id)} type="button">{label}</button>)}</nav></div></div>;
}
