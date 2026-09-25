// Kit section regeneration service.
// Orchestrates: section selection -> protection of edited/pinned questions ->
// existing LLM question generation -> per-question validation -> deterministic
// stable ids -> deterministic coverage re-check -> the existing gap-fill stage ->
// flashcard/schedule consistency -> final kitStructureValidator gate.
// Nothing is persisted here: the controller only writes a kit this service has
// already validated, so an invalid regeneration can never reach MongoDB.

const { validateKitStructure } = require('./kitStructureValidator');
const { validateQuestion, QUESTION_CATEGORIES } = require('./questionSchema');
const { checkCoverage } = require('./coverageService');
const { generateQuestions } = require('./questionGenerationService');
const { fillCoverageGaps } = require('./gapFillService');
const builder = require('./kitBuilderService');

const { KitBuilderError, QUESTION_STATUS } = builder;

const questionIdOf = (question) => builder.trimString(question?.id);

/**
 * A generated candidate may only replace an existing question when it
 * - belongs to the requested section/category,
 * - references at least one requirement id this kit actually has, and
 * - uses source URLs that exist in the kit's company_brief.
 * Unusable candidates are skipped (never silently mis-labelled or mis-referenced).
 */
const prepareReplacement = (candidate, { category, requirementIds, allowedUrls }) => {
  if (!builder.isPlainObject(candidate) || candidate.category !== category) return null;

  const requirementRefs = Array.isArray(candidate.requirementRefs)
    ? candidate.requirementRefs
        .filter((ref) => typeof ref === 'string' && requirementIds.has(ref.trim()))
        .map((ref) => ref.trim())
    : [];
  if (requirementRefs.length === 0) return null;

  const sources = Array.isArray(candidate.sources)
    ? candidate.sources.filter((url) => typeof url === 'string' && allowedUrls.has(url))
    : [];

  const replacement = { ...candidate, requirementRefs, sources };
  const validation = validateQuestion({ ...replacement, id: questionIdOf(candidate) || 'replacement' });
  return validation.valid ? replacement : null;
};

// Split the section into replaceable (generated + unpinned) and protected questions.
const selectSection = (questions, category) => {
  const sectionQuestions = questions.filter((question) => question?.category === category);
  return {
    sectionQuestions,
    replaceable: sectionQuestions.filter(builder.isReplaceableQuestion),
    preserved: sectionQuestions.filter((question) => !builder.isReplaceableQuestion(question)),
  };
};

/**
 * Regenerate the generated, unpinned questions of one section/category.
 * Returns { kit, summary } where `kit` has already passed kitStructureValidator.
 * Throws KitBuilderError (with a machine-readable code) when the stored kit must
 * not be touched.
 *
 * `deps.generateQuestions` / `deps.fillCoverageGaps` are injectable so tests can
 * exercise the algorithm without calling the LLM.
 */
