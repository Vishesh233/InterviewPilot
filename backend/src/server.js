require('dotenv').config();
const express = require('express');
const connectDB = require('./config/database');
const authRoutes = require('./routes/authRoutes');
const interviewPrepRoutes = require('./routes/interviewPrepRoutes');
const interviewPrepKitsRoutes = require('./routes/interviewPrepKitsRoutes');
const generationJobRoutes = require('./routes/generationJobRoutes');
const { RESUME_REQUEST_JSON_LIMIT_BYTES } = require('./services/resumeTextExtractor');
const { describeLlmConfig } = require('./services/geminiClient');
const { describeJobConfig, getDefaultJobRunner } = require('./services/generationJobService');

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 5000;

// The interview-prep route can carry an optional resume file (base64), which needs
// a larger — still bounded — JSON limit. It parses its own body here, before the
// shared parser; body-parser then skips the already-consumed body, so every other
// route keeps the existing 256kb limit and all JSON parsing stays strict.
app.use('/api/interview-prep', express.json({ limit: RESUME_REQUEST_JSON_LIMIT_BYTES, strict: true }));
app.use(express.json({ limit: '256kb', strict: true }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRoutes);

// The routers already include their full /api/... paths.
app.use(interviewPrepRoutes);
app.use(interviewPrepKitsRoutes);
app.use(generationJobRoutes);

app.use((req, res) => {
  return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found.' } });
});

// Keep malformed, oversized, and unhandled errors structured and free of parser
// internals, stack traces, credentials, and filesystem paths.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large.' } });
  }
  if (error instanceof SyntaxError && error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON.' } });
  }
  console.error('Unhandled HTTP request error.', { name: error?.name, code: error?.code });
  return res.status(500).json({ error: { code: 'INTERNAL_SERVER_ERROR', message: 'Server error.' } });
});

if (require.main === module) {
  // Connect to the database FIRST, then start listening
  const startServer = async () => {
    console.log('LLM configuration:', JSON.stringify(describeLlmConfig()));
    console.log('Generation job configuration:', JSON.stringify(describeJobConfig()));
    await connectDB();

    // Requeue jobs a previous process left unfinished (or fail the ones that
    // were already resumed too often). A recovery failure is logged and the
    // server still starts, so new requests keep working.
    try {
      await getDefaultJobRunner().recoverOnStartup();
    } catch (error) {
      console.error('Generation job recovery failed.', JSON.stringify({ name: error?.name || null, code: error?.code ?? null }));
    }

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  };

  startServer();
}

module.exports = app;
