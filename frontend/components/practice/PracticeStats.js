import { EmptyState } from '@/components/ui/Primitives';
import { ProgressBar, Stat } from '@/components/ui/DataDisplay';

export function PracticeStats({ progress }) {
  const covered = progress.total ? Math.round((progress.covered / progress.total) * 100) : 0;
  const average = typeof progress.averageConfidence === 'number' ? progress.averageConfidence.toFixed(1) : '—';
  return <div className="space-y-3 sm:space-y-5"><div className="grid grid-cols-2 gap-2 sm:grid-cols-4 sm:gap-3"><Stat compact label="Total cards" value={progress.total || 0} /><Stat compact label="Covered" value={progress.covered || 0} tone="green" /><Stat compact label="Uncovered" value={progress.uncovered || 0} /><Stat compact label="Avg. confidence" value={average} detail="1–5 scale" /></div><div className="rounded-xl border border-line bg-white px-4 py-3"><div className="flex items-center justify-between text-xs"><span className="font-medium text-muted">Overall progress</span><span className="font-semibold text-brand-700">{covered}%</span></div><ProgressBar className="mt-2" label="Overall practice progress" value={covered} /></div></div>;
}

export function PracticeEmpty({ onBack }) {
  return <EmptyState icon="book" title="No flashcards to practice" action={onBack ? <button className="button-secondary" onClick={onBack} type="button">Back to kit</button> : null}>This kit does not contain a flashcard deck yet.</EmptyState>;
}
