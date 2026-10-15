'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button } from '@/components/ui/Primitives';
import { ProgressBar } from '@/components/ui/DataDisplay';
import { Icon } from '@/components/ui/Icon';
import { formatDate } from '@/lib/format';
import { companyNameOf } from '@/lib/companyBrief';

// The resume section is added only for kits created with a resume, so a JD-only
// kit keeps exactly the same six tabs as before.
const sectionIds = (kit) => {
  const base = [
    ['brief', 'Company brief'],
    ['requirements', 'Role & coverage'],
  ];
  if (kit?.resume?.provided === true) base.push(['resume', 'Resume match']);
  return [
    ...base,
    ['questions', 'Questions'],
    ['flashcards', 'Flashcards'],
    ['schedule', 'Schedule'],
    ['practice', 'Practice'],
  ];
};

// Section tabs scroll horizontally on narrow screens. When more tabs are
// hidden on a side, an arrow button appears on that side, next to (never on
// top of) the tabs; it scrolls the bar for mouse/touch users (keyboard users
// reach every tab with Tab), and the active tab is always scrolled into view.
function SectionTabs({ tabs, active, onSection }) {
  const navRef = useRef(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    setOverflow({ left: nav.scrollLeft > 1, right: nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1 });
  }, []);
  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [measure]);
  // Scrolls the active tab into view unless it already fits; true when it fits.
  const revealActive = useCallback(() => {
    const nav = navRef.current;
    const tab = nav?.querySelector('[aria-current="page"]');
    if (!nav || !tab) return true;
    const strip = nav.getBoundingClientRect();
    const box = tab.getBoundingClientRect();
    if (box.left >= strip.left - 1 && box.right <= strip.right + 1) return true;
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return false;
  }, []);
  // An arrow that appears narrows the strip and can clip the active tab again,
  // so after a tab change the tab is revealed until it fits. The user scrolling
  // the strip ends this, so it never pulls the strip back under them.
  const revealPending = useRef(false);
  const stopReveal = () => { revealPending.current = false; };
  useEffect(() => {
    revealPending.current = true;
    revealActive();
    measure();
  }, [active, measure, revealActive]);
  useEffect(() => {
    if (!revealPending.current) return;
    if (revealActive()) revealPending.current = false;
    else measure();
  }, [overflow.left, overflow.right, measure, revealActive]);
  const scrollBy = (direction) => { stopReveal(); navRef.current?.scrollBy({ left: direction * navRef.current.clientWidth * 0.6, behavior: 'smooth' }); };
  const cue = (side) => <div aria-hidden="true" className="flex shrink-0 items-center">
    <button className="flex h-7 w-7 items-center justify-center rounded-full border border-line-strong bg-surface text-ink shadow-raised" onClick={() => scrollBy(side === 'left' ? -1 : 1)} tabIndex={-1} type="button"><Icon className={side === 'left' ? 'rotate-180' : ''} name="chevron" size={15} /></button>
  </div>;
  return <div className="flex items-center gap-1">
    {overflow.left && cue('left')}
    <nav aria-label="Kit sections" className="flex min-w-0 flex-1 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" onPointerDown={stopReveal} onScroll={measure} onTouchStart={stopReveal} onWheel={stopReveal} ref={navRef}>{tabs.map(([id, label]) => <button aria-current={active === id ? 'page' : undefined} className={`whitespace-nowrap border-b-2 px-3 py-3.5 text-sm font-medium transition ${active === id ? 'border-brand-600 text-brand-700' : 'border-transparent text-muted hover:border-line-strong hover:text-ink'}`} key={id} onClick={() => onSection(id)} type="button">{label}</button>)}</nav>
    {overflow.right && cue('right')}
  </div>;
}

// "7 interview days · Created Oct 15, 2026"
const kitSubtitle = (kit) => {
  const days = kit?.schedule?.interviewDays || kit?.source?.interviewDays;
  const parts = [];
  if (days) parts.push(`${days} interview day${days === 1 ? '' : 's'}`);
  if (kit?.createdAt) parts.push(`Created ${formatDate(kit.createdAt)}`);
  return parts.join(' · ') || 'Your interview preparation kit';
};

export function KitHeader({ kit, active, onSection, onPractice, onInterview, onDelete, deleting = false }) {
  const coverage = Number(kit?.coverage?.coveragePercent) || 0;
  const tabs = sectionIds(kit);
  // The tab bar is a separate full-width bar so it can stay pinned to the top
  // of the viewport while the section below scrolls.
  return <><div className="border-b border-line bg-surface"><div className="container-shell py-7 sm:py-9"><div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end"><div><div className="flex flex-wrap items-center gap-2"><Badge tone="green">{kit?.company_brief?.name || 'Company workspace'}</Badge><Badge tone="gray">{kit?.role?.title || 'Interview role'}</Badge>{kit?.role?.level && <Badge tone="gray">{kit.role.level}</Badge>}{kit?.role?.yearsExperience && <Badge tone="gray">{kit.role.yearsExperience}</Badge>}</div><h1 className="mt-4 max-w-3xl font-display text-3xl tracking-tight text-ink sm:text-4xl">{kit?.role?.title || 'Interview'} at {companyNameOf(kit)}</h1><p className="mt-2 text-sm text-muted">{kitSubtitle(kit)}</p></div><div className="flex flex-wrap items-center gap-4"><div className="min-w-[150px]"><div className="mb-2 flex items-center justify-between text-xs"><span className="font-medium text-muted">Coverage</span><span className="font-semibold text-brand-700">{coverage}%</span></div><ProgressBar label="Requirement coverage" value={coverage} /></div><Button onClick={onPractice} variant="secondary"><Icon name="book" size={16} />Practice</Button>{onInterview && <Button onClick={onInterview} variant="secondary"><Icon name="chat" size={16} />Mock interview</Button>}{onDelete && <Button disabled={deleting} onClick={onDelete} type="button" variant="quiet"><Icon name="trash" size={15} />{deleting ? 'Deleting…' : 'Delete kit'}</Button>}</div></div></div></div><div className="sticky top-[var(--sticky-offset,0px)] z-30 border-b border-line bg-surface/95 backdrop-blur"><div className="container-shell"><SectionTabs active={active} onSection={onSection} tabs={tabs} /></div></div></>;
}
