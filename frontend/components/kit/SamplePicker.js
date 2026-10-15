'use client';

import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/Primitives';
import { SAMPLE_JOBS } from '@/lib/sampleJobs';

// "Use a sample" for the new kit form: a labelled group of buttons. When the
// form already holds the user's own text, choosing a sample asks first (inline)
// instead of overwriting it.
export function SamplePicker({ pending, onChoose, onConfirm, onCancel }) {
  const confirmRef = useRef(null);
  useEffect(() => { if (pending) confirmRef.current?.focus(); }, [pending]);
  return <div aria-labelledby="sample-picker-label" className="mt-7 rounded-control border border-line bg-subtle p-4" role="group">
    <p className="text-sm font-semibold text-ink" id="sample-picker-label">Use a sample</p>
    <p className="mt-1 text-xs leading-5 text-muted">No job description at hand? Fill the form with an example to see how it works.</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {SAMPLE_JOBS.map((sample) => <button aria-label={`Use the ${sample.label} sample (${sample.host})`} className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs font-semibold text-ink transition hover:border-brand-500 hover:text-brand-700" key={sample.id} onClick={() => onChoose(sample)} type="button">{sample.label} <span className="font-normal text-muted">· {sample.host}</span></button>)}
    </div>
    {pending && <div className="mt-3 rounded-control border border-warning-200 bg-warning-50 p-3">
      <p className="text-xs leading-5 text-warning-700" id="sample-confirm-text">Replace the role, job description and company URL you entered with the {pending.label} sample?</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button aria-describedby="sample-confirm-text" className="button-primary min-h-9 px-4 text-xs" onClick={onConfirm} ref={confirmRef} type="button">Replace</button>
        <Button className="min-h-9 text-xs" onClick={onCancel} type="button" variant="quiet">Keep my text</Button>
      </div>
    </div>}
  </div>;
}
