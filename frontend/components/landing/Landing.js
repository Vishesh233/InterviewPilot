import Link from 'next/link';
import { Wordmark } from '@/components/brand/Logo';
import { LinkButton } from '@/components/ui/Primitives';
import { Icon } from '@/components/ui/Icon';

// Public landing page for signed-out visitors. Everything here describes what
// the app actually does: no testimonials, user counts or invented metrics.

const STEPS = [
  { icon: 'clipboard', title: 'Paste the job description', body: 'Add the role, the job description and the company’s website, plus your resume if you want.' },
  { icon: 'spark', title: 'Get a tailored kit', body: 'The requirements are extracted, the company’s public pages are researched, and questions are written for both.' },
  { icon: 'book', title: 'Practice until the interview', body: 'Work through the questions, flashcards and a day-by-day plan, and track what still needs practice.' },
];

const FEATURES = [
  { icon: 'search', title: 'Grounded questions', body: 'Technical, behavioral, role and company questions, each linked to the requirements it covers, with an answer outline and follow-ups.' },
  { icon: 'target', title: 'Requirement coverage map', body: 'Every requirement from the job description, and which question covers it. Gaps stay visible, and one click fills them.' },
  { icon: 'calendar', title: 'Day-by-day schedule', body: 'Your questions spread over the days you have before the interview, from 1 to 60.' },
  { icon: 'layers', title: 'Flashcards', body: 'A recall deck built from your questions that stays in sync when you edit them.' },
  { icon: 'chart', title: 'Practice mode', body: 'Rate your confidence card by card; the next session starts with what you know least.' },
  { icon: 'file', title: 'Resume match (optional)', body: 'Attach a resume to see which requirements it backs up, with quoted evidence, and get questions about your own projects.' },
];

function ExampleKit() {
  const requirements = [['React', true], ['TypeScript', true], ['WCAG', true], ['Core Web Vitals', false]];
  return <figure aria-label="Example of a generated kit" className="card overflow-hidden p-5 sm:p-6">
    <figcaption className="mb-3 inline-block rounded-full bg-sunken px-2.5 py-1 text-[11px] font-semibold text-muted">Example kit</figcaption>
    <p className="eyebrow">Frontend Developer · mid · 3+ years</p>
    <p className="mt-2 font-display text-2xl tracking-tight text-ink">Role &amp; coverage</p>
    <div className="mt-4 flex items-center justify-between text-xs"><span className="font-medium text-muted">Coverage</span><span className="font-semibold text-brand-700">75%</span></div>
    <div aria-hidden="true" className="mt-2 h-2 overflow-hidden rounded-full bg-sunken"><div className="h-full w-3/4 rounded-full bg-brand-500" /></div>
    <ul className="mt-5 space-y-2.5">
      {requirements.map(([name, covered]) => <li className="flex items-center justify-between gap-3 rounded-control border border-line bg-subtle px-3 py-2.5 text-sm" key={name}>
        <span className="flex items-center gap-2 font-medium text-ink"><span className={`flex h-5 w-5 items-center justify-center rounded-full ${covered ? 'bg-brand-50 text-brand-700' : 'bg-warning-50 text-warning-700'}`}><Icon name={covered ? 'check' : 'warning'} size={12} /></span>{name}</span>
        <span className={`text-xs font-semibold ${covered ? 'text-brand-700' : 'text-warning-700'}`}>{covered ? 'Covered' : 'Gap'}</span>
      </li>)}
    </ul>
    <div className="mt-5 rounded-control border border-line p-4">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Question · technical</p>
      <p className="mt-2 text-sm font-semibold leading-6 text-ink">How would you meet WCAG 2.1 AA in a component library without slowing the team down?</p>
    </div>
  </figure>;
}

