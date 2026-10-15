'use client';

import { useEffect, useMemo, useState } from 'react';
import { stageLabel } from '@/lib/jobs';

// "Flight path" for a kit generation job: a dashed route with one checkpoint
// per pipeline stage and a paper plane flying to the current stage. Everything
// is driven by the polled job (status, stageIndex, stageCount); the only timer
// rotates the interview tips. The route is decorative (aria-hidden); the stage
// label below it is the live region. Motion lives in the flight-* classes in
// globals.css (transforms and opacity only), paused while the tab is hidden and
// switched off for prefers-reduced-motion.

const TIP_INTERVAL_MS = 6_000;
const DEFAULT_STAGE_COUNT = 9;
const MOBILE_MAX_DOTS = 5;

export const INTERVIEW_TIPS = [
  'Structure behavioral answers with STAR: situation, task, action, result.',
  'Quantify impact. “Cut load time by 40%” lands better than “made it faster”.',
  'Prepare one question about the team’s roadmap for the next six months.',
  'Say your assumptions out loud before you start a technical answer.',
  'Keep a two-minute story ready about a project you are proud of.',
  'If you don’t know an answer, explain how you would find out.',
  'Match each line of the job description to a story you can tell.',
  'Ask what success looks like in the first 90 days.',
  'Practice answers out loud. Notes feel ready long before spoken answers do.',
  'Pick one failure story and focus on what you changed afterwards.',
  'Skim the company’s latest product updates before the call.',
  'Clarify the question before you start designing a solution.',
];

// True while the browser tab is hidden, so animations and the tip timer pause.
function usePageHidden() {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const update = () => setHidden(document.visibilityState === 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return hidden;
}

function useRotatingTip(paused) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (paused) return undefined;
    const timer = setInterval(() => setIndex((current) => (current + 1) % INTERVIEW_TIPS.length), TIP_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [paused]);
  return INTERVIEW_TIPS[index];
}

// On narrow screens only a few evenly spaced checkpoints are drawn (always the
// first, the last and the current one).
const mobileDots = (count, current) => {
  const step = Math.max(1, Math.ceil((count - 1) / (MOBILE_MAX_DOTS - 1)));
  const visible = new Set([0, count - 1, current]);
  for (let index = 0; index < count; index += step) visible.add(index);
  return visible;
};

// The flight state for a polled job.
export const flightState = (job) => {
  const count = Math.max(2, job?.stageCount || DEFAULT_STAGE_COUNT);
  const status = job?.status || 'queued';
  const succeeded = status === 'succeeded';
  const current = succeeded ? count - 1 : Math.min(count - 1, Math.max(0, (job?.stageIndex || 1) - 1));
  const label = status === 'queued'
    ? 'Waiting for a free generation slot…'
    : status === 'retrying'
      ? 'Provider busy — retrying automatically'
      : succeeded
        ? 'Your kit is ready'
        : `${stageLabel(job?.stage)}…`;
  return { count, current, status, succeeded, label };
};

function PaperPlane() {
  return <svg className="h-6 w-6 text-brand-600" fill="none" viewBox="0 0 24 24">
    <path d="M3.5 5.5 20.5 12 3.5 18.5 6.8 12 3.5 5.5Z" fill="rgb(var(--color-brand-50))" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.8" />
    <path d="M6.8 12h13.7" stroke="currentColor" strokeLinecap="round" strokeWidth="1.8" />
  </svg>;
}

function Checkpoint({ index, count, current, succeeded, visibleOnMobile }) {
  const passed = succeeded || index < current;
  const active = !succeeded && index === current;
  const finish = succeeded && index === count - 1;
  return <span className={`absolute top-0 ${visibleOnMobile || active ? '' : 'hidden sm:block'}`} style={{ left: `${(index / (count - 1)) * 100}%` }}>
    <span className="absolute left-0 top-0 block -translate-x-1/2 -translate-y-1/2">
      {active && <span className="flight-pulse absolute inset-0 rounded-full bg-brand-500/40" />}
      {finish
        ? <span className="flight-pop flex h-5 w-5 items-center justify-center rounded-full bg-brand-600 text-white"><svg className="h-3 w-3" fill="none" viewBox="0 0 12 12"><path d="m2.5 6.2 2.2 2.2 4.8-4.8" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" /></svg></span>
        : <span className={`relative block h-2.5 w-2.5 rounded-full border-2 ${passed || active ? 'border-brand-600 bg-brand-600' : 'border-line-strong bg-surface'}`} />}
    </span>
  </span>;
}

export function FlightPath({ job }) {
  const hidden = usePageHidden();
  const { count, current, status, succeeded, label } = flightState(job);
  const tip = useRotatingTip(hidden || succeeded);
  const visible = useMemo(() => mobileDots(count, current), [count, current]);
  const motion = status === 'retrying' ? 'flight-circle' : succeeded ? '' : 'flight-bob';
  return <div className="rounded-xl border border-line bg-subtle px-5 pb-5 pt-9 text-center">
    <div aria-hidden="true" className="relative mx-auto h-4 w-full max-w-md" data-paused={hidden ? 'true' : 'false'}>
      <div className="absolute inset-x-3 top-1/2">
        <div className="absolute inset-x-0 top-0 -translate-y-1/2 border-t-2 border-dashed border-line-strong" />
        {Array.from({ length: count }, (_, index) => <Checkpoint count={count} current={current} index={index} key={index} succeeded={succeeded} visibleOnMobile={visible.has(index)} />)}
        <div className="flight-glide absolute inset-x-0 top-0" style={{ transform: `translateX(${(current / (count - 1)) * 100}%)` }}>
          <span className="absolute left-0 top-0 block -translate-x-1/2 -translate-y-[calc(100%+0.45rem)]">
            <span className={`block ${motion}`}><PaperPlane /></span>
          </span>
        </div>
      </div>
    </div>
    <p aria-live="polite" className="mt-5 text-sm font-semibold text-ink" role="status">{label}</p>
    {!succeeded && <p className="flight-fade mx-auto mt-2 min-h-[2.5rem] max-w-sm text-xs leading-5 text-muted" key={tip}><span className="font-semibold text-brand-700">Tip: </span>{tip}</p>}
  </div>;
}
