// What each background job type runs. A handler lists its stages (for
// "step X of Y") and runs the existing pipeline/service with the job's
// checkpoint context, then saves the kit or the kit changes as its last,
// checkpointed stage so a resumed job can never save twice.
//
// createJobHandlers takes the pipeline / service stage dependencies and the kit
// model, so tests can run every handler with mocked LLM stages and no database.

const InterviewPrepKit = require('../models/InterviewPrepKit');
const interviewPrepPipelineService = require('./interviewPrepPipelineService');
const kitRegenerationService = require('./kitRegenerationService');
const kitGapQuestionService = require('./kitGapQuestionService');
const kitBuilderService = require('./kitBuilderService');
const answerFeedbackService = require('./answerFeedbackService');
const { validateKitStructure } = require('./kitStructureValidator');
const { kitFromPipeline, prepareKitForStorage } = require('./pipelineKitService');
const { runCheckpointedStage } = require('./stageCheckpoint');
const { JobError } = require('./generationJobService');

const { KIT_PIPELINE_STAGES: S } = interviewPrepPipelineService;
const SAVE_STAGE = 'Saving kit';
const SAVE_FEEDBACK_STAGE = 'Saving feedback';

const hasSavedKit = (value) => Boolean(value) && typeof value.kitId === 'string' && value.kitId.length > 0;

const KIT_STAGES = [S.EXTRACTION, S.RESEARCH, S.COMPANY_BRIEF, S.GENERATION, S.COVERAGE, S.GAP_FILL, S.FINAL_COVERAGE];

