'use client';

import { Icon } from '@/components/ui/Icon';

export const generationStages = [
  'Reading job requirements',
  'Researching the company',
  'Generating interview questions',
  'Checking requirement coverage',
  'Building the preparation schedule',
];

export function GenerationProgress({ stage }) {
  return <div className="card overflow-hidden">
    <div className="border-b border-line bg-[#fbfcfa] px-6 py-5 sm:px-8">
      <div className="flex items-center gap-3"><span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-50 text-brand-600"><Icon name="spark" size={18} /></span><div><p className="eyebrow">Building your kit</p><h2 className="mt-1 text-lg font-semibold text-ink">A thoughtful brief takes a moment.</h2></div></div>
      <p className="mt-4 max-w-xl text-sm leading-6 text-muted">The backend is working through the same synchronous pipeline used by the web app. These are indicative milestones while the request is in flight, not live streamed events.</p>
    </div>
    <ol className="divide-y divide-line px-6 sm:px-8">
      {generationStages.map((label, index) => {
        const number = index + 1;
        const active = number === stage;
        const complete = number < stage;
        return <li className="flex items-center gap-4 py-4" key={label}>
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${complete ? 'bg-brand-600 text-white' : active ? 'border-2 border-brand-500 bg-brand-50 text-brand-700' : 'bg-[#f1f3f0] text-muted'}`}>{complete ? <Icon name="check" size={14} /> : number}</span>
          <span className={`text-sm ${active ? 'font-semibold text-ink' : complete ? 'text-brand-700' : 'text-muted'}`}>{label}</span>
          {active && <span className="ml-auto h-4 w-4 animate-spin rounded-full border-2 border-brand-100 border-t-brand-600" />}
        </li>;
      })}
    </ol>
  </div>;
}
