const mongoose = require('mongoose');

// Stores the complete Appendix A kit for the owning user.
// Each top-level section is Mixed so the validator remains the source of truth
// for shape; Mongoose only enforces presence + ownership here.
const interviewPrepKitSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    source: { type: mongoose.Schema.Types.Mixed, required: true },
    company_brief: { type: mongoose.Schema.Types.Mixed, required: true },
    role: { type: mongoose.Schema.Types.Mixed, required: true },
    questions: { type: mongoose.Schema.Types.Mixed, required: true },
    flashcards: { type: mongoose.Schema.Types.Mixed, required: true },
    schedule: { type: mongoose.Schema.Types.Mixed, required: true },
    coverage: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('InterviewPrepKit', interviewPrepKitSchema);
