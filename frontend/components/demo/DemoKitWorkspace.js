'use client';

import { useMemo, useState } from 'react';
import { KitHeader } from '@/components/kit/KitHeader';
import CompanyBriefPanel from '@/components/kit/CompanyBriefPanel';
import RolePanel from '@/components/kit/RolePanel';
import RequirementsPanel from '@/components/coverage/RequirementsPanel';
import QuestionsPanel from '@/components/questions/QuestionsPanel';
import FlashcardsPanel from '@/components/flashcards/FlashcardsPanel';
import SchedulePanel from '@/components/schedule/SchedulePanel';
import PracticeMode from '@/components/practice/PracticeMode';
import { Icon } from '@/components/ui/Icon';
import { createMemoryPracticeSource } from '@/lib/practice';

// The kit workspace for a static demo kit: the same panels, read-only (no
// edit, pin, reorder, delete, regenerate or gap filling), and practice kept in
// memory for this page view only. Answer practice shows a sign-up invitation
// instead of calling the API.
export function DemoKitWorkspace({ kit }) {
  const [section, setSection] = useState('brief');
  // One store per page view: ratings survive tab switches, a reload resets them.
  const practice = useMemo(() => createMemoryPracticeSource(kit.flashcards || []), [kit]);
  const answers = { demo: true };
  return <>
    <KitHeader active={section} kit={kit} onPractice={() => setSection('practice')} onSection={setSection} />
    <p className="mt-5 flex items-center gap-2 text-xs text-muted"><Icon className="shrink-0 text-brand-600" name="spark" size={14} />This demo kit is read-only. You can practice with it, but ratings are not saved.</p>
    <div className="py-6">
      {section === 'brief' && <CompanyBriefPanel kit={kit} />}
      {section === 'requirements' && <div className="grid gap-6 xl:grid-cols-[.8fr_1.2fr]"><RolePanel kit={kit} /><RequirementsPanel kit={kit} /></div>}
      {section === 'questions' && <QuestionsPanel answers={answers} kit={kit} readOnly />}
      {section === 'flashcards' && <FlashcardsPanel kit={kit} note="Practice Mode starts with the cards you know least." onPractice={() => setSection('practice')} />}
      {section === 'schedule' && <SchedulePanel kit={kit} />}
      {section === 'practice' && <PracticeMode answers={answers} kit={kit} onBack={() => setSection('flashcards')} saveNote="Demo: ratings reset when you reload the page." source={practice} />}
    </div>
  </>;
}
