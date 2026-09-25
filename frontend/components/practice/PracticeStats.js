import { EmptyState } from '@/components/ui/Primitives';
import { ProgressBar, Stat } from '@/components/ui/DataDisplay';

export function PracticeStats({ progress }) {
  const covered = progress.total ? Math.round((progress.covered / progress.total) * 100) : 0;
  return <div className="space-y-5"><div className="grid gap-3 sm:grid-cols-4"><Stat label="Total cards" value={progress.total || 0} /><Stat label="Covered" value={progress.covered || 0} tone="green" /><Stat label="Uncovered" value={progress.uncovered || 0} /><Stat label="Average confidence" value={progress.averageConfidence == null ? '—' : progress.averageConfidence} detail="1–5 scale" /></div><div className="rounded-xl border border-line bg-white px-4 py-3"><div className="flex items-center justify-between text-xs"><span className="font-medium text-muted">Overall progress</span><span className="font-semibold text-brand-700">{covered}%</span></div><ProgressBar className="mt-2" value={covered} /></div></div>;
}

export function PracticeEmpty({ onBack }) {
  return <EmptyState icon="book" title="No flashcards to practice" action={onBack ? <button className="button-secondary" onClick={onBack} type="button">Back to kit</button> : null}>This kit does not contain a flashcard deck yet.</EmptyState>;
}
