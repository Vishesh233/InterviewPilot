'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { isActiveJob } from '@/lib/jobs';
import { useJobPolling } from '@/components/jobs/useJobPolling';

const messageFor = (error, fallback) => error instanceof ApiError ? error.message : fallback;

export function useKitWorkspace({ token, kitId }) {
  const [kit, setKit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [section, setSection] = useState('brief');
  const [editingId, setEditingId] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [notice, setNotice] = useState('');
  // The background job for a kit change: { kind: 'gaps' | 'regenerate', category, jobId }.
  const [kitJob, setKitJob] = useState(null);
  const [jobEpoch, setJobEpoch] = useState(0);
  const [resumingJob, setResumingJob] = useState(false);
  const kitJobRef = useRef(kitJob);
  kitJobRef.current = kitJob;

  const load = useCallback(async () => {
    if (!token || !kitId) { setLoading(false); return; }
    setLoading(true); setError('');
    try { setKit(await api.getKit(token, kitId)); } catch (requestError) { setError(messageFor(requestError, 'We could not load this kit.')); } finally { setLoading(false); }
  }, [kitId, token]);

  useEffect(() => { load(); }, [load]);

  // Reload the kit in place (no full-page loading state) after a job saved changes.
  const refresh = useCallback(async () => {
    try { setKit(await api.getKit(token, kitId)); } catch (requestError) { setError(messageFor(requestError, 'We could not reload this kit.')); }
  }, [kitId, token]);

  const onJobFinished = useCallback(async (finished) => {
    if (finished.status !== 'succeeded') return; // a failure stays visible with Resume / Try again
    const current = kitJobRef.current;
    setKitJob(null);
    await refresh();
    if (current?.kind === 'gaps') {
      const added = Array.isArray(finished.summary?.addedQuestionIds) ? finished.summary.addedQuestionIds.length : 0;
      const remaining = Array.isArray(finished.summary?.remainingGaps) ? finished.summary.remainingGaps.length : 0;
      setNotice(added === 0
        ? 'No new questions were added for the remaining gaps.'
        : `${added} question${added === 1 ? '' : 's'} added${remaining > 0 ? `, ${remaining} gap${remaining === 1 ? '' : 's'} still uncovered` : ''}.`);
    } else if (current?.kind === 'regenerate') {
      setNotice(`${current.category} questions regenerated. Edited and pinned questions were preserved.`);
    }
  }, [refresh]);
  const { job: kitJobState, pollError: kitJobPollError } = useJobPolling({ token, jobId: kitJob?.jobId, epoch: jobEpoch, onFinished: onJobFinished });
  const kitJobActive = Boolean(kitJob) && (!kitJobState || isActiveJob(kitJobState));

  const watchKitJob = (next) => { setKitJob(next); setJobEpoch((current) => current + 1); };

  // Starts a kit-change job. On 409 JOB_ALREADY_RUNNING the existing job is
  // followed instead of showing an error.
  const startKitJob = async (kind, category) => {
    setError('');
    try {
      const { jobId } = kind === 'gaps'
        ? await api.generateGapQuestions(token, kitId)
        : await api.regenerateSection(token, kitId, category);
      watchKitJob({ kind, category, jobId });
    } catch (requestError) {
      if (requestError instanceof ApiError && requestError.code === 'JOB_ALREADY_RUNNING' && requestError.jobId) {
        watchKitJob({ kind, category, jobId: requestError.jobId });
        return;
      }
      setError(messageFor(requestError, kind === 'gaps' ? 'We could not generate questions for the gaps.' : 'We could not regenerate this section.'));
    }
  };

  const resumeKitJob = async () => {
    if (!kitJob) return;
    setError(''); setResumingJob(true);
    try { await api.resumeJob(token, kitJob.jobId); setJobEpoch((current) => current + 1); }
    catch (requestError) {
      if (requestError instanceof ApiError && requestError.code === 'JOB_ALREADY_RUNNING' && requestError.jobId) { watchKitJob({ ...kitJob, jobId: requestError.jobId }); return; }
      setError(messageFor(requestError, 'We could not resume this generation.'));
    } finally { setResumingJob(false); }
  };
  const retryKitJob = () => { if (kitJob) startKitJob(kitJob.kind, kitJob.category); };
  const dismissKitJob = () => setKitJob(null);
  useEffect(() => { if (!notice) return undefined; const timer = setTimeout(() => setNotice(''), 4000); return () => clearTimeout(timer); }, [notice]);

  const questions = useMemo(() => kit?.questions || [], [kit]);
  const editQuestion = async (questionId, changes) => {
    setSavingId(questionId); setError('');
    try { setKit(await api.editQuestion(token, kitId, questionId, changes)); setEditingId(null); setNotice('Question saved.'); }
    catch (requestError) { setError(messageFor(requestError, 'We could not save that question.')); }
    finally { setSavingId(null); }
  };
  const pinQuestion = async (question) => {
    setSavingId(question.id); setError('');
    try { setKit(await api.pinQuestion(token, kitId, question.id, !question.pinned)); setNotice(question.pinned ? 'Question unpinned.' : 'Question pinned.'); }
    catch (requestError) { setError(messageFor(requestError, 'We could not update the pin.')); }
    finally { setSavingId(null); }
  };
  const reorder = async (index, direction) => {
    const target = index + direction;
    if (target < 0 || target >= questions.length) return;
    const previous = kit;
    const ids = questions.map((question) => question.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setKit({ ...kit, questions: ids.map((id) => questions.find((question) => question.id === id)) });
    try { setKit(await api.reorderQuestions(token, kitId, ids)); setNotice('Question order saved.'); }
    catch (requestError) { setKit(previous); setError(messageFor(requestError, 'We could not save the new order.')); }
  };
  const deleteQuestion = async (question) => {
    if (!window.confirm(`Delete question ${question.id}? This cannot be undone.`)) return;
    const nextQuestions = questions.filter((item) => item.id !== question.id);
    const dayIds = (day) => day.question_ids || day.questionIds || day.questions || [];
    const nextKit = {
      ...kit,
      questions: nextQuestions,
      schedule: { ...kit.schedule, days: (kit.schedule?.days || []).map((day) => ({ ...day, question_ids: dayIds(day).filter((id) => id !== question.id) })) },
      flashcards: (kit.flashcards || []).map((card) => ({ ...card, questionIds: (card.questionIds || []).filter((id) => id !== question.id) })),
    };
    const requirements = (kit.role?.requirements || []).map((entry) => typeof entry === 'string' ? entry : entry.id);
    const covered = requirements.filter((id) => nextQuestions.some((item) => (item.requirementRefs || []).includes(id)));
    nextKit.coverage = { ...kit.coverage, coveredRequirements: covered, missingRequirements: requirements.filter((id) => !covered.includes(id)), coveragePercent: requirements.length ? Math.round((covered.length / requirements.length) * 100) : 100 };
    setSavingId(question.id); setError('');
    try { setKit(await api.updateKit(token, kitId, nextKit)); setNotice('Question deleted.'); }
    catch (requestError) { setError(messageFor(requestError, 'We could not delete that question.')); }
    finally { setSavingId(null); }
  };
  const regenerate = async (category) => {
    if (!window.confirm(`Regenerate ${category} questions? Edited and pinned questions will be preserved.`)) return;
    await startKitJob('regenerate', category);
  };
  const regenerating = kitJobActive && kitJob.kind === 'regenerate' ? kitJob.category : '';
  const generatingGaps = kitJobActive && kitJob.kind === 'gaps';
  // The backend owns the gap list: coverage.missingRequirements is the only source
  // of truth, so the button only appears when there is a real gap to fill.
  const gaps = kit?.coverage?.missingRequirements;
  const gapCount = Array.isArray(gaps) ? gaps.length : 0;
  const generateGaps = async () => {
    if (gapCount === 0) return;
    if (!window.confirm(`Generate questions for ${gapCount} uncovered requirement${gapCount === 1 ? '' : 's'}? Existing questions are kept.`)) return;
    await startKitJob('gaps');
  };

  return { kit, loading, error, section, setSection, editingId, setEditingId, savingId, regenerating, generatingGaps, gapCount, notice, editQuestion, pinQuestion, reorder, deleteQuestion, regenerate, generateGaps, reload: load, kitJob, kitJobState, kitJobActive, kitJobPollError, resumingJob, resumeKitJob, retryKitJob, dismissKitJob };
}
