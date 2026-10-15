const mongoose = require('mongoose');

const MOCK_STATUSES = ['active', 'completed', 'abandoned'];
const TURN_KINDS = ['main', 'followUp'];

// One turn of a mock interview. A turn is created when its question is asked
// (answer and feedback null) and filled in when the answer has been graded.
// `feedback` has the answer-feedback shape (score, verdict, onTopic, strengths,
// gaps, improvedAnswer); the validator in answerFeedbackService is the
// authority, so it is Mixed here.
const turnSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: TURN_KINDS, required: true },
    questionId: { type: String, required: true },
    questionText: { type: String, required: true },
    answer: { type: String, default: null },
    feedback: { type: mongoose.Schema.Types.Mixed, default: null },
    followUpAsked: { type: Boolean, default: false },
    // Why no follow-up was asked after a graded main turn (for example
    // FOLLOW_UP_INVALID); null when one was asked or none was due.
    followUpSkipped: { type: String, default: null },
    createdAt: { type: Date, required: true },
    answeredAt: { type: Date, default: null },
  },
  { _id: false, minimize: false }
);

// A multi-turn mock interview grounded in one kit: `plan` holds the chosen kit
// question ids in order, `currentIndex` the position in `plan` of the main
// question being asked. `report` is written once the last turn is graded.
const mockInterviewSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    kitId: { type: mongoose.Schema.Types.ObjectId, ref: 'InterviewPrepKit', required: true },
    status: { type: String, enum: MOCK_STATUSES, required: true, default: 'active' },
    length: { type: Number, required: true, min: 3, max: 5 },
    plan: { type: [String], required: true },
    turns: { type: [turnSchema], default: [] },
    currentIndex: { type: Number, default: 0 },
    // { overallScore, summary, topicResults: [{ topic, score, note }], practiceNext: [{ questionId, reason }] }
    report: { type: mongoose.Schema.Types.Mixed, default: null },
    // { code, message } when the report could not be generated (retry with POST .../report).
    reportError: { type: mongoose.Schema.Types.Mixed, default: null },
    // Stage name -> "provider:model" for the LLM steps of this session.
    modelsUsed: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Last answer, report or start; an active session idle for 24 h is abandoned.
    lastActivityAt: { type: Date, required: true },
    abandonedReason: { type: String, default: null },
  },
  { timestamps: true, minimize: false }
);

// Unique for active sessions only, which makes "one active session per user"
// atomic; it also serves the { userId, status } lookups.
mockInterviewSchema.index({ userId: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'active' } });
mockInterviewSchema.index({ kitId: 1, createdAt: -1 });

module.exports = mongoose.model('MockInterview', mockInterviewSchema);
module.exports.MOCK_STATUSES = MOCK_STATUSES;
