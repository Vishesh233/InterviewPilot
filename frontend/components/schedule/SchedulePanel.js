import { Badge, Card } from '@/components/ui/Primitives';
import { Icon } from '@/components/ui/Icon';
import { formatDuration, questionText } from '@/lib/format';

// A schedule day only carries an estimate when the backend actually provides
// one, so the estimate is rendered only then. Nothing is ever invented here —
// without a value the meta line shows the question count alone.
const ESTIMATE_KEYS = [
  'estimatedMinutes',
  'estimated_minutes',
  'estimatedTime',
  'estimated_time',
  'durationMinutes',
  'duration_minutes',
  'duration',
];

const estimateLabel = (day) => {
  if (!day) return '';
  for (const key of ESTIMATE_KEYS) {
    const value = day[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      return formatDuration(value); // e.g. 30 -> "30 min"
    }
    if (typeof value === 'string' && value.trim()) {
      return value.trim(); // already human-readable — shown as is
    }
  }
  return '';
};

const dayMetaLabel = (day, count) => {
  if (!count) return 'A lighter review day';
  const countLabel = `${count} question${count === 1 ? '' : 's'}`;
  const estimate = estimateLabel(day);
  return estimate ? `${countLabel} · ${estimate}` : countLabel;
};

export default function SchedulePanel({ kit }) {
  const schedule = kit?.schedule || {};
  const days = Array.isArray(schedule.days) ? schedule.days : [];
  const byId = new Map((kit?.questions || []).map((question) => [question.id, question]));
  const idList = (day) => day.question_ids || day.questionIds || day.questions || [];
  return <div className="space-y-5"><div><p className="eyebrow">Preparation schedule</p><h2 className="mt-2 text-xl font-semibold tracking-tight text-ink">A deliberate path to the interview.</h2><p className="mt-1 text-sm leading-6 text-muted">The day grouping below is rendered from the backend schedule. The frontend does not redistribute questions.</p></div>{days.length === 0 ? <Card className="p-8 text-center text-sm text-muted">No schedule was recorded for this kit.</Card> : <div className="space-y-3">{days.map((day, index) => { const ids = idList(day); const questions = ids.map((id) => byId.get(id)).filter(Boolean); const isNext = index === 0; return <Card className={`p-5 sm:p-6 ${isNext ? 'border-brand-200' : ''}`} key={day.day || index}><div className="flex gap-4"><div className={`flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-xl ${isNext ? 'bg-brand-600 text-white' : 'bg-[#f0f3ef] text-ink'}`}><span className="text-[9px] font-semibold uppercase tracking-[0.12em]">Day</span><span className="text-lg font-semibold leading-5">{day.day || index + 1}</span></div><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-ink">{isNext ? 'Start here' : 'Continue the plan'}</h3>{isNext && <Badge>Priority</Badge>}</div><p className="mt-1 text-xs text-muted">{dayMetaLabel(day, questions.length)}</p>{questions.length > 0 && <ul className="mt-4 grid gap-2 sm:grid-cols-2">{questions.map((question) => <li className="flex items-start gap-2 text-sm leading-5 text-muted" key={question.id}><Icon className="mt-0.5 shrink-0 text-brand-600" name="check" size={14} /><span className="line-clamp-2">{questionText(question)}</span></li>)}</ul>}</div></div></Card>; })}</div>}</div>;
}
