// On-demand gap filling for a SAVED kit: "Generate questions for N gaps".
//
// Reuses the existing deterministic coverage check and the existing gap-fill LLM
// stage (no second AI pipeline). Only requirements that are genuinely uncovered are
// targeted; every generated question must reference one of those exact requirement
// strings or it is skipped; already-covered questions are never touched.
//
// The whole kit is validated with the existing kitStructureValidator before it is
// returned, so the controller can only ever persist a valid kit.

const { checkCoverage } = require('./coverageService');
const { fillCoverageGaps } = require('./gapFillService');
const { validateKitStructure } = require('./kitStructureValidator');
const { normalizeQuestionText } = require('./questionQualityService');
const builder = require('./kitBuilderService');
const { runCheckpointedStage } = require('./stageCheckpoint');

const { KitBuilderError, QUESTION_STATUS } = builder;

const flashcardIdsOf = (kit) =>
  (Array.isArray(kit?.flashcards) ? kit.flashcards : [])
    .map((card) => builder.trimString(card?.id))
    .filter((id) => typeof id === 'string' && id);

const nextFreeFlashcardId = (taken, cursorRef) => {
  let candidate = '';
  do {
    cursorRef.value += 1;
    candidate = `f${cursorRef.value}`;
  } while (taken.has(candidate));
  taken.add(candidate);
  return candidate;
};

