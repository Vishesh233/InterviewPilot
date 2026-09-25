require('dotenv').config();
const express = require('express');
const connectDB = require('./config/database');
const authRoutes = require('./routes/authRoutes');
const interviewPrepRoutes = require('./routes/interviewPrepRoutes');
const interviewPrepKitsRoutes = require('./routes/interviewPrepKitsRoutes');

const app = express();
app.disable('x-powered-by');
const PORT = process.env.PORT || 5000;

app.use(express.json({ limit: '256kb', strict: true }));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.use('/api/auth', authRoutes);

// The routers already include their full /api/... paths.
app.use(interviewPrepRoutes);
app.use(interviewPrepKitsRoutes);

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
    await connectDB();

    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  };

  startServer();
}

module.exports = app;
