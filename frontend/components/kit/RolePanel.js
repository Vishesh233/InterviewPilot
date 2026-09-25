import { Badge, Card } from '@/components/ui/Primitives';
import { Icon } from '@/components/ui/Icon';

export default function RolePanel({ kit }) {
  const role = kit?.role || {};
  const requirements = role.requirements || [];
  return <div className="space-y-5"><Card className="p-6"><p className="eyebrow">Role</p><h2 className="mt-3 font-display text-3xl tracking-tight text-ink">{role.title || 'Role not specified'}</h2>{role.level && <Badge className="mt-4" tone="green">{role.level}</Badge>}<div className="mt-7 border-t border-line pt-5"><p className="text-xs font-semibold uppercase tracking-[0.13em] text-muted">Requirements extracted from the brief</p><div className="mt-4 flex flex-wrap gap-2">{requirements.length ? requirements.map((entry) => <Badge key={typeof entry === 'string' ? entry : entry.id} tone="gray">{typeof entry === 'string' ? entry : entry.id}</Badge>) : <span className="text-sm text-muted">No requirements were recorded.</span>}</div></div></Card><Card className="p-6"><div className="flex gap-3"><span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Icon name="chart" size={17} /></span><div><h2 className="font-semibold text-ink">Use coverage as a compass</h2><p className="mt-2 text-sm leading-6 text-muted">Uncovered requirements stay visible instead of being quietly filled with guesses. Add or edit questions when you want to take ownership of the gap.</p></div></div></Card></div>;
}
