'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { Alert, Badge, Button, Card, LinkButton, LoadingState } from '@/components/ui/Primitives';
import { Icon } from '@/components/ui/Icon';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { RetryNotice } from '@/components/jobs/JobStatus';
import { useJobPolling } from '@/components/jobs/useJobPolling';
import { FeedbackDetails, VerdictBadge, useCountdown } from '@/components/answers/AnswerPractice';
import { jobFailureMessage } from '@/lib/jobs';
import { formatDate, questionText } from '@/lib/format';
import { MAX_ANSWER_LENGTH, MIN_ANSWER_LENGTH, answerLengthProblem, formatClock } from '@/lib/answerFeedback';
import {
  MOCK_LENGTHS,
  chatTurns,
  clearPendingTurn,
  feedbackLine,
  loadPendingTurn,
  progressLabel,
  savePendingTurn,
  scoreBarClass,
  sessionStatusLabel,
} from '@/lib/mockInterview';

const messageOf = (error, fallback) => (error instanceof ApiError ? error.message : fallback);
const kitHref = (kitId, suffix = '') => `/kits/${encodeURIComponent(kitId)}${suffix}`;

// ---- chat pieces --------------------------------------------------------------

function InterviewerMessage({ turn, of }) {
  return <div className="flex max-w-[92%] gap-2.5 sm:max-w-[80%]">
    <span aria-hidden="true" className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700"><Icon name="chat" size={16} /></span>
    <div className="min-w-0 rounded-2xl rounded-tl-sm border border-line bg-surface px-4 py-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-muted">
        <span>Interviewer · Question {turn.number}{of ? ` of ${of}` : ''}</span>
        {turn.kind === 'followUp' && <Badge tone="amber">Follow-up</Badge>}
      </div>
      <p className="mt-1.5 text-sm leading-6 text-ink">{turn.questionText}</p>
    </div>
  </div>;
}

function UserMessage({ text }) {
  return <div className="ml-auto max-w-[92%] sm:max-w-[80%]">
    <p className="sr-only">Your answer:</p>
    <p className="whitespace-pre-line break-words rounded-2xl rounded-tr-sm bg-brand-50 px-4 py-3 text-sm leading-6 text-ink ring-1 ring-inset ring-brand-100">{text}</p>
  </div>;
}

function TurnFeedback({ feedback }) {
  return <div className="ml-auto max-w-[92%] rounded-xl border border-line bg-subtle px-4 py-3 sm:max-w-[80%]">
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-semibold text-ink" aria-label={`Score ${feedback.score} out of 10`}>{feedback.score}<span className="text-xs font-medium text-muted">/10</span></span>
      <VerdictBadge verdict={feedback.verdict} />
      <span className="min-w-0 flex-1 text-xs leading-5 text-muted">{feedbackLine(feedback)}</span>
    </div>
    <details className="group mt-2">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-control text-xs font-semibold text-muted hover:text-brand-700 [&::-webkit-details-marker]:hidden"><Icon className="transition-transform group-open:rotate-180" name="down" size={14} />Full feedback</summary>
      <div className="mt-3"><FeedbackDetails feedback={feedback} /></div>
    </details>
  </div>;
}

