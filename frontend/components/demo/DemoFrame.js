'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { Wordmark } from '@/components/brand/Logo';
import { LinkButton } from '@/components/ui/Primitives';

// Slim sticky banner on every demo page. Its height is published as
// --sticky-offset so the kit's sticky tab bar sits right below it.
function DemoBanner() {
  const ref = useRef(null);
  useEffect(() => {
    const banner = ref.current;
    if (!banner) return undefined;
    const root = document.documentElement;
    const publish = () => root.style.setProperty('--sticky-offset', `${banner.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(banner);
    return () => { observer.disconnect(); root.style.removeProperty('--sticky-offset'); };
  }, []);
  return <div className="sticky top-0 z-40 border-b border-brand-200 bg-brand-50" ref={ref}>
    <div className="container-shell flex flex-col gap-2 py-2.5 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs leading-5 text-brand-800 sm:text-sm">You’re viewing a demo kit. Create a free account to build one from your own job description.</p>
      <div className="flex shrink-0 items-center gap-3">
        <LinkButton className="min-h-9 px-4 text-xs sm:text-sm" href="/register" variant="primary">Create your kit</LinkButton>
        <Link className="text-xs font-semibold text-brand-700 underline-offset-4 hover:underline sm:text-sm" href="/login">Sign in</Link>
      </div>
    </div>
  </div>;
}

// Public frame for /demo: no auth, no API calls.
export function DemoFrame({ children, className = '' }) {
  return <div className="min-h-screen bg-canvas">
    <header className="border-b border-line bg-surface/90 backdrop-blur">
      <div className="container-shell flex min-h-[64px] items-center justify-between gap-4">
        <Link aria-label="InterviewPilot home" className="rounded-control" href="/"><Wordmark /></Link>
        <nav aria-label="Demo" className="flex items-center gap-1">
          <LinkButton href="/demo" variant="quiet">Demo kits</LinkButton>
        </nav>
      </div>
    </header>
    <DemoBanner />
    <main className={`container-shell py-8 sm:py-10 ${className}`}>{children}</main>
  </div>;
}