const createJobHandlers = ({ pipelineDeps = {}, serviceDeps = {}, kitModel = InterviewPrepKit } = {}) => {
  const loadOwnedKit = async (job, stage) => {
    const kit = await kitModel.findOne({ _id: job.kitId, userId: job.userId });
    if (!kit) throw new JobError('KIT_NOT_FOUND', 'The kit no longer exists.', { stage, status: 404 });
    return kitBuilderService.withBuilderMetadata(kit);
  };

  const saveKitChanges = (job, context, nextKit, summary, failureCode) =>
    runCheckpointedStage(context, SAVE_STAGE, {
      isValid: hasSavedKit,
      run: async () => {
        // The services already validated the kit; re-check before the write so an
        // invalid kit can never be persisted.
        const validation = validateKitStructure(nextKit);
        if (!validation.valid) {
          throw new JobError(failureCode, 'The updated kit failed structure validation and was not saved.', { stage: SAVE_STAGE });
        }
        const updated = await kitModel.findOneAndUpdate(
          { _id: job.kitId, userId: job.userId },
          { $set: kitBuilderService.pickKitSections(nextKit) },
          { returnDocument: 'after' }
        );
        if (!updated) throw new JobError('KIT_NOT_FOUND', 'The kit no longer exists.', { stage: SAVE_STAGE, status: 404 });
        return { kitId: String(job.kitId), summary };
      },
    });

  // A finished save means the kit changes are already stored; only the result is
  // needed. Checked before anything else because the earlier stages would now see
  // the updated kit (for example: no gaps left).
  const savedResultFromCheckpoint = async (context) => {
    const saved = context.checkpoints?.[SAVE_STAGE];
    if (!hasSavedKit(saved)) return null;
    await context.onStage(SAVE_STAGE, { fromCheckpoint: true });
    return saved;
  };

  const kitHandler = {
    stages: (input = {}) => [
      ...KIT_STAGES,
      ...(input.hasResume ? [S.RESUME_ANALYSIS, S.RESUME_QUESTIONS] : []),
      S.SCHEDULE,
      SAVE_STAGE,
    ],
    run: async ({ job, context, memoryInput }) => {
      const saved = await savedResultFromCheckpoint(context);
      if (saved) return saved;

      const { jobRole, jobDescription, companyUrl, interviewDays, hasResume } = job.input;
      // The resume text is held in memory only (it is never persisted), so a job
      // interrupted by a server restart cannot use it any more.
      if (hasResume && !memoryInput?.resume) {
        throw new JobError(
          'RESUME_TEXT_UNAVAILABLE',
          'The attached resume is no longer available because the server restarted. Start over and attach the resume again.',
          { stage: S.RESUME_ANALYSIS, status: 409 }
        );
      }
      const input = { jobRole, jobDescription, companyUrl, interviewDays, ...(hasResume ? { resume: memoryInput.resume } : {}) };
      const result = await interviewPrepPipelineService.generateInterviewPrepKit(input, pipelineDeps, context);

      return runCheckpointedStage(context, SAVE_STAGE, {
        isValid: hasSavedKit,
        run: async () => {
          const prepared = prepareKitForStorage(kitFromPipeline(input, result));
          if (prepared.errors) {
            console.error('Generated kit failed structure validation.', JSON.stringify({
              jobId: job.id,
              errors: prepared.errors.slice(0, 20).map(({ path, code }) => ({ path, code })),
            }));
            throw new JobError('KIT_VALIDATION_FAILED', 'The generated kit failed structure validation and was not saved.', { stage: SAVE_STAGE });
          }
          const created = await kitModel.create({ ...prepared.kit, userId: job.userId });
          return { kitId: String(created._id) };
        },
      });
    },
  };

  const gapQuestionsHandler = {
    stages: () => [kitGapQuestionService.GAP_QUESTION_STAGE, SAVE_STAGE],
    run: async ({ job, context }) => {
      const saved = await savedResultFromCheckpoint(context);
      if (saved) return saved;
      const kit = await loadOwnedKit(job, kitGapQuestionService.GAP_QUESTION_STAGE);
      const { kit: filled, summary } = await kitGapQuestionService.generateGapQuestions({ kit, context, deps: serviceDeps });
      return saveKitChanges(job, context, filled, summary, 'KIT_GAP_VALIDATION_FAILED');
    },
  };

  const regenerateHandler = {
    stages: () => [
      kitRegenerationService.REGENERATION_STAGES.GENERATION,
      kitRegenerationService.REGENERATION_STAGES.GAP_FILL,
      SAVE_STAGE,
    ],
    run: async ({ job, context }) => {
      const saved = await savedResultFromCheckpoint(context);
      if (saved) return saved;
      const kit = await loadOwnedKit(job, kitRegenerationService.REGENERATION_STAGES.GENERATION);
      const { kit: regenerated, summary } = await kitRegenerationService.regenerateKitSection({
        kit,
        category: job.input.category,
        context,
        deps: serviceDeps,
      });
      return saveKitChanges(job, context, regenerated, summary, 'KIT_REGENERATION_VALIDATION_FAILED');
    },
  };

  // Grades one practice answer, then appends the attempt to the question's
  // history on the kit, keeping only the latest MAX_FEEDBACK_HISTORY. The
  // update touches answer_feedback only, so it cannot race a kit edit.
  const answerFeedbackHandler = {
    stages: () => [answerFeedbackService.FEEDBACK_STAGE, SAVE_FEEDBACK_STAGE],
    run: async ({ job, context }) => {
      const saved = context.checkpoints?.[SAVE_FEEDBACK_STAGE];
      if (saved?.summary?.attempt) {
        await context.onStage(SAVE_FEEDBACK_STAGE, { fromCheckpoint: true });
        return saved;
      }
      const kit = await loadOwnedKit(job, answerFeedbackService.FEEDBACK_STAGE);
      const { questionId, answer, followUpQuestion } = job.input;
      let feedbackContext;
      try {
        feedbackContext = answerFeedbackService.prepareAnswerFeedback({ kit, questionId, answer, followUpQuestion });
      } catch (error) {
        if (error instanceof kitBuilderService.KitBuilderError) {
          throw new JobError(error.code, error.message, { stage: answerFeedbackService.FEEDBACK_STAGE, status: error.status });
        }
        throw error;
      }
      const graded = await runCheckpointedStage(context, answerFeedbackService.FEEDBACK_STAGE, {
        isValid: (value) => answerFeedbackService.isValidFeedback(value?.feedback),
        run: () => answerFeedbackService.generateAnswerFeedback({ context: feedbackContext, client: serviceDeps.feedbackClient }),
      });
      return runCheckpointedStage(context, SAVE_FEEDBACK_STAGE, {
        isValid: (value) => Boolean(value?.summary?.attempt),
        run: async () => {
          const attempt = answerFeedbackService.buildAttempt({ context: feedbackContext, ...graded });
          const path = `answer_feedback.${answerFeedbackService.feedbackKeyFor(feedbackContext.questionId)}`;
          const updated = await kitModel.findOneAndUpdate(
            { _id: job.kitId, userId: job.userId },
            { $push: { [path]: { $each: [attempt], $slice: -answerFeedbackService.MAX_FEEDBACK_HISTORY } } },
            { returnDocument: 'after' }
          );
          if (!updated) throw new JobError('KIT_NOT_FOUND', 'The kit no longer exists.', { stage: SAVE_FEEDBACK_STAGE, status: 404 });
          return { kitId: String(job.kitId), summary: { questionId: feedbackContext.questionId, attempt } };
        },
      });
    },
  };

  return {
    kit: kitHandler,
    gapQuestions: gapQuestionsHandler,
    regenerate: regenerateHandler,
    answerFeedback: answerFeedbackHandler,
  };
};

const defaultHandlers = createJobHandlers();

module.exports = { createJobHandlers, defaultHandlers, SAVE_STAGE, SAVE_FEEDBACK_STAGE };