// Three dots; the pulse stops for prefers-reduced-motion.
function TypingIndicator({ job, pollError }) {
  return <div className="space-y-2">
    <div className="flex items-center gap-2.5">
      <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-50 text-brand-700"><Icon name="chat" size={16} /></span>
      <div className="flex items-center gap-2 rounded-2xl rounded-tl-sm border border-line bg-surface px-4 py-3 text-sm text-muted shadow-card">
        <span aria-hidden="true" className="flex gap-1">{[0, 1, 2].map((dot) => <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500 motion-reduce:animate-none" key={dot} style={{ animationDelay: `${dot * 200}ms` }} />)}</span>
        Reviewing your answer…
      </div>
    </div>
    <RetryNotice job={job} />
    {pollError && <p className="text-xs text-muted">{pollError}</p>}
  </div>;
}

function ChatLog({ session, pending, job, pollError, live = true }) {
  const turns = chatTurns(session);
  return <div aria-label="Interview conversation" className="space-y-4" role={live ? 'log' : undefined}>
    {turns.map((turn) => <div className="space-y-3" key={turn.index}>
      <InterviewerMessage of={session.length} turn={turn} />
      {turn.answer !== null && <UserMessage text={turn.answer} />}
      {turn.feedback && <TurnFeedback feedback={turn.feedback} />}
      {turn.answer === null && pending?.turnIndex === turn.index && <><UserMessage text={pending.answer} /><TypingIndicator job={job} pollError={pollError} /></>}
    </div>)}
  </div>;
}

// ---- answer box ------------------------------------------------------------------

function AnswerBox({ question, answer, onAnswer, onSubmit, busy, interviewMode, textareaRef }) {
  const baseId = useId();
  const secondsLeft = useCountdown(interviewMode && question && !busy ? question.turnIndex + 1 : 0);
  const timeUp = interviewMode && !busy && secondsLeft === 0;
  const problem = answerLengthProblem(answer);
  const length = answer.trim().length;
  const submit = () => { if (!problem && !busy) onSubmit(); };
  return <div className="rounded-xl border border-line bg-surface p-4 shadow-card sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <label className="text-sm font-medium text-ink" htmlFor={`${baseId}-answer`}>Your answer{question?.kind === 'followUp' ? ' to the follow-up' : ''}</label>
      {interviewMode && !busy && <span aria-hidden="true" className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${timeUp ? 'bg-danger-50 text-danger-700' : secondsLeft <= 30 ? 'bg-warning-50 text-warning-700' : 'bg-sunken text-muted'}`}><Icon name="clock" size={13} />{formatClock(secondsLeft)}</span>}
    </div>
    <textarea
      aria-describedby={`${baseId}-count ${baseId}-hint`}
      aria-invalid={length > MAX_ANSWER_LENGTH}
      aria-readonly={timeUp || undefined}
      className={`field-input mt-2 min-h-32 resize-y ${timeUp ? 'bg-sunken text-muted' : ''}`}
      disabled={busy}
      id={`${baseId}-answer`}
      maxLength={MAX_ANSWER_LENGTH + 500}
      onChange={(event) => onAnswer(event.target.value)}
      onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); submit(); } }}
      placeholder="Answer as you would in the interview."
      readOnly={timeUp}
      ref={textareaRef}
      value={answer}
    />
    {timeUp && <p className="mt-2 text-xs font-medium text-danger-700">Time's up. You can still submit what you wrote.</p>}
    <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
      <p className={`text-xs ${length > MAX_ANSWER_LENGTH ? 'text-danger-700' : 'text-muted'}`} id={`${baseId}-count`}>{length} / {MAX_ANSWER_LENGTH} characters{problem ? ` · ${problem}` : ''}<span className="sr-only">. Answers need {MIN_ANSWER_LENGTH} to {MAX_ANSWER_LENGTH} characters.</span></p>
      <div className="flex items-center gap-3">
        <span className="hidden text-xs text-faint sm:inline" id={`${baseId}-hint`}>Ctrl + Enter to submit</span>
        <Button disabled={Boolean(problem) || busy} onClick={submit} type="button"><Icon name="arrow" size={15} />{busy ? 'Reviewing…' : 'Submit'}</Button>
      </div>
    </div>
  </div>;
}

// ---- report card -------------------------------------------------------------------

function ReportCard({ kit, kitId, session, onRetry, retrying, retryJob, retryPollError, retryError, onStartAnother }) {
  const { report } = session;
  const questionById = new Map((kit?.questions || []).map((question) => [question.id, question]));
  const practiceIds = (report?.practiceNext || []).map((item) => item.questionId);
  return <div className="space-y-5">
    {report ? <Card className="p-5 sm:p-7">
      <p className="eyebrow">Report card</p>
      <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
        <p aria-label={`Overall score ${report.overallScore} out of 10`} className="font-display text-6xl leading-none tracking-tight text-ink">{report.overallScore}<span className="text-2xl text-muted">/10</span></p>
        <p className="max-w-2xl text-sm leading-6 text-ink">{report.summary}</p>
      </div>

      <h2 className="mt-7 text-sm font-semibold text-ink">By topic</h2>
      <ul className="mt-3 space-y-3">
        {report.topicResults.map((topic) => <li key={topic.topic}>
          <div className="flex items-baseline justify-between gap-3 text-sm"><span className="font-medium text-ink">{topic.topic}</span><span className="shrink-0 font-semibold tabular-nums text-ink">{topic.score}/10</span></div>
          <div aria-hidden="true" className="mt-1.5 h-2 overflow-hidden rounded-full bg-sunken"><div className={`h-full rounded-full ${scoreBarClass(topic.score)}`} style={{ width: `${topic.score * 10}%` }} /></div>
          <p className="mt-1 text-xs leading-5 text-muted">{topic.note}</p>
        </li>)}
      </ul>

      {report.practiceNext.length > 0 && <>
        <h2 className="mt-7 text-sm font-semibold text-ink">Practice next</h2>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {report.practiceNext.map((item) => <li key={item.questionId}>
            <Link className="block h-full rounded-xl border border-line bg-subtle p-4 transition hover:border-brand-500" href={kitHref(kitId, `?section=questions&question=${encodeURIComponent(item.questionId)}`)}>
              <p className="text-sm font-medium leading-6 text-ink">{questionText(questionById.get(item.questionId)) || item.questionId}</p>
              <p className="mt-1 text-xs leading-5 text-muted">{item.reason}</p>
              <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-700">Open question<Icon name="arrow" size={13} /></span>
            </Link>
          </li>)}
        </ul>
      </>}
      <div className="mt-6 flex flex-wrap gap-2">
        {practiceIds.length > 0 && <LinkButton href={kitHref(kitId, `/practice?questions=${practiceIds.map(encodeURIComponent).join(',')}`)} variant="primary"><Icon name="book" size={15} />Practice these</LinkButton>}
        <Button onClick={onStartAnother} type="button" variant="secondary"><Icon name="refresh" size={15} />Start another interview</Button>
        <LinkButton href={kitHref(kitId)} variant="quiet">Back to kit</LinkButton>
      </div>
    </Card> : <Card className="p-5 sm:p-7">
      <p className="eyebrow">Report card</p>
      <h2 className="mt-2 text-lg font-semibold text-ink">Report unavailable</h2>
      <p className="mt-1 text-sm leading-6 text-muted">{session.reportError?.message || 'Your answers are saved, but the report card could not be written.'}</p>
      {retryError && <Alert className="mt-3">{retryError}</Alert>}
      {retrying && <div className="mt-3"><RetryNotice job={retryJob} />{retryPollError && <p className="text-xs text-muted">{retryPollError}</p>}</div>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={retrying} onClick={onRetry} type="button"><Icon name="refresh" size={15} />{retrying ? 'Writing the report…' : 'Retry'}</Button>
        <Button onClick={onStartAnother} type="button" variant="secondary">Start another interview</Button>
        <LinkButton href={kitHref(kitId)} variant="quiet">Back to kit</LinkButton>
      </div>
    </Card>}
    <details className="group rounded-card border border-line bg-surface">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-4 text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">Your answers ({session.turns.length} turns)<Icon className="shrink-0 text-muted transition-transform group-open:rotate-180" name="down" size={16} /></summary>
      <div className="border-t border-line p-4 sm:p-5"><ChatLog live={false} session={session} /></div>
    </details>
  </div>;
}

// ---- start screen ------------------------------------------------------------------

function PastInterviews({ sessions, onOpen, openingId }) {
  if (!sessions.length) return null;
  return <Card className="p-5 sm:p-6">
    <h2 className="text-sm font-semibold text-ink">Past interviews</h2>
    <ul className="mt-3 divide-y divide-line">
      {sessions.map((summary) => <li className="flex flex-wrap items-center justify-between gap-2 py-2.5" key={summary.id}>
        <div className="text-sm"><span className="font-medium text-ink">{formatDate(summary.createdAt)}</span><span className="text-muted"> · {summary.length} questions</span></div>
        <div className="flex items-center gap-2">
          <Badge tone={summary.status === 'completed' ? (summary.overallScore >= 6 ? 'green' : 'amber') : 'gray'}>{sessionStatusLabel(summary)}</Badge>
          {summary.status !== 'abandoned' && <Button aria-label={`${summary.status === 'active' ? 'Continue' : 'View report of'} the interview from ${formatDate(summary.createdAt)}`} disabled={openingId === summary.id} onClick={() => onOpen(summary.id)} type="button" variant="quiet">{summary.status === 'active' ? 'Continue' : 'View report'}</Button>}
        </div>
      </li>)}
    </ul>
  </Card>;
}

function StartScreen({ length, onLength, interviewMode, onInterviewMode, onStart, starting, error, conflict, onContinueConflict, onEndConflict, resolving }) {
  const groupId = useId();
  return <Card className="p-5 sm:p-7">
    <p className="eyebrow">New mock interview</p>
    <h2 className="mt-2 text-xl font-semibold tracking-tight text-ink">Practice the real conversation.</h2>
    <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">An AI interviewer asks questions from this kit, may follow up on an answer, and finishes with a report card of what to practice next.</p>
    <fieldset className="mt-5">
      <legend className="text-sm font-medium text-ink" id={groupId}>Number of questions</legend>
      <div className="mt-2 flex gap-2">
        {MOCK_LENGTHS.map((value) => <label className={`flex min-h-11 min-w-14 cursor-pointer items-center justify-center rounded-control border px-4 text-sm font-semibold transition has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-brand-100 ${length === value ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-surface text-ink hover:border-brand-500'}`} key={value}>
          <input checked={length === value} className="sr-only" name="mock-length" onChange={() => onLength(value)} type="radio" value={value} />{value}
        </label>)}
      </div>
    </fieldset>
    <label className="mt-5 flex cursor-pointer items-start gap-3 text-sm">
      <input checked={interviewMode} className="mt-0.5 h-4 w-4 accent-[rgb(var(--color-brand-600))]" onChange={(event) => onInterviewMode(event.target.checked)} type="checkbox" />
      <span><span className="font-medium text-ink">Interview mode</span><span className="block text-xs leading-5 text-muted">2 minutes per answer; typing stops when time runs out.</span></span>
    </label>
    {error && <Alert className="mt-5">{error}</Alert>}
    {conflict && <div className="mt-5 rounded-xl border border-warning-200 bg-warning-50 p-4" role="alert">
      <p className="text-sm font-semibold text-warning-700">You already have a mock interview in progress{conflict.kitLabel ? ` for ${conflict.kitLabel}` : ''}.</p>
      <div className="mt-3 flex flex-wrap gap-2"><Button disabled={resolving} onClick={onContinueConflict} type="button">Continue that interview</Button><Button disabled={resolving} onClick={onEndConflict} type="button" variant="secondary">{resolving ? 'Ending…' : 'End it and start here'}</Button></div>
    </div>}
    <Button className="mt-6" disabled={starting || Boolean(conflict)} onClick={onStart} type="button"><Icon name="chat" size={15} />{starting ? 'Starting…' : 'Start interview'}</Button>
  </Card>;
}

// ---- page ------------------------------------------------------------------------------

/** Mock interview for one kit: start screen, chat, report card, past interviews. */
export default function MockInterview({ token, kitId }) {
  const router = useRouter();
  const textareaRef = useRef(null);
  const [kit, setKit] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [session, setSession] = useState(null);
  const [view, setView] = useState('loading');
  const [loadError, setLoadError] = useState('');
  const [length, setLength] = useState(3);
  const [interviewMode, setInterviewMode] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  const [conflict, setConflict] = useState(null);
  const [resolving, setResolving] = useState(false);
  const [answer, setAnswer] = useState('');
  const [pending, setPending] = useState(null);
  const [turnError, setTurnError] = useState('');
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [openingId, setOpeningId] = useState(null);
  const [reportJobId, setReportJobId] = useState(null);
  const [reportError, setReportError] = useState('');
  const [announcement, setAnnouncement] = useState('');

  const refreshList = useCallback(async () => {
    try {
      setSessions((await api.listMockInterviews(token, kitId)).sessions || []);
    } catch (error) {
      console.warn('Could not reload past interviews.', error?.code || error?.name || error);
    }
  }, [kitId, token]);

  const showSession = useCallback((next) => {
    setSession(next);
    setView(next.status === 'active' ? 'interview' : next.status === 'completed' ? 'report' : 'start');
    if (next.status === 'active') {
      const stored = loadPendingTurn(next.id);
      if (stored && stored.turnIndex === next.currentQuestion?.turnIndex) setPending(stored);
      else if (stored) clearPendingTurn(next.id);
    }
  }, []);

  // First load: the kit, past interviews, and an active interview to resume.
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const [loadedKit, list] = await Promise.all([api.getKit(token, kitId), api.listMockInterviews(token, kitId)]);
        if (cancelled) return;
        setKit(loadedKit);
        setSessions(list.sessions || []);
        const active = (list.sessions || []).find((summary) => summary.status === 'active');
        if (active) showSession((await api.getMockInterview(token, active.id)).session);
        else setView('start');
      } catch (error) {
        if (cancelled) return;
        setLoadError(messageOf(error, 'We could not load the mock interview.'));
        setView('error');
      }
    })();
    return () => { cancelled = true; };
  }, [kitId, showSession, token]);

  const question = view === 'interview' ? session?.currentQuestion : null;
  // Focus the answer box for each new question (the chat log, role="log",
  // announces the new interviewer message itself).
  // Runs again when the box unlocks, since a disabled box cannot take focus.
  const answerLocked = Boolean(pending);
  useEffect(() => {
    if (!question || answerLocked) return;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [question?.turnIndex, answerLocked]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadSession = async (sessionId) => {
    const next = (await api.getMockInterview(token, sessionId)).session;
    showSession(next);
    if (next.status !== 'active') refreshList();
    return next;
  };

  const onTurnFinished = async (job) => {
    const done = pending;
    clearPendingTurn(session.id);
    if (job.status === 'succeeded') {
      // The answer box stays locked (pending) until the next question has
      // loaded, so the old question is never shown with an open box.
      try {
        const next = await reloadSession(session.id);
        // The chat log announces the next question; the status keeps only completion.
        setAnnouncement(next.status === 'completed'
          ? (next.report ? `Interview complete. Overall score ${next.report.overallScore} out of 10.` : 'Interview complete. The report is unavailable.')
          : '');
      } catch (error) {
        setTurnError(messageOf(error, 'Your answer was reviewed, but the interview could not be reloaded. Refresh the page.'));
      } finally {
        setAnswer('');
        setPending(null);
      }
      return;
    }
    setPending(null);
    // Keep the answer so it can be sent again.
    setAnswer(done?.answer || '');
    const message = jobFailureMessage(job.error);
    setTurnError(message);
    setAnnouncement(message);
  };
  const turnPoll = useJobPolling({ token, jobId: pending?.jobId, onFinished: onTurnFinished });
  useEffect(() => {
    if (!turnPoll.notFound || !session) return;
    clearPendingTurn(session.id);
    setAnswer(pending?.answer || '');
    setPending(null);
    setTurnError('The review could not be found. Please submit your answer again.');
  }, [turnPoll.notFound]); // eslint-disable-line react-hooks/exhaustive-deps

  const watchTurn = (jobId, text) => {
    const next = { jobId, answer: text, turnIndex: question.turnIndex };
    savePendingTurn(session.id, next);
    setPending(next);
    setAnnouncement('Reviewing your answer…');
  };

  const submit = async () => {
    const text = answer;
    setTurnError('');
    try {
      const { jobId } = await api.answerMockInterview(token, session.id, text);
      watchTurn(jobId, text);
    } catch (error) {
      if (error instanceof ApiError && error.code === 'JOB_ALREADY_RUNNING' && error.jobId) {
        watchTurn(error.jobId, text);
        return;
      }
      setTurnError(messageOf(error, 'We could not send your answer. Please try again.'));
    }
  };

  const start = async () => {
    setStarting(true); setStartError(''); setConflict(null);
    try {
      const { session: created } = await api.startMockInterview(token, kitId, length);
      setAnswer(''); setTurnError('');
      showSession(created);
      refreshList();
    } catch (error) {
      const activeId = error instanceof ApiError && error.code === 'MOCK_ALREADY_ACTIVE' ? error.details?.sessionId : null;
      if (activeId) {
        try {
          const other = (await api.getMockInterview(token, activeId)).session;
          setConflict({ sessionId: activeId, kitId: other.kitId, kitLabel: other.kitId === kitId ? 'this kit' : 'another kit' });
        } catch (lookupError) {
          setStartError(messageOf(lookupError, 'You already have a mock interview in progress.'));
        }
      } else {
        setStartError(messageOf(error, 'We could not start the interview.'));
      }
    } finally { setStarting(false); }
  };

  const continueConflict = async () => {
    if (conflict.kitId !== kitId) { router.push(kitHref(conflict.kitId, '/interview')); return; }
    setConflict(null);
    await openSession(conflict.sessionId);
  };
  const endConflictAndStart = async () => {
    setResolving(true);
    try {
      await api.abandonMockInterview(token, conflict.sessionId);
      setConflict(null);
      await start();
    } catch (error) {
      setStartError(messageOf(error, 'We could not end the other interview.'));
    } finally { setResolving(false); }
  };

  const openSession = async (sessionId) => {
    setOpeningId(sessionId);
    try { await reloadSession(sessionId); } catch (error) { setStartError(messageOf(error, 'We could not open that interview.')); } finally { setOpeningId(null); }
  };

  const endInterview = async () => {
    setEnding(true);
    try {
      await api.abandonMockInterview(token, session.id);
      clearPendingTurn(session.id);
      setConfirmEnd(false); setPending(null); setSession(null); setAnswer('');
      setView('start');
      refreshList();
    } catch (error) {
      setConfirmEnd(false);
      setTurnError(messageOf(error, 'We could not end the interview.'));
    } finally { setEnding(false); }
  };

  const onReportFinished = async (job) => {
    setReportJobId(null);
    if (job.status !== 'succeeded') { setReportError(jobFailureMessage(job.error)); return; }
    try { await reloadSession(session.id); } catch (error) { setReportError(messageOf(error, 'The report was written, but it could not be loaded. Refresh the page.')); }
  };
  const reportPoll = useJobPolling({ token, jobId: reportJobId, onFinished: onReportFinished });
  const retryReport = async () => {
    setReportError('');
    try { setReportJobId((await api.retryMockReport(token, session.id)).jobId); } catch (error) { setReportError(messageOf(error, 'We could not retry the report.')); }
  };

  const startAnother = () => { setSession(null); setAnswer(''); setTurnError(''); setView('start'); refreshList(); };

  if (view === 'loading') return <LoadingState detail="Checking for an interview in progress." label="Opening mock interview" />;
  if (view === 'error') return <Alert title="Mock interview is unavailable">{loadError}</Alert>;

  const pastSessions = sessions.filter((summary) => summary.id !== session?.id || view !== 'interview');
  return <div className="space-y-5">
    <div aria-live="polite" className="sr-only" role="status">{announcement}</div>
    {view === 'start' && <>
      <StartScreen conflict={conflict} error={startError} interviewMode={interviewMode} length={length} onContinueConflict={continueConflict} onEndConflict={endConflictAndStart} onInterviewMode={setInterviewMode} onLength={setLength} onStart={start} resolving={resolving} starting={starting} />
      <PastInterviews onOpen={openSession} openingId={openingId} sessions={pastSessions} />
    </>}
    {view === 'interview' && session && <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink">{question ? progressLabel(question) : 'Finishing…'}</p>
        <Button onClick={() => setConfirmEnd(true)} type="button" variant="quiet"><Icon name="close" size={15} />End interview</Button>
      </div>
      <ChatLog job={turnPoll.job} pending={pending} pollError={turnPoll.pollError} session={session} />
      {turnError && <Alert title="That answer was not reviewed">{turnError}</Alert>}
      {question && <AnswerBox answer={answer} busy={Boolean(pending)} interviewMode={interviewMode} onAnswer={setAnswer} onSubmit={submit} question={question} textareaRef={textareaRef} />}
    </>}
    {view === 'report' && session && <>
      <ReportCard kit={kit} kitId={kitId} onRetry={retryReport} onStartAnother={startAnother} retryError={reportError} retryJob={reportPoll.job} retryPollError={reportPoll.pollError} retrying={Boolean(reportJobId)} session={session} />
      <PastInterviews onOpen={openSession} openingId={openingId} sessions={sessions.filter((summary) => summary.id !== session.id)} />
    </>}
    <ConfirmDialog busy={ending} busyLabel="Ending…" confirmLabel="End interview" onCancel={() => setConfirmEnd(false)} onConfirm={endInterview} open={confirmEnd} title="End this interview?">Your answers so far stay in the history, but the interview cannot be continued and no report card is written.</ConfirmDialog>
  </div>;
}
