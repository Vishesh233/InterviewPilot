'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button } from '@/components/ui/Primitives';
import { ProgressBar } from '@/components/ui/DataDisplay';
import { Icon } from '@/components/ui/Icon';

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

// Section tabs scroll horizontally on narrow screens. Edge fades show when
// more tabs are hidden on that side, and the active tab is scrolled into view.
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
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    measure();
  }, [active, measure]);
  return <div className="relative mt-8">
    <nav aria-label="Kit sections" className="flex gap-1 overflow-x-auto pb-px" onScroll={measure} ref={navRef}>{tabs.map(([id, label]) => <button aria-current={active === id ? 'page' : undefined} className={`whitespace-nowrap border-b-2 px-3 py-3 text-sm font-medium transition ${active === id ? 'border-brand-600 text-brand-700' : 'border-transparent text-muted hover:border-line hover:text-ink'}`} key={id} onClick={() => onSection(id)} type="button">{label}</button>)}</nav>
    {overflow.left && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 flex w-10 items-center bg-gradient-to-r from-white to-transparent text-muted"><Icon className="rotate-180" name="arrow" size={14} /></span>}
    {overflow.right && <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 flex w-10 items-center justify-end bg-gradient-to-l from-white to-transparent text-muted"><Icon name="arrow" size={14} /></span>}
  </div>;
}

export function KitHeader({ kit, active, onSection, onPractice, onDelete, deleting = false }) {
  const coverage = Number(kit?.coverage?.coveragePercent) || 0;
  const tabs = sectionIds(kit);
  return <div className="border-b border-line bg-white"><div className="container-shell pt-7 sm:pt-9"><div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-end"><div><div className="flex flex-wrap items-center gap-2"><Badge tone="green">{kit?.company_brief?.name || 'Company workspace'}</Badge><Badge tone="gray">{kit?.role?.title || 'Interview role'}</Badge>{kit?.role?.level && <Badge tone="gray">{kit.role.level}</Badge>}{kit?.role?.yearsExperience && <Badge tone="gray">{kit.role.yearsExperience}</Badge>}</div><h1 className="mt-4 max-w-3xl font-display text-3xl tracking-tight text-ink sm:text-4xl">Your interview preparation kit</h1><p className="mt-2 text-sm text-muted">Built from the role, the company brief, and your preparation days.</p></div><div className="flex flex-wrap items-center gap-4"><div className="min-w-[150px]"><div className="mb-2 flex items-center justify-between text-xs"><span className="font-medium text-muted">Coverage</span><span className="font-semibold text-brand-700">{coverage}%</span></div><ProgressBar value={coverage} /></div><Button onClick={onPractice} variant="secondary"><Icon name="book" size={16} />Practice</Button>{onDelete && <Button disabled={deleting} onClick={onDelete} type="button" variant="quiet"><Icon name="trash" size={15} />{deleting ? 'Deleting…' : 'Delete kit'}</Button>}</div></div><SectionTabs active={active} onSection={onSection} tabs={tabs} /></div></div>;
}
