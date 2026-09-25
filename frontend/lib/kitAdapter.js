const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;

export function kitFromPipeline(input, result) {
  const requirements = result?.requirements || {};
  const research = result?.research || {};
  const questions = Array.isArray(result?.questions) ? result.questions : [];
  const roleTitle = nonEmpty(requirements.role) ? requirements.role.trim() : 'Role not specified';
  const requirementEntries = [
    ...(Array.isArray(requirements.mustHaveSkills) ? requirements.mustHaveSkills.map((id) => ({ id, kind: 'must_have' })) : []),
    ...(Array.isArray(requirements.niceToHaveSkills) ? requirements.niceToHaveSkills.map((id) => ({ id, kind: 'nice_to_have' })) : []),
    ...(Array.isArray(requirements.responsibilities) ? requirements.responsibilities.map((id) => ({ id, kind: 'responsibility' })) : []),
    ...(Array.isArray(requirements.qualifications) ? requirements.qualifications.map((id) => ({ id, kind: 'qualification' })) : []),
    ...(Array.isArray(requirements.interviewSignals) ? requirements.interviewSignals.map((id) => ({ id, kind: 'interview_signal' })) : []),
  ];
  if (nonEmpty(requirements.role)) requirementEntries.unshift({ id: requirements.role.trim(), kind: 'role' });
  if (nonEmpty(requirements.seniority)) requirementEntries.push({ id: requirements.seniority.trim(), kind: 'seniority' });
  const seenRequirementIds = new Set();
  const dedupedRequirementEntries = requirementEntries.filter((entry) => {
    if (seenRequirementIds.has(entry.id)) return false;
    seenRequirementIds.add(entry.id);
    return true;
  });
  const sources = Array.isArray(research.sources) ? research.sources.filter((source) => nonEmpty(source?.url)) : [];
  const firstText = sources.find((source) => nonEmpty(source.text))?.text;
  const companyName = nonEmpty(research.companyTitle) ? research.companyTitle.trim() : (() => { try { return new URL(input.companyUrl).hostname; } catch { return 'Company workspace'; } })();
  return {
    source: { jobDescription: input.jobDescription.trim(), companyUrl: input.companyUrl.trim(), interviewDays: input.interviewDays },
    company_brief: {
      name: companyName,
      summary: firstText || `Research collected from ${input.companyUrl.trim()}.`,
      sources: sources.map(({ url, title }) => ({ url, title: nonEmpty(title) ? title : '' })),
    },
    role: { title: roleTitle, ...(nonEmpty(requirements.seniority) ? { level: requirements.seniority.trim() } : {}), requirements: dedupedRequirementEntries },
    questions,
    flashcards: questions.map((question, index) => ({ id: `f${index + 1}`, front: question.question, back: [...(question.expectedAnswerPoints || []), ...(question.followUps || [])].join('\n') || question.why, questionIds: [question.id] })),
    schedule: result.schedule,
    coverage: result.coverage,
  };
}

