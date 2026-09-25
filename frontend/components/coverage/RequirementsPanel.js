import { Badge, Card } from '@/components/ui/Primitives';
import { ProgressBar, Stat } from '@/components/ui/DataDisplay';
import { Icon } from '@/components/ui/Icon';

const requirementText = (entry) => typeof entry === 'string' ? entry : entry?.id || entry?.text || '';
const requirementKind = (entry) => (typeof entry === 'object' && entry?.kind) || 'requirement';
const kindLabel = { must_have: 'Must-have', nice_to_have: 'Nice-to-have', responsibility: 'Responsibility', qualification: 'Qualification', interview_signal: 'Interview signal', role: 'Role', seniority: 'Seniority' };

export default function RequirementsPanel({ kit }) {
  const role = kit?.role || {};
  const coverage = kit?.coverage || {};
  const requirements = Array.isArray(role.requirements) ? role.requirements : [];
  const covered = new Set(Array.isArray(coverage.coveredRequirements) ? coverage.coveredRequirements : []);
  const missing = new Set(Array.isArray(coverage.missingRequirements) ? coverage.missingRequirements : []);
  const percentage = Number(coverage.coveragePercent) || 0;
  const questionFor = (id) => (kit?.questions || []).find((question) => (question.requirementRefs || []).includes(id));

  return <div className="space-y-5">
    <div className="grid gap-3 sm:grid-cols-3"><Stat label="Total requirements" value={requirements.length} /><Stat label="Covered" value={covered.size} tone="green" /><Stat label="Needs attention" value={missing.size} /></div>
    <Card className="p-5 sm:p-6"><div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center"><div><p className="eyebrow">Coverage map</p><h2 className="mt-2 text-lg font-semibold text-ink">A grounded view of the role</h2></div><span className="text-2xl font-semibold text-brand-700">{percentage}%</span></div><ProgressBar className="mt-5" value={percentage} /><p className="mt-3 text-xs leading-5 text-muted">Coverage is calculated by the backend from the final questions. The frontend does not estimate or fill gaps.</p></Card>
    <Card className="overflow-hidden"><div className="border-b border-line px-5 py-4 sm:px-6"><h2 className="font-semibold text-ink">Role requirements</h2><p className="mt-1 text-xs text-muted">Each requirement links to the question that currently covers it.</p></div>{requirements.length === 0 ? <p className="px-6 py-8 text-sm text-muted">No requirements were recorded for this kit.</p> : <ul className="divide-y divide-line">{requirements.map((entry) => { const id = requirementText(entry); const question = questionFor(id); const isCovered = covered.has(id); const kind = requirementKind(entry); return <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6" key={id}><div className="flex min-w-0 items-start gap-3"><span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${isCovered ? 'bg-brand-50 text-brand-700' : 'bg-[#fff7e7] text-[#a06b20]'}`}><Icon name={isCovered ? 'check' : 'warning'} size={14} /></span><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium text-ink">{id}</p><Badge tone={kind === 'must_have' ? 'green' : 'gray'}>{kindLabel[kind] || 'Requirement'}</Badge></div><p className="mt-1 text-xs text-muted">{isCovered ? 'Covered by the current question set' : 'Not covered yet'}</p></div></div><div className="flex shrink-0 items-center gap-3">{question && <span className="text-xs font-medium text-brand-700">{question.id}</span>}<Badge tone={isCovered ? 'green' : 'amber'}>{isCovered ? 'Covered' : 'Gap'}</Badge></div></li>; })}</ul>}</Card>
  </div>;
}

