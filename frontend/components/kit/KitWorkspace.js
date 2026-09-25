'use client';

import { useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { PageFrame } from '@/components/layout/AppHeader';
import { KitHeader } from '@/components/kit/KitHeader';
import CompanyBriefPanel from '@/components/kit/CompanyBriefPanel';
import RolePanel from '@/components/kit/RolePanel';
import RequirementsPanel from '@/components/coverage/RequirementsPanel';
import QuestionsPanel from '@/components/questions/QuestionsPanel';
import FlashcardsPanel from '@/components/flashcards/FlashcardsPanel';
import SchedulePanel from '@/components/schedule/SchedulePanel';
import PracticeMode from '@/components/practice/PracticeMode';
import { useKitWorkspace } from '@/components/kit/useKitWorkspace';
import { useAuth } from '@/components/auth/AuthProvider';
import { Alert, Button, LoadingState } from '@/components/ui/Primitives';
import { Icon } from '@/components/ui/Icon';

export default function KitWorkspace() {
  const router = useRouter();
  const { id } = useParams();
  const { token, loading: authLoading } = useAuth();
  const workspace = useKitWorkspace({ token, kitId: id });
  useEffect(() => { if (!authLoading && !token) router.replace('/login'); }, [authLoading, router, token]);
  if (authLoading || !token || workspace.loading) return <PageFrame><LoadingState detail="Loading the questions, coverage, schedule, and practice deck." label="Opening your kit" /></PageFrame>;
  if (workspace.error && !workspace.kit) return <PageFrame><Alert title="Kit unavailable">{workspace.error}</Alert><Button className="mt-5" onClick={() => router.push('/dashboard')} variant="secondary">Back to dashboard</Button></PageFrame>;
  if (!workspace.kit) return null;
  const { kit } = workspace;
  return <PageFrame className="max-w-none"><KitHeader active={workspace.section} kit={kit} onPractice={() => router.push(`/kits/${encodeURIComponent(id)}/practice`)} onSection={workspace.setSection} />{workspace.error && <Alert className="mt-5" title="Something needs attention">{workspace.error}</Alert>}{workspace.notice && <Alert className="mt-5" tone="success">{workspace.notice}</Alert>}<div className="py-7">{workspace.section === 'brief' && <CompanyBriefPanel kit={kit} />}{workspace.section === 'requirements' && <div className="grid gap-6 xl:grid-cols-[.8fr_1.2fr]"><RolePanel kit={kit} /><RequirementsPanel kit={kit} /></div>}{workspace.section === 'questions' && <><div className="mb-5 flex flex-wrap justify-end gap-2">{['technical', 'behavioral', 'company', 'role_specific'].map((category) => <Button disabled={Boolean(workspace.regenerating)} key={category} onClick={() => workspace.regenerate(category)} variant="secondary"><Icon name="refresh" size={15} />{workspace.regenerating === category ? 'Regenerating…' : `Regenerate ${category.replace('_', ' ')}`}</Button>)}</div><QuestionsPanel editingId={workspace.editingId} kit={kit} onCancelEdit={() => workspace.setEditingId(null)} onDelete={workspace.deleteQuestion} onEdit={workspace.setEditingId} onPin={workspace.pinQuestion} onReorder={workspace.reorder} onSave={workspace.editQuestion} savingId={workspace.savingId} /></>}{workspace.section === 'flashcards' && <FlashcardsPanel kit={kit} onPractice={() => router.push(`/kits/${encodeURIComponent(id)}/practice`)} />}{workspace.section === 'schedule' && <SchedulePanel kit={kit} />}{workspace.section === 'practice' && <PracticeMode kitId={id} onBack={() => workspace.setSection('flashcards')} token={token} />}</div></PageFrame>;
}
