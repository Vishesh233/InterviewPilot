import Link from 'next/link';
import { Wordmark } from '@/components/brand/Logo';

// Shared frame for the 404 and error pages: brand, a short message and the
// ways back. Deliberately without the app header (it needs a signed-in user).
export function StatusPage({ code, title, children, actions }) {
  return <main className="flex min-h-screen flex-col bg-canvas">
    <header className="container-shell flex min-h-[72px] items-center">
      <Link aria-label="InterviewPilot home" className="rounded-control" href="/"><Wordmark /></Link>
    </header>
    <section className="container-shell flex flex-1 items-center justify-center py-12">
      <div className="card w-full max-w-lg px-6 py-10 text-center sm:px-10">
        <p className="eyebrow">{code}</p>
        <h1 className="mt-3 font-display text-3xl tracking-tight text-ink sm:text-4xl">{title}</h1>
        <div className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted">{children}</div>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">{actions}</div>
      </div>
    </section>
  </main>;
}
