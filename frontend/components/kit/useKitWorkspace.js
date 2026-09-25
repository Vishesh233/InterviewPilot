'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';

const messageFor = (error, fallback) => error instanceof ApiError ? error.message : fallback;

export function useKitWorkspace({ token, kitId }) {
  const [kit, setKit] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [section, setSection] = useState('brief');
  const [editingId, setEditingId] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [regenerating, setRegenerating] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    if (!token || !kitId) { setLoading(false); return; }
    setLoading(true); setError('');
    try { setKit(await api.getKit(token, kitId)); } catch (requestError) { setError(messageFor(requestError, 'We could not load this kit.')); } finally { setLoading(false); }
  }, [kitId, token]);

  useEffect(() => { load(); }, [load]);
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
    setRegenerating(category); setError('');
    try { const result = await api.regenerateSection(token, kitId, category); setKit(result.kit); setNotice(`${category} questions regenerated. Edited and pinned questions were preserved.`); }
    catch (requestError) { setError(messageFor(requestError, 'We could not regenerate this section.')); }
    finally { setRegenerating(''); }
  };

  return { kit, loading, error, section, setSection, editingId, setEditingId, savingId, regenerating, notice, editQuestion, pinQuestion, reorder, deleteQuestion, regenerate, reload: load };
}
