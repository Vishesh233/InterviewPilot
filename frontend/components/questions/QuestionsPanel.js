'use client';

import { useEffect, useState } from 'react';
import { Badge, Button, Card } from '@/components/ui/Primitives';
import { Icon } from '@/components/ui/Icon';
import AnswerPractice from '@/components/answers/AnswerPractice';
import { answerPoints, difficultyLabel, questionText } from '@/lib/format';
import { feedbackHistoryFor } from '@/lib/answerFeedback';

// "resume" identifies questions grounded in the candidate's own experience and
// projects. It is a new backend category, so the label/tone are mapped here.
const CATEGORY_LABELS = {
  technical: 'technical',
  behavioral: 'behavioral',
  company: 'company',
  role_specific: 'role specific',
  resume: 'Resume & project',
};
const categoryLabel = (category) => CATEGORY_LABELS[category] || category || 'role specific';
const isResumeQuestion = (question) => question?.category === 'resume';

function QuestionEditor({ question, onCancel, onSave, saving }) {
  const [draft, setDraft] = useState({ question: questionText(question), answer: answerPoints(question).join('\n'), why: question.why || '' });
  const update = (field) => (event) => setDraft((current) => ({ ...current, [field]: event.target.value }));
  return <div className="space-y-4"><div><label className="field-label" htmlFor={`question-${question.id}`}>Question prompt</label><textarea className="field-input min-h-24" id={`question-${question.id}`} onChange={update('question')} value={draft.question} /></div><div><label className="field-label" htmlFor={`answer-${question.id}`}>Answer outline <span className="font-normal text-muted">(one point per line)</span></label><textarea className="field-input min-h-28" id={`answer-${question.id}`} onChange={update('answer')} value={draft.answer} /></div><div><label className="field-label" htmlFor={`why-${question.id}`}>Why it matters</label><input className="field-input" id={`why-${question.id}`} onChange={update('why')} value={draft.why} /></div><div className="flex justify-end gap-2"><Button onClick={onCancel} type="button" variant="quiet">Cancel</Button><Button disabled={saving || !draft.question.trim() || !draft.answer.trim()} onClick={() => onSave({ question: draft.question, expectedAnswerPoints: draft.answer.split('\n').map((item) => item.trim()).filter(Boolean), why: draft.why })} type="button">{saving ? 'Saving…' : 'Save changes'}</Button></div></div>;
}

// Compact, collapsible card: the question is always visible; the answer
// outline, the requirements it covers and why it matters open on demand.
function QuestionCard({ question, index, number, total, expanded, onToggle, canReorder, editing, saving, onEdit, onCancel, onSave, onPin, onMove, onDelete, readOnly, answerSlot }) {
  const points = answerPoints(question);
  const detailsId = `question-details-${question.id}`;
  const open = expanded || editing;
  return <Card className={`scroll-mt-28 p-4 sm:p-5 ${question.pinned ? 'border-brand-200' : ''}`} id={`question-card-${question.id}`}>
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-muted">{String(number).padStart(2, '0')}</span>
      <Badge tone={isResumeQuestion(question) ? 'amber' : 'green'}>{categoryLabel(question.category)}</Badge>
      <Badge tone="gray">{difficultyLabel(question.difficulty)}</Badge>
      {question.status === 'edited' && <Badge tone="amber">Edited</Badge>}
      {question.pinned && <Badge tone="green">Pinned</Badge>}
    </div>
    {editing
      ? <div className="mt-4"><QuestionEditor onCancel={onCancel} onSave={onSave} question={question} saving={saving} /></div>
      : <>
        <h3 className="mt-3 text-[15px] font-semibold leading-6 text-ink">{questionText(question)}</h3>
        {open && <div className="mt-4 grid gap-5 border-t border-line pt-4 md:grid-cols-[1fr_200px]" id={detailsId}>
          <div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Answer outline</p><ul className="mt-2 space-y-2">{points.map((point, pointIndex) => <li className="flex gap-2 text-sm leading-5 text-muted" key={`${question.id}-${pointIndex}`}><Icon className="mt-0.5 shrink-0 text-brand-600" name="check" size={14} />{point}</li>)}</ul></div>
          <div><p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Covers</p><div className="mt-2 flex flex-wrap gap-1.5">{(question.requirementRefs || []).map((ref) => <Badge key={ref} tone="gray">{ref}</Badge>)}</div>{question.why && <p className="mt-3 text-xs leading-5 text-muted">{question.why}</p>}</div>
        </div>}
      </>}
    {!editing && <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
      <Button aria-controls={detailsId} aria-expanded={open} onClick={onToggle} type="button" variant="quiet"><Icon className={`transition-transform ${open ? 'rotate-180' : ''}`} name="down" size={16} /><span className="sm:hidden">Answer</span><span className="hidden sm:inline">{open ? 'Hide answer outline' : 'Show answer outline'}</span></Button>
      {!readOnly && <div className="flex items-center gap-0.5 sm:gap-1 [&>button]:px-2.5 sm:[&>button]:px-3">
        {canReorder && <><Button aria-label={`Move ${question.id} up`} disabled={index === 0 || saving} onClick={() => onMove(-1)} title="Move up" variant="quiet"><Icon className="rotate-[-90deg]" name="arrow" size={15} /></Button><Button aria-label={`Move ${question.id} down`} disabled={index === total - 1 || saving} onClick={() => onMove(1)} title="Move down" variant="quiet"><Icon className="rotate-90" name="arrow" size={15} /></Button></>}
        <Button aria-label={`Edit ${question.id}`} onClick={onEdit} title="Edit question" variant="quiet"><Icon name="edit" size={15} /></Button>
        <Button aria-label={`Pin ${question.id}`} aria-pressed={question.pinned === true} onClick={onPin} title={question.pinned ? 'Unpin question' : 'Pin question'} variant="quiet"><Icon className={question.pinned ? 'text-brand-600' : ''} name="pin" size={15} /></Button>
        <Button aria-label={`Delete ${question.id}`} disabled={saving || total <= 1} onClick={onDelete} title={total <= 1 ? 'At least one question is required' : 'Delete question'} variant="quiet"><Icon name="trash" size={15} /></Button>
      </div>}
    </div>}
    {!editing && answerSlot && <div className="mt-3 border-t border-line pt-3">{answerSlot}</div>}
  </Card>;
}

