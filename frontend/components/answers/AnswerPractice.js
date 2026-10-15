'use client';

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Alert, Button, LinkButton } from '@/components/ui/Primitives';
import { Icon } from '@/components/ui/Icon';
import { RetryNotice } from '@/components/jobs/JobStatus';
import { useJobPolling } from '@/components/jobs/useJobPolling';
import { jobFailureMessage } from '@/lib/jobs';
import { formatDate, questionText } from '@/lib/format';
import {
  INTERVIEW_MODE_SECONDS,
  MAX_ANSWER_LENGTH,
  MIN_ANSWER_LENGTH,
  answerLengthProblem,
  formatClock,
  verdictOf,
} from '@/lib/answerFeedback';

const sectionLabel = 'text-xs font-semibold uppercase tracking-[0.12em] text-muted';

function VerdictBadge({ verdict }) {
  const { label, className } = verdictOf(verdict);
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${className}`}>{label}</span>;
}

// Hidden when empty: "What worked" may have no items for an off-topic or empty answer.
function FeedbackList({ title, items, icon, iconClass }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return <div><p className={sectionLabel}>{title}</p><ul className="mt-2 space-y-2">{items.map((item, index) => <li className="flex gap-2 text-sm leading-5 text-ink" key={index}><Icon className={`mt-0.5 shrink-0 ${iconClass}`} name={icon} size={14} />{item}</li>)}</ul></div>;
}

function FeedbackResult({ attempt, onTryAgain, onPracticeFollowUp }) {
  const { feedback } = attempt;
  return <div className="rounded-xl border border-line bg-subtle p-4 sm:p-5">
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-2xl font-semibold tracking-tight text-ink" aria-label={`Score ${feedback.score} out of 10`}>{feedback.score}<span className="text-base font-medium text-muted">/10</span></p>
      <VerdictBadge verdict={feedback.verdict} />
      {attempt.followUpQuestion && <span className="text-xs text-muted">Follow-up answer</span>}
    </div>
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <FeedbackList icon="check" iconClass="text-brand-600" items={feedback.strengths} title="What worked" />
      <FeedbackList icon="plus" iconClass="text-warning-700" items={feedback.gaps} title="What to add" />
    </div>
    <details className="group mt-4 rounded-control border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">Stronger answer<Icon className="shrink-0 text-muted transition-transform group-open:rotate-180" name="down" size={16} /></summary>
      <p className="border-t border-line px-4 py-3 text-sm leading-6 text-ink">{feedback.improvedAnswer}</p>
    </details>
    <div className="mt-4 rounded-control border border-line bg-surface px-4 py-3">
      <p className={sectionLabel}>Likely follow-up</p>
      <p className="mt-1.5 text-sm leading-6 text-ink">{feedback.followUp}</p>
      <Button className="-ml-3 mt-2" onClick={onPracticeFollowUp} type="button" variant="quiet"><Icon name="arrow" size={15} />Practice this follow-up</Button>
    </div>
    <div className="mt-4 flex flex-wrap gap-2"><Button onClick={onTryAgain} type="button" variant="secondary"><Icon name="refresh" size={15} />Try again</Button></div>
  </div>;
}

function AttemptHistory({ attempts }) {
  if (!attempts.length) return null;
  return <details className="group mt-3">
    <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-control text-xs font-semibold text-muted hover:text-brand-700 [&::-webkit-details-marker]:hidden"><Icon className="transition-transform group-open:rotate-180" name="down" size={14} />Previous attempts ({attempts.length})</summary>
    <ul className="mt-2 divide-y divide-line rounded-control border border-line bg-surface">
      {[...attempts].reverse().map((attempt) => <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs" key={attempt.id || attempt.createdAt}>
        <span className="font-semibold text-ink">{attempt.feedback?.score}/10</span>
        <VerdictBadge verdict={attempt.feedback?.verdict} />
        <span className="text-muted">{formatDate(attempt.createdAt)}</span>
        {attempt.followUpQuestion && <span className="text-muted">· follow-up</span>}
      </li>)}
    </ul>
  </details>;
}

// Two-minute countdown. Typing stops at zero; the answer can still be sent.
function useCountdown(running) {
  const [secondsLeft, setSecondsLeft] = useState(INTERVIEW_MODE_SECONDS);
  useEffect(() => {
    setSecondsLeft(INTERVIEW_MODE_SECONDS);
    if (!running) return undefined;
    const deadline = Date.now() + INTERVIEW_MODE_SECONDS * 1000;
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [running]);
  return secondsLeft;
}

/**
 * "Answer this question" with AI feedback, used on question cards and in
 * Practice Mode. `history` is the stored attempts (oldest first); new attempts
 * are reported through onAttempt(questionId, attempt). In `demo` mode the panel
 * only invites the visitor to register and never calls the API.
 */
export default function AnswerPractice({ question, kitId, token, demo = false, history = [], onAttempt }) {
  const baseId = useId();
  const textareaRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [answer, setAnswer] = useState('');
  const [followUp, setFollowUp] = useState(null);
  const [interviewMode, setInterviewMode] = useState(false);
  const [timerRun, setTimerRun] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [localAttempts, setLocalAttempts] = useState([]);

  const attempts = useMemo(() => {
    const known = new Set(history.map((attempt) => attempt?.id));
    return [...history, ...localAttempts.filter((attempt) => !known.has(attempt.id))];
  }, [history, localAttempts]);

  const secondsLeft = useCountdown(interviewMode && open && !result ? timerRun + 1 : 0);
  const timeUp = interviewMode && secondsLeft === 0;
  useEffect(() => { if (timeUp) setAnnouncement('Time is up. Typing is paused; you can still get feedback.'); }, [timeUp]);

  const onFinished = (job) => {
    setJobId(null);
    if (job.status === 'succeeded' && job.summary?.attempt) {
      const attempt = job.summary.attempt;
      setResult(attempt);
      setLocalAttempts((current) => [...current, attempt]);
      onAttempt?.(question.id, attempt);
      setAnnouncement(`Feedback ready: ${attempt.feedback.score} out of 10, ${verdictOf(attempt.feedback.verdict).label}.`);
      return;
    }
    const message = jobFailureMessage(job.error);
    setError(message);
    setAnnouncement(message);
  };
  const { job, pollError, notFound } = useJobPolling({ token, jobId, onFinished });
  useEffect(() => { if (notFound) { setJobId(null); setError('The review could not be found. Please try again.'); } }, [notFound]);
  const running = submitting || Boolean(jobId);

  const lengthProblem = answerLengthProblem(answer);
  const trimmedLength = answer.trim().length;
  const countId = `${baseId}-count`;
  const textareaId = `${baseId}-answer`;
  const graded = followUp || questionText(question);

  const submit = async () => {
    if (lengthProblem || running) return;
    setSubmitting(true); setError(''); setResult(null); setAnnouncement('Reviewing your answer…');
    try {
      const { jobId: started } = await api.requestAnswerFeedback(token, kitId, question.id, { answer, ...(followUp ? { followUpQuestion: followUp } : {}) });
      setJobId(started);
    } catch (requestError) {
      const message = requestError instanceof ApiError && requestError.code === 'JOB_ALREADY_RUNNING'
        ? 'Another answer in this kit is still being reviewed. Try again when it finishes.'
        : requestError instanceof ApiError ? requestError.message : 'We could not start the review. Please try again.';
      setError(message); setAnnouncement(message);
    } finally { setSubmitting(false); }
  };

  const restartTimer = () => setTimerRun((current) => current + 1);
  const tryAgain = () => { setResult(null); setError(''); restartTimer(); textareaRef.current?.focus(); };
  const practiceFollowUp = () => {
    setFollowUp(result.feedback.followUp); setAnswer(''); setResult(null); setError(''); restartTimer();
    setAnnouncement('Answer the follow-up question.');
    requestAnimationFrame(() => textareaRef.current?.focus());
  };
  const backToQuestion = () => { setFollowUp(null); setResult(null); setError(''); restartTimer(); };

  if (!open) {
    return <div className="text-left">
      <Button onClick={() => setOpen(true)} type="button" variant="secondary"><Icon name="edit" size={15} />Answer this question</Button>
      {!demo && <AttemptHistory attempts={attempts} />}
    </div>;
  }

  return <div className="space-y-3 text-left" role="region" aria-label="Answer practice">
    <div aria-live="polite" className="sr-only" role="status">{announcement}</div>
    {demo
      ? <div className="rounded-xl border border-brand-200 bg-brand-50 p-4">
        <p className="text-sm font-semibold text-brand-800">Create a free account to get AI feedback on your answers</p>
        <p className="mt-1 text-sm leading-6 text-brand-800/80">Write an answer, get a score, what worked, what to add and a stronger version. Practice with a two-minute interview timer.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2"><LinkButton href="/register" variant="primary">Create free account</LinkButton><Button onClick={() => setOpen(false)} type="button" variant="quiet">Close</Button></div>
      </div>
      : <div className="rounded-xl border border-line bg-surface p-4 sm:p-5">
        {followUp && <div className="mb-3 rounded-control border border-brand-200 bg-brand-50 px-3 py-2"><p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand-700">Follow-up question</p><p className="mt-1 text-sm leading-6 text-ink">{followUp}</p><Button className="-ml-3 mt-1 min-h-8" onClick={backToQuestion} type="button" variant="quiet">Back to the original question</Button></div>}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="text-sm font-medium text-ink" htmlFor={textareaId}>Your answer{followUp ? ' to the follow-up' : ''}</label>
          <div className="flex items-center gap-2">
            {interviewMode && !result && <span aria-hidden="true" className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${timeUp ? 'bg-danger-50 text-danger-700' : secondsLeft <= 30 ? 'bg-warning-50 text-warning-700' : 'bg-sunken text-muted'}`}><Icon name="clock" size={13} />{formatClock(secondsLeft)}</span>}
            <button aria-checked={interviewMode} className="inline-flex min-h-9 items-center gap-2 rounded-control px-2 text-xs font-semibold text-muted transition hover:text-brand-700 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand-100" onClick={() => { setInterviewMode((current) => !current); restartTimer(); }} role="switch" type="button">
              <span aria-hidden="true" className={`relative h-5 w-9 rounded-full transition ${interviewMode ? 'bg-brand-600' : 'bg-line-strong'}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${interviewMode ? 'left-[18px]' : 'left-0.5'}`} /></span>
              Interview mode<span className="sr-only"> (2-minute timer)</span>
            </button>
          </div>
        </div>
        <p className="sr-only">Answering: {graded}</p>
        <textarea aria-describedby={countId} aria-invalid={trimmedLength > MAX_ANSWER_LENGTH} aria-readonly={timeUp || undefined} className={`field-input mt-2 min-h-36 resize-y ${timeUp ? 'bg-sunken text-muted' : ''}`} disabled={running} id={textareaId} maxLength={MAX_ANSWER_LENGTH + 500} onChange={(event) => setAnswer(event.target.value)} placeholder="Answer as you would in the interview: what you did, how, and the result." readOnly={timeUp} ref={textareaRef} value={answer} />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className={`text-xs ${trimmedLength > MAX_ANSWER_LENGTH ? 'text-danger-700' : 'text-muted'}`} id={countId}>{trimmedLength} / {MAX_ANSWER_LENGTH} characters{lengthProblem ? ` · ${lengthProblem}` : ''}<span className="sr-only">. Answers need {MIN_ANSWER_LENGTH} to {MAX_ANSWER_LENGTH} characters.</span></p>
          <div className="flex items-center gap-2"><Button disabled={running} onClick={() => setOpen(false)} type="button" variant="quiet">Close</Button><Button disabled={Boolean(lengthProblem) || running} onClick={submit} type="button"><Icon name="spark" size={15} />{running ? 'Reviewing…' : 'Get feedback'}</Button></div>
        </div>
        {timeUp && !result && <p className="mt-2 text-xs font-medium text-danger-700">Time's up. You can still get feedback on what you wrote.</p>}
        {running && <div className="mt-3 space-y-2"><div className="flex items-center gap-3 rounded-xl border border-line bg-subtle px-4 py-3 text-sm"><span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brand-100 border-t-brand-600" /><span className="font-medium text-ink">Reviewing your answer…</span>{job?.status === 'queued' && <span className="text-muted">Waiting for a free slot</span>}</div><RetryNotice job={job} />{pollError && <p className="text-xs text-muted">{pollError}</p>}</div>}
        {error && <Alert className="mt-3" title="No feedback this time">{error}</Alert>}
        {result && <div className="mt-4"><FeedbackResult attempt={result} onPracticeFollowUp={practiceFollowUp} onTryAgain={tryAgain} /></div>}
        <AttemptHistory attempts={attempts} />
      </div>}
  </div>;
}
