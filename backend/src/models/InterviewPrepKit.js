const mongoose = require('mongoose');

// Stores the complete kit for the owning user.
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
    // Optional and additive: present only for kits created with a resume. They hold
    // metadata + the grounded match analysis, never the raw resume text.
    resume: { type: mongoose.Schema.Types.Mixed },
    resume_analysis: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

module.exports = mongoose.model('InterviewPrepKit', interviewPrepKitSchema);