export function Landing() {
  return <div className="min-h-screen bg-canvas">
    <header className="border-b border-line bg-surface/90 backdrop-blur">
      <div className="container-shell flex min-h-[72px] items-center justify-between gap-4">
        <Link aria-label="InterviewPilot home" className="rounded-control" href="/"><Wordmark /></Link>
        <nav aria-label="Account" className="flex items-center gap-1 sm:gap-2">
          <LinkButton href="/demo" variant="quiet">Try the demo</LinkButton>
          <LinkButton href="/login" variant="quiet">Sign in</LinkButton>
          <LinkButton className="hidden sm:inline-flex" href="/register" variant="primary">Create an account</LinkButton>
        </nav>
      </div>
    </header>

    <main>
      <section className="container-shell grid items-center gap-12 py-14 sm:py-20 lg:grid-cols-[1.1fr_0.9fr] lg:py-24">
        <div>
          <p className="eyebrow">Interview preparation</p>
          <h1 className="mt-4 max-w-2xl font-display text-4xl leading-[1.05] tracking-tight text-ink sm:text-5xl lg:text-6xl">Turn any job description into a focused interview plan.</h1>
          <p className="mt-6 max-w-xl text-base leading-7 text-muted sm:text-lg sm:leading-8">InterviewPilot reads the job description and the company’s public website, then builds your prep kit: the requirements that matter, questions grounded in them, and a plan up to interview day.</p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <LinkButton href="/register" variant="primary">Create your first kit<Icon name="arrow" size={16} /></LinkButton>
            <LinkButton href="/demo">Try the demo</LinkButton>
            <LinkButton href="/login" variant="quiet">I already have an account</LinkButton>
          </div>
        </div>
        <ExampleKit />
      </section>

      <section aria-labelledby="how-it-works" className="border-y border-line bg-surface">
        <div className="container-shell py-14 sm:py-20">
          <p className="eyebrow">How it works</p>
          <h2 className="mt-3 font-display text-3xl tracking-tight text-ink sm:text-4xl" id="how-it-works">Three steps from posting to practice.</h2>
          <ol className="mt-10 grid gap-5 md:grid-cols-3">
            {STEPS.map((step, index) => <li className="rounded-card border border-line bg-subtle p-6" key={step.title}>
              <div className="flex items-center gap-3"><span className="flex h-10 w-10 items-center justify-center rounded-control bg-brand-600 text-white"><Icon name={step.icon} size={18} /></span><span className="text-sm font-semibold text-brand-700">Step {index + 1}</span></div>
              <h3 className="mt-5 text-lg font-semibold text-ink">{step.title}</h3>
              <p className="mt-2 text-sm leading-6 text-muted">{step.body}</p>
            </li>)}
          </ol>
        </div>
      </section>

      <section aria-labelledby="features" className="container-shell py-14 sm:py-20">
        <p className="eyebrow">What’s in a kit</p>
        <h2 className="mt-3 max-w-2xl font-display text-3xl tracking-tight text-ink sm:text-4xl" id="features">Everything you need to walk in prepared.</h2>
        <ul className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => <li className="card p-6" key={feature.title}>
            <span className="flex h-10 w-10 items-center justify-center rounded-control bg-brand-50 text-brand-700"><Icon name={feature.icon} size={18} /></span>
            <h3 className="mt-5 text-base font-semibold text-ink">{feature.title}</h3>
            <p className="mt-2 text-sm leading-6 text-muted">{feature.body}</p>
          </li>)}
        </ul>
      </section>

      <section className="container-shell pb-16 sm:pb-24">
        <div className="flex flex-col items-start justify-between gap-6 rounded-card bg-brand-700 px-6 py-10 text-white sm:px-10 md:flex-row md:items-center">
          <div>
            <h2 className="font-display text-3xl tracking-tight">Have an interview coming up?</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-brand-100">Paste the job description and get a kit you can start practicing with today.</p>
          </div>
          <Link className="inline-flex min-h-11 items-center justify-center gap-2 rounded-control bg-surface px-5 text-sm font-semibold text-brand-700 transition hover:bg-brand-50" href="/register">Create your first kit<Icon name="arrow" size={16} /></Link>
        </div>
      </section>
    </main>

    <footer className="border-t border-line">
      <div className="container-shell flex flex-col gap-3 py-8 text-sm text-muted sm:flex-row sm:items-center sm:justify-between">
        <Wordmark size={22} />
        <p>A personal project. <a className="font-medium text-brand-700 underline-offset-4 hover:underline" href="https://github.com/Vishesh233/InterviewPilot">Source on GitHub</a></p>
      </div>
    </footer>
  </div>;
}