// `readOnly` (demo kits) hides reorder, edit, pin and delete. `answers`
// ({ token, kitId, demo, onAttempt }) adds "Answer this question" to each card.
// `focusQuestionId` opens that question and scrolls to it (links from a mock interview report).
export default function QuestionsPanel({ kit, onEdit, onPin, onReorder, onSave, onDelete, savingId, editingId, onCancelEdit, readOnly = false, answers, focusQuestionId }) {
  const questions = kit?.questions || [];
  const resumeCount = questions.filter(isResumeQuestion).length;
  const [filter, setFilter] = useState('all');
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const hasFocusQuestion = Boolean(focusQuestionId) && questions.some((question) => question.id === focusQuestionId);
  useEffect(() => {
    if (!hasFocusQuestion) return;
    setExpandedIds((current) => new Set([...current, focusQuestionId]));
    requestAnimationFrame(() => document.getElementById(`question-card-${focusQuestionId}`)?.scrollIntoView({ block: 'start' }));
  }, [focusQuestionId, hasFocusQuestion]);
  const categoryOf = (question) => question.category || 'role_specific';
  const categories = [...new Set(questions.map(categoryOf))];
  const visible = questions
    .map((question, index) => ({ question, index }))
    .filter(({ question }) => filter === 'all' || categoryOf(question) === filter);
  const allExpanded = visible.length > 0 && visible.every(({ question }) => expandedIds.has(question.id));
  const toggle = (id) => setExpandedIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setExpandedIds(allExpanded ? new Set() : new Set(visible.map(({ question }) => question.id)));
  const chip = (value, label, count) => <button aria-pressed={filter === value} className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${filter === value ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-surface text-muted hover:border-brand-500 hover:text-brand-700'}`} key={value} onClick={() => setFilter(value)} type="button">{label} <span className={filter === value ? 'text-brand-100' : 'text-faint'}>{count}</span></button>;

  return <div className="space-y-4">
    <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
      <div><p className="eyebrow">Question bank</p><h2 className="mt-2 text-xl font-semibold tracking-tight text-ink">Make the questions yours.</h2><p className="mt-1 max-w-2xl text-sm leading-6 text-muted">Open a question for its answer outline. Edit, pin or reorder to shape your practice.</p></div>
      <div className="flex items-center gap-2"><Badge tone="green">{questions.length} questions</Badge>{resumeCount > 0 && <Badge tone="amber">{resumeCount} from your resume</Badge>}</div>
    </div>
    {questions.length > 0 && <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div aria-label="Filter questions by category" className="flex flex-wrap gap-2" role="group">
        {chip('all', 'All', questions.length)}
        {categories.map((category) => chip(category, categoryLabel(category), questions.filter((question) => categoryOf(question) === category).length))}
      </div>
      <Button className="self-start sm:self-auto" onClick={toggleAll} type="button" variant="quiet">{allExpanded ? 'Collapse all' : 'Expand all'}</Button>
    </div>}
    {questions.length === 0
      ? <Card className="p-8 text-center text-sm text-muted">No questions were generated for this kit.</Card>
      : visible.map(({ question, index }) => <QuestionCard canReorder={!readOnly && filter === 'all'} readOnly={readOnly} editing={editingId === question.id} expanded={expandedIds.has(question.id)} index={index} key={question.id} number={index + 1} onCancel={onCancelEdit} onDelete={() => onDelete(question)} onEdit={() => onEdit(question.id)} onMove={(direction) => onReorder(index, direction)} onPin={() => onPin(question)} onSave={(changes) => onSave(question.id, changes)} onToggle={() => toggle(question.id)} question={question} saving={savingId === question.id} total={questions.length} answerSlot={answers && <AnswerPractice demo={answers.demo} history={feedbackHistoryFor(kit, question.id)} kitId={answers.kitId} onAttempt={answers.onAttempt} question={question} token={answers.token} />} />)}
  </div>;
}
