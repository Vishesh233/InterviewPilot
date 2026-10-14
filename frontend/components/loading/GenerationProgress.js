'use client';

import { Icon } from '@/components/ui/Icon';
import { RetryNotice, stepText } from '@/components/jobs/JobStatus';
import { stageLabel } from '@/lib/jobs';

// Live progress of a background kit job: the real stage the server reports,
// "step X of Y", and the automatic-retry state.
export function GenerationProgress({ job, pollError }) {
  const stageCount = job?.stageCount || 0;
  const stageIndex = Math.min(stageCount, Math.max(0, job?.stageIndex || 0));
  const percent = stageCount ? Math.round((Math.max(0, stageIndex - 1) / stageCount) * 100) : 0;
  const queued = !job || job.status === 'queued';
  return <div className="card overflow-hidden">
    <div className="border-b border-line bg-subtle px-6 py-5 sm:px-8">
      <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Icon name="spark" size={18} /></span><div><p className="eyebrow">Building your kit</p><h2 className="mt-1 text-lg font-semibold text-ink">A thoughtful brief takes a few minutes.</h2></div></div>
      <p className="mt-4 max-w-xl text-sm leading-6 text-muted">You can leave this page open or come back to it later: the generation keeps running on the server and this page picks it up again.</p>
    </div>
    <div className="space-y-5 px-6 py-6 sm:px-8">
      <div className="flex items-center gap-4">
        <span className="h-5 w-5 shrink-0 animate-spin rounded-full border-2 border-brand-100 border-t-brand-600" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{queued ? 'Waiting for a free generation slot…' : stageLabel(job.stage)}</p>
          <p className="mt-1 text-xs text-muted">{queued ? 'Your request is queued.' : stepText(job)}</p>
        </div>
      </div>
      <div aria-label="Generation progress" aria-valuemax={100} aria-valuemin={0} aria-valuenow={percent} className="h-2 overflow-hidden rounded-full bg-sunken" role="progressbar">
        <div className="h-full rounded-full bg-brand-600 transition-all duration-500" style={{ width: `${percent}%` }} />
      </div>
      <RetryNotice job={job} />
      {pollError && <p className="text-xs text-muted">{pollError}</p>}
    </div>
  </div>;
}
