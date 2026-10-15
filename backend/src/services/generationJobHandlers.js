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
const mockInterviewService = require('./mockInterviewService');
const { validateKitStructure } = require('./kitStructureValidator');
const { kitFromPipeline, prepareKitForStorage } = require('./pipelineKitService');
const { runCheckpointedStage } = require('./stageCheckpoint');
const { JobError } = require('./generationJobService');
const { isPlainObject } = require('./inputValidationService');

const { KIT_PIPELINE_STAGES: S } = interviewPrepPipelineService;
const SAVE_STAGE = 'Saving kit';
const SAVE_FEEDBACK_STAGE = 'Saving feedback';
const SAVE_REPORT_STAGE = 'Saving mock report';

const hasSavedKit = (value) => Boolean(value) && typeof value.kitId === 'string' && value.kitId.length > 0;

const KIT_STAGES = [S.EXTRACTION, S.RESEARCH, S.COMPANY_BRIEF, S.GENERATION, S.COVERAGE, S.GAP_FILL, S.FINAL_COVERAGE];

const createJobHandlers = ({ pipelineDeps = {}, serviceDeps = {}, kitModel = InterviewPrepKit, mockStore = mockInterviewService.mongoMockStore } = {}) => {
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

  // ---- mock interviews ----
  const { STAGES: MOCK } = mockInterviewService;

  // Builder/mock validation errors become job errors with the same code.
  const rethrowAsJobError = (stage, error) => {
    if (error instanceof kitBuilderService.KitBuilderError) throw new JobError(error.code, error.message, { stage, status: error.status });
    throw error;
  };

  const loadOwnedSession = async (job, stage) => {
    const session = await mockStore.findOwned(job.input.sessionId, job.userId);
    if (!session) throw new JobError('MOCK_NOT_FOUND', 'The mock interview no longer exists.', { stage, status: 404 });
    return session;
  };

  // Grades the current turn, then asks a follow-up or the next question, or
  // completes the session with its report. The save only applies while the
  // session is active and the turn is still unanswered, so a turn is never
  // saved twice.
  const mockTurnHandler = {
    stages: () => [MOCK.GRADING, MOCK.REPORT, MOCK.SAVE],
    run: async ({ job, context }) => {
      const saved = context.checkpoints?.[MOCK.SAVE];
      if (saved?.summary?.sessionId) {
        await context.onStage(MOCK.SAVE, { fromCheckpoint: true });
        return saved;
      }
      const { turnIndex, answer } = job.input;
      const session = await loadOwnedSession(job, MOCK.GRADING);
      if (session.status !== 'active') {
        throw new JobError('MOCK_NOT_ACTIVE', 'This mock interview has ended.', { stage: MOCK.GRADING, status: 409 });
      }
      if (mockInterviewService.currentTurnIndex(session) !== turnIndex) {
        throw new JobError('MOCK_TURN_MISMATCH', 'This answer is for a question that is no longer current.', { stage: MOCK.GRADING, status: 409 });
      }
      const kit = await loadOwnedKit(job, MOCK.GRADING);
      const turn = session.turns[turnIndex];
      let gradingContext;
      try {
        gradingContext = mockInterviewService.gradingContextFor({ kit, turn, answer });
      } catch (error) {
        rethrowAsJobError(MOCK.GRADING, error);
      }
      const graded = await runCheckpointedStage(context, MOCK.GRADING, {
        isValid: (value) => answerFeedbackService.isValidFeedback(value?.feedback),
        run: () => answerFeedbackService.generateAnswerFeedback({ context: gradingContext, client: serviceDeps.feedbackClient }),
      });

      const now = new Date();
      let next;
      try {
        next = mockInterviewService.applyGradedTurn({ session, kit, answer: gradingContext.answer, feedback: graded.feedback, now });
      } catch (error) {
        rethrowAsJobError(MOCK.GRADING, error);
      }
      const outcome = next.completed
        ? await runCheckpointedStage(context, MOCK.REPORT, {
          isValid: mockInterviewService.isValidReportOutcome,
          run: () => mockInterviewService.generateReport({ kit, session: { ...session, turns: next.turns }, client: serviceDeps.feedbackClient }),
        })
        : null;

      return runCheckpointedStage(context, MOCK.SAVE, {
        isValid: (value) => Boolean(value?.summary?.sessionId),
        run: async () => {
          const modelsUsed = {
            ...(session.modelsUsed || {}),
            [`turn${turnIndex}`]: graded.modelUsed || null,
            ...(outcome?.modelUsed ? { report: outcome.modelUsed } : {}),
          };
          const updated = await mockStore.update(job.input.sessionId, job.userId,
            { status: 'active', turns: { $size: session.turns.length }, [`turns.${turnIndex}.answer`]: null },
            {
              turns: next.turns,
              currentIndex: next.currentIndex,
              lastActivityAt: now,
              modelsUsed,
              ...(next.completed ? { status: 'completed', report: outcome.report, reportError: outcome.reportError || null } : {}),
            });
          if (!updated) throw new JobError('MOCK_TURN_CONFLICT', 'The mock interview changed while this answer was graded.', { stage: MOCK.SAVE, status: 409 });
          const gradedTurn = next.turns[turnIndex];
          return {
            kitId: String(job.kitId),
            summary: {
              sessionId: String(job.input.sessionId),
              turnIndex,
              score: gradedTurn.feedback.score,
              verdict: gradedTurn.feedback.verdict,
              followUpAsked: gradedTurn.followUpAsked,
              completed: next.completed,
              reportAvailable: next.completed ? Boolean(outcome.report) : false,
            },
          };
        },
      });
    },
  };

  // Retries the report of a completed session whose report could not be written.
  const mockReportHandler = {
    stages: () => [MOCK.REPORT, SAVE_REPORT_STAGE],
    run: async ({ job, context }) => {
      const saved = context.checkpoints?.[SAVE_REPORT_STAGE];
      if (saved?.summary?.sessionId) {
        await context.onStage(SAVE_REPORT_STAGE, { fromCheckpoint: true });
        return saved;
      }
      const session = await loadOwnedSession(job, MOCK.REPORT);
      if (session.status !== 'completed' || session.report) {
        throw new JobError('MOCK_REPORT_NOT_NEEDED', 'Only a completed interview without a report can retry it.', { stage: MOCK.REPORT, status: 409 });
      }
      const kit = await loadOwnedKit(job, MOCK.REPORT);
      const outcome = await runCheckpointedStage(context, MOCK.REPORT, {
        isValid: (value) => isPlainObject(value?.report),
        run: async () => {
          const result = await mockInterviewService.generateReport({ kit, session, client: serviceDeps.feedbackClient });
          if (!result.report) throw new JobError(result.reportError.code, result.reportError.message, { stage: MOCK.REPORT, status: 502 });
          return result;
        },
      });
      return runCheckpointedStage(context, SAVE_REPORT_STAGE, {
        isValid: (value) => Boolean(value?.summary?.sessionId),
        run: async () => {
          const updated = await mockStore.update(job.input.sessionId, job.userId, { status: 'completed', report: null }, {
            report: outcome.report,
            reportError: null,
            lastActivityAt: new Date(),
            modelsUsed: { ...(session.modelsUsed || {}), report: outcome.modelUsed || null },
          });
          if (!updated) throw new JobError('MOCK_REPORT_NOT_NEEDED', 'The report was already written.', { stage: SAVE_REPORT_STAGE, status: 409 });
          return { kitId: String(job.kitId), summary: { sessionId: String(job.input.sessionId), reportAvailable: true } };
        },
      });
    },
  };

  return {
    kit: kitHandler,
    gapQuestions: gapQuestionsHandler,
    regenerate: regenerateHandler,
    answerFeedback: answerFeedbackHandler,
    mockTurn: mockTurnHandler,
    mockReport: mockReportHandler,
  };
};

const defaultHandlers = createJobHandlers();

module.exports = { createJobHandlers, defaultHandlers, SAVE_STAGE, SAVE_FEEDBACK_STAGE };
