'use client';

import { useEffect, useState } from 'react';
import { Alert, Button } from '@/components/ui/Primitives';
import { Icon } from '@/components/ui/Icon';
import { jobFailureMessage, stageLabel } from '@/lib/jobs';

const secondsUntil = (iso) => {
  const at = Date.parse(iso || '');
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1000)) : null;
};

// "Provider busy — retrying automatically (attempt N)" with a countdown to
// nextRetryAt.
export function RetryNotice({ job }) {
  const [seconds, setSeconds] = useState(() => secondsUntil(job?.nextRetryAt));
  useEffect(() => {
    setSeconds(secondsUntil(job?.nextRetryAt));
    const timer = setInterval(() => setSeconds(secondsUntil(job?.nextRetryAt)), 1000);
    return () => clearInterval(timer);
  }, [job?.nextRetryAt]);
  if (!job || job.status !== 'retrying') return null;
  return <Alert tone="info" title={`Provider busy — retrying automatically (attempt ${Math.max(1, job.resumeCount || 1)})`}>
    {seconds === null ? 'Retrying shortly.' : seconds > 0 ? `Next try in ${seconds}s. Finished steps are kept.` : 'Retrying now. Finished steps are kept.'}
  </Alert>;
}

export const stepText = (job) =>
  job?.stageCount ? `Step ${Math.max(1, job.stageIndex || 1)} of ${job.stageCount}` : 'Starting';

// The failure message (mapped from the error code) plus the failed stage.
export function JobFailure({ job, onResume, onStartOver, onDismiss, resuming = false, startOverLabel = 'Start over', className = '' }) {
  if (!job?.error) return null;
  return <Alert className={className} title="Generation could not be completed">
    <p>{jobFailureMessage(job.error)}{job.error.stage ? ` Failed at: ${stageLabel(job.error.stage)}.` : ''}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {job.canResume && onResume && <Button disabled={resuming} onClick={onResume} type="button"><Icon name="refresh" size={15} />{resuming ? 'Resuming…' : 'Resume'}</Button>}
      {onStartOver && <Button disabled={resuming} onClick={onStartOver} type="button" variant="secondary">{startOverLabel}</Button>}
      {onDismiss && <Button disabled={resuming} onClick={onDismiss} type="button" variant="quiet">Dismiss</Button>}
    </div>
  </Alert>;
}

// Compact progress for kit changes (gap questions, section regeneration).
export function InlineJobProgress({ job, label, pollError }) {
  return <div className="mb-5 space-y-3">
    <div className="flex items-center gap-3 rounded-xl border border-line bg-white px-4 py-3 text-sm">
      <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-brand-100 border-t-brand-600" />
      <span className="font-medium text-ink">{label}</span>
      <span className="text-muted">{job?.status === 'queued' ? 'Waiting for a free slot…' : `${stepText(job)} · ${stageLabel(job?.stage)}`}</span>
    </div>
    <RetryNotice job={job} />
    {pollError && <p className="text-xs text-muted">{pollError}</p>}
  </div>;
}