const maxFlashcardSuffix = (ids) =>
  ids.reduce((max, id) => {
    const match = /^f(\d+)$/.exec(id);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);

// Same shape buildFinalKit() writes, so appended cards behave like the originals.
const flashcardFor = (question, id) => ({
  id,
  front: question.question,
  back: [
    ...(Array.isArray(question.expectedAnswerPoints) ? question.expectedAnswerPoints : []),
    ...(Array.isArray(question.followUps) ? question.followUps : []),
  ].join('\n') || question.why,
  questionIds: [question.id],
});

// Checkpoint key of a background gap-questions job.
const GAP_QUESTION_STAGE = 'Coverage gap filling';

/**
 * Every check that can reject a gap-question request before the LLM is called.
 * The HTTP layer runs it synchronously so a kit without gaps is answered
 * immediately; the background job runs it again on the then-current kit.
 */
const prepareGapQuestions = ({ kit } = {}) => {
  const storedKit = builder.applyKitQuestionMetadata(builder.toPlainKit(kit));
  const questions = builder.requireKitQuestions(storedKit);
  const requirements = builder.builderRequirementsFrom(storedKit);
  if (requirements.mustHaveSkills.length === 0) {
    throw new KitBuilderError(
      'BUILDER_MISSING_REQUIREMENT_REFS',
      'The kit has no requirement ids, so gap questions could not be referenced safely.',
      { status: 422 }
    );
  }

  // The deterministic coverage check is the only source of "gaps".
  const coverage = checkCoverage({ requirements, questions });
  const gaps = coverage.missingRequirements;
  if (gaps.length === 0) {
    throw new KitBuilderError(
      'KIT_NO_COVERAGE_GAPS',
      'Every requirement in this kit is already covered, so no questions were generated.',
      { status: 409, details: { gapCount: 0 } }
    );
  }

  return { storedKit, questions, requirements, coverage, gaps };
};

/**
 * Append validated questions for the kit's uncovered requirements.
 * Returns { kit, summary } where `kit` already passed kitStructureValidator.
 * Throws KitBuilderError (machine-readable code) when nothing may be written.
 *
 * `deps.fillCoverageGaps` is injectable so tests can exercise the algorithm without
 * calling the LLM. `context` is the optional background-job checkpoint context
 * (see stageCheckpoint.js).
 */
const generateGapQuestions = async ({ kit, deps = {}, context } = {}) => {
  const gapFill = typeof deps.fillCoverageGaps === 'function' ? deps.fillCoverageGaps : fillCoverageGaps;

  const { storedKit, questions, requirements, coverage, gaps } = prepareGapQuestions({ kit });
  const research = builder.builderResearchFrom(storedKit);
  const filled = await runCheckpointedStage(context, GAP_QUESTION_STAGE, {
    isValid: (value) => builder.isPlainObject(value) && Array.isArray(value.questions) && value.questions.length >= questions.length,
    run: async () => {
      try {
        return await gapFill({ requirements, research, questions, coverage });
      } catch (error) {
        const detail = error?.isPublic && typeof error.message === 'string'
          ? error.message
          : 'The model provider could not complete the request.';
        throw new KitBuilderError('KIT_GAP_GENERATION_FAILED', `Gap question generation failed: ${detail}`, {
          status: error?.status === 429 ? 429 : 500,
          causeCode: error?.code,
        });
      }
    },
  });

  const generated = Array.isArray(filled?.questions) ? filled.questions.slice(questions.length) : [];
  // Duplicate guard for the APPENDED questions only: a new question whose text is
  // identical to a question already in the kit (or to an earlier new one) is never
  // added. Pre-existing questions are never removed or rewritten, and dropped ids
  // are reported instead of being discarded silently.
  const seenTexts = new Set(questions.map((question) => normalizeQuestionText(question?.question)).filter(Boolean));
  const newQuestions = [];
  const droppedDuplicateQuestionIds = new Set(
    Array.isArray(filled?.droppedDuplicateQuestionIds) ? filled.droppedDuplicateQuestionIds : []
  );
  for (const candidate of generated) {
    const text = normalizeQuestionText(candidate?.question);
    if (text && seenTexts.has(text)) {
      droppedDuplicateQuestionIds.add(candidate?.id);
      continue;
    }
    if (text) seenTexts.add(text);
    newQuestions.push(candidate);
  }
  const reportedDuplicateQuestionIds = [...droppedDuplicateQuestionIds];

  if (newQuestions.length === 0) {
    throw new KitBuilderError(
      'KIT_NO_NEW_GAP_QUESTIONS',
      'No new questions could be generated for the remaining gaps, so nothing was changed.',
      { status: 409, details: { gapCount: gaps.length, droppedDuplicateQuestionIds: reportedDuplicateQuestionIds } }
    );
  }

  // Deterministic ids that collide with nothing already in the kit.
  const finalQuestions = builder
    .dedupeAppendedQuestionIds([...questions, ...newQuestions], questions.length)
    .map((question, index) =>
      index < questions.length
        ? question
        : { ...question, status: QUESTION_STATUS.GENERATED, pinned: false }
    );

  const addedQuestions = finalQuestions.slice(questions.length);
  const takenCardIds = new Set(flashcardIdsOf(storedKit));
  const cursor = { value: maxFlashcardSuffix([...takenCardIds]) };
  const newCards = addedQuestions.map((question) =>
    flashcardFor(question, nextFreeFlashcardId(takenCardIds, cursor))
  );

  const nextCoverage = checkCoverage({ requirements, questions: finalQuestions });
  let nextKit = {
    ...storedKit,
    questions: finalQuestions,
    flashcards: [...(Array.isArray(storedKit.flashcards) ? storedKit.flashcards : []), ...newCards],
    coverage: { ...(builder.isPlainObject(storedKit.coverage) ? storedKit.coverage : {}), ...nextCoverage },
  };
  nextKit = builder.rebuildScheduleForQuestions(nextKit, finalQuestions);

  const validation = validateKitStructure(nextKit);
  if (!validation.valid) {
    throw new KitBuilderError(
      'KIT_GAP_VALIDATION_FAILED',
      'The gap-filled kit failed structure validation and was not saved.',
      { status: 500, details: validation.errors.map(({ path, code }) => ({ path, code })) }
    );
  }

  return {
    kit: nextKit,
    summary: {
      gapCount: gaps.length,
      requestedRequirements: gaps,
      addedQuestionIds: addedQuestions.map((question) => question.id),
      addedFlashcardIds: newCards.map((card) => card.id),
      droppedDuplicateQuestionIds: reportedDuplicateQuestionIds,
      remainingGaps: nextCoverage.missingRequirements,
      coverage: nextCoverage,
    },
  };
};

module.exports = { generateGapQuestions, prepareGapQuestions, GAP_QUESTION_STAGE };
