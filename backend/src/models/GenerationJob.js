const mongoose = require('mongoose');

const JOB_TYPES = ['kit', 'gapQuestions', 'regenerate', 'answerFeedback'];
const JOB_STATUSES = ['queued', 'running', 'retrying', 'succeeded', 'failed'];
const ACTIVE_JOB_STATUSES = ['queued', 'running', 'retrying'];
const FINISHED_JOB_TTL_SECONDS = 7 * 24 * 60 * 60;

// One background generation (a new kit, gap questions, a section
// regeneration, or feedback on a practice answer). `input` holds only what the
// pipeline needs: never a resume's text, a key, or a token. A feedback job
// holds the user's answer, which is also stored on their kit.
// `checkpoints` holds the validated output of every
// finished stage, keyed by stage name, so a resumed job skips that work.
const generationJobSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: JOB_TYPES, required: true },
    kitId: { type: mongoose.Schema.Types.ObjectId, ref: 'InterviewPrepKit' },
    status: { type: String, enum: JOB_STATUSES, required: true, default: 'queued' },
    stage: { type: String, default: null },
    stageIndex: { type: Number, default: 0 },
    stageCount: { type: Number, required: true },
    input: { type: mongoose.Schema.Types.Mixed, default: {} },
    checkpoints: { type: mongoose.Schema.Types.Mixed, default: {} },
    attemptsByStage: { type: mongoose.Schema.Types.Mixed, default: {} },
    resumeCount: { type: Number, default: 0 },
    nextRetryAt: { type: Date, default: null },
    result: {
      kitId: { type: mongoose.Schema.Types.ObjectId, ref: 'InterviewPrepKit' },
      summary: { type: mongoose.Schema.Types.Mixed },
    },
    error: {
      code: { type: String },
      message: { type: String },
      stage: { type: String },
    },
    // Stage name -> "provider:model" that produced the stage's output.
    modelsUsed: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Sanitized LLM and job events (failed attempts, fallbacks, cooldowns,
    // auto-resumes, the final failure); bounded to the most recent entries.
    events: { type: [mongoose.Schema.Types.Mixed], default: [] },
    // "userId:type:kitId" while the job is active, unset once it finishes. The
    // unique sparse index makes "one active job per user/type/kit" atomic.
    activeKey: { type: String },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, minimize: false }
);

generationJobSchema.index({ userId: 1, status: 1 });
generationJobSchema.index({ activeKey: 1 }, { unique: true, sparse: true });
// Finished jobs are deleted 7 days after finishedAt; unfinished jobs have no
// finishedAt and are never expired.
generationJobSchema.index({ finishedAt: 1 }, { expireAfterSeconds: FINISHED_JOB_TTL_SECONDS });

module.exports = mongoose.model('GenerationJob', generationJobSchema);
module.exports.JOB_TYPES = JOB_TYPES;
module.exports.ACTIVE_JOB_STATUSES = ACTIVE_JOB_STATUSES;
module.exports.FINISHED_JOB_TTL_SECONDS = FINISHED_JOB_TTL_SECONDS;