const regenerateKitSection = async ({ kit, category, deps = {} } = {}) => {
  const generate = typeof deps.generateQuestions === 'function' ? deps.generateQuestions : generateQuestions;
  const gapFill = typeof deps.fillCoverageGaps === 'function' ? deps.fillCoverageGaps : fillCoverageGaps;

  const section = typeof category === 'string' ? category.trim() : '';
  if (!section) {
    throw new KitBuilderError('BUILDER_INVALID_SECTION', 'category must be a non-empty question category.', {
      status: 400,
      details: { received: category === undefined ? null : typeof category },
    });
  }

  if (!QUESTION_CATEGORIES.includes(section)) {
    throw new KitBuilderError(
      'BUILDER_INVALID_SECTION',
      'category must be a supported question category.',
      { status: 400, details: { allowedCategories: QUESTION_CATEGORIES } }
    );
  }

  const storedKit = builder.applyKitQuestionMetadata(builder.toPlainKit(kit));
  const questions = builder.requireKitQuestions(storedKit);
  const { sectionQuestions, replaceable, preserved } = selectSection(questions, section);

  if (replaceable.length === 0) {
    throw new KitBuilderError(
      'BUILDER_NO_REPLACEABLE_QUESTIONS',
      `No generated, unpinned questions were found in the "${section}" section, so nothing was regenerated.`,
      {
        status: 409,
        details: {
          category: section,
          sectionQuestionCount: sectionQuestions.length,
          protectedQuestions: preserved.map((question) => ({
            id: questionIdOf(question),
            status: question.status,
            pinned: question.pinned === true,
          })),
        },
      }
    );
  }

  const requirements = builder.builderRequirementsFrom(storedKit);
  if (requirements.mustHaveSkills.length === 0) {
    throw new KitBuilderError(
      'BUILDER_MISSING_REQUIREMENT_REFS',
      'The kit has no requirement ids, so regenerated questions could not be referenced safely.',
      { status: 422 }
    );
  }

  const research = builder.builderResearchFrom(storedKit);
  const allowedUrls = new Set(research.sources.map((source) => source.url));
  const requirementIds = new Set(requirements.mustHaveSkills);

  let generated;
  try {
    generated = await generate({ requirements, research });
  } catch (error) {
    const detail = error?.isPublic && typeof error.message === 'string'
      ? error.message
      : 'The model provider could not complete the request.';
    throw new KitBuilderError(
      'KIT_REGENERATION_GENERATION_FAILED',
      `Question generation failed: ${detail}`,
      { status: error?.status === 429 ? 429 : 500 }
    );
  }

  const candidates = Array.isArray(generated?.questions) ? generated.questions : [];
  const replacements = [];
  for (const candidate of candidates) {
    if (replacements.length >= replaceable.length) break;
    const prepared = prepareReplacement(candidate, { category: section, requirementIds, allowedUrls });
    if (prepared) replacements.push(prepared);
  }

  if (replacements.length === 0) {
    throw new KitBuilderError(
      'BUILDER_NO_REPLACEMENTS_GENERATED',
      `Question generation produced no usable "${section}" questions, so nothing was changed.`,
      {
        status: 409,
        details: {
          category: section,
          generatedQuestionCount: candidates.length,
          replaceableQuestionIds: replaceable.map(questionIdOf),
        },
      }
    );
  }

  // Stable, collision-free ids; protected questions keep their exact objects.
  const replacementIds = builder.allocateQuestionIds(questions.map(questionIdOf), replacements.length);
  const idMap = new Map();
  let cursor = 0;
  const nextQuestions = questions.map((question) => {
    if (!builder.isReplaceableQuestion(question) || cursor >= replacements.length) {
      return builder.applyQuestionMetadata(question);
    }
    const replacementId = replacementIds[cursor];
    idMap.set(questionIdOf(question), replacementId);
    const replacement = {
      ...replacements[cursor],
      id: replacementId,
      status: QUESTION_STATUS.GENERATED,
      pinned: false,
    };
    cursor += 1;
    return replacement;
  });

  // Deterministic coverage re-check; the existing gap-fill stage runs only when
  // regeneration itself opened a coverage gap.
  const baseCoverage = checkCoverage({ requirements, questions: nextQuestions });
  let finalQuestions = nextQuestions;
  if (baseCoverage.missingRequirements.length > 0) {
    let filled;
    try {
      filled = await gapFill({ requirements, research, questions: nextQuestions, coverage: baseCoverage });
    } catch (error) {
      const detail = error?.isPublic && typeof error.message === 'string'
        ? error.message
        : 'The model provider could not complete the request.';
      throw new KitBuilderError(
        'KIT_REGENERATION_GAP_FILL_FAILED',
        `Coverage gap filling failed: ${detail}`,
        { status: error?.status === 429 ? 429 : 500 }
      );
    }
    const filledQuestions = Array.isArray(filled?.questions) ? filled.questions : nextQuestions;
    finalQuestions = builder.dedupeAppendedQuestionIds(filledQuestions, nextQuestions.length);
  }

  const coverage = checkCoverage({ requirements, questions: finalQuestions });
  let nextKit = {
    ...storedKit,
    questions: finalQuestions,
    coverage: { ...(builder.isPlainObject(storedKit.coverage) ? storedKit.coverage : {}), ...coverage },
  };
  nextKit = builder.withRemappedFlashcardRefs(nextKit, idMap);
  nextKit = builder.rebuildScheduleForQuestions(nextKit, finalQuestions);

  // Persist only after the complete kit passes the existing structure validator.
  const validation = validateKitStructure(nextKit);
  if (!validation.valid) {
    throw new KitBuilderError(
      'KIT_REGENERATION_VALIDATION_FAILED',
      'The regenerated kit failed structure validation and was not saved.',
      { status: 500, details: validation.errors.map(({ path, code }) => ({ path, code })) }
    );
  }

  const replacedQuestionIds = [...idMap.keys()];
  return {
    kit: nextKit,
    summary: {
      category: section,
      replacedQuestionIds,
      replacementQuestionIds: [...idMap.values()],
      preservedQuestionIds: sectionQuestions.map(questionIdOf).filter((id) => !idMap.has(id)),
      gapFilledQuestionIds: finalQuestions.slice(nextQuestions.length).map(questionIdOf),
      coverage,
    },
  };
};

module.exports = { regenerateKitSection };

