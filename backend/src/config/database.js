const mongoose = require('mongoose');

// Driver messages can echo the connection string; never log its credentials.
// Any URI loses its user:password part, and key=value pairs that look like
// secrets (password, token, key, secret) lose their value.
const redactDbText = (text) =>
  String(text || '')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^@/\s]+@/gi, '$1<credentials>@')
    .replace(/\b(pass(?:word)?|pwd|token|secret|api[-_]?key|key)(["']?\s*[:=]\s*["']?)[^\s"',;&}]+/gi, '$1$2<redacted>');

const safeDbMessage = (error) => redactDbText(error?.message);

// MongoServerError carries codeName and errmsg (e.g. Atlas 8000
// "user is not allowed to do action [...]"); they name the refused action.
const dbErrorMeta = (error) => JSON.stringify({
  name: error?.name || null,
  code: error?.code ?? null,
  ...(error?.codeName ? { codeName: String(error.codeName) } : {}),
  ...(error?.errmsg ? { errmsg: redactDbText(error.errmsg) } : {}),
  message: safeDbMessage(error),
});

// Connection events after the initial connect: the driver reconnects on its
// own, so these are logged for visibility and never end the process.
const logConnectionEvents = (connection) => {
  connection.on('error', (error) => console.error('MongoDB connection error.', dbErrorMeta(error)));
  connection.on('disconnected', () => console.warn('MongoDB disconnected.'));
  connection.on('reconnected', () => console.log('MongoDB reconnected.'));
};

// The driver's database when the URI names none. A least-privilege user
// (readWrite on the app's database only) cannot use it.
const DRIVER_DEFAULT_DB = 'test';

// MONGODB_DB_NAME, when set, selects the database and overrides any name in
// the URI path; otherwise the URI path decides (".../interviewpilot?...").
const connectOptions = (env = process.env) => {
  const dbName = typeof env.MONGODB_DB_NAME === 'string' ? env.MONGODB_DB_NAME.trim() : '';
  return dbName ? { dbName } : {};
};

// Mongoose builds each model's indexes in the background after connecting and
// does not report a failure on its own; wait for every build and log failures.
// A failed build leaves the API running (queries still work, without that
// index), so it is logged, not fatal.
const logIndexBuilds = async (connection = mongoose.connection) => {
  const results = await Promise.allSettled(
    connection.modelNames().map((name) => connection.model(name).init().then(() => name))
  );
  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error('MongoDB index build failed.', JSON.stringify({ model: connection.modelNames()[i] }), dbErrorMeta(result.reason));
    }
  });
  return results.filter((result) => result.status === 'rejected').length;
};

// Connect to MongoDB using the URI from the .env file
const connectDB = async () => {
  logConnectionEvents(mongoose.connection);
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI, connectOptions());
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    const dbName = conn.connection.name;
    console.log('MongoDB database:', JSON.stringify(dbName));
    if (dbName === DRIVER_DEFAULT_DB) {
      console.warn(`MongoDB database is the driver default "${DRIVER_DEFAULT_DB}": neither MONGODB_URI nor MONGODB_DB_NAME names one. A user with readWrite on the app's own database only will be refused here; add the database name to the URI path or set MONGODB_DB_NAME.`);
    }
  } catch (error) {
    console.error('MongoDB initial connection failed.', dbErrorMeta(error));
    process.exit(1);
  }
};

// True only while the default connection is open (readyState 1).
const isDbConnected = () => mongoose.connection.readyState === 1;

module.exports = connectDB;
module.exports.isDbConnected = isDbConnected;
module.exports.dbErrorMeta = dbErrorMeta;
module.exports.connectOptions = connectOptions;
module.exports.logIndexBuilds = logIndexBuilds;
