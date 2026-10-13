const mongoose = require('mongoose');

// Driver messages can echo the connection string; never log its credentials.
const safeDbMessage = (error) =>
  String(error?.message || '').replace(/(mongodb(?:\+srv)?:\/\/)[^@/\s]+@/gi, '$1<credentials>@');

const dbErrorMeta = (error) => JSON.stringify({
  name: error?.name || null,
  code: error?.code ?? null,
  message: safeDbMessage(error),
});

// Connection events after the initial connect: the driver reconnects on its
// own, so these are logged for visibility and never end the process.
const logConnectionEvents = (connection) => {
  connection.on('error', (error) => console.error('MongoDB connection error.', dbErrorMeta(error)));
  connection.on('disconnected', () => console.warn('MongoDB disconnected.'));
  connection.on('reconnected', () => console.log('MongoDB reconnected.'));
};

// Connect to MongoDB using the URI from the .env file
const connectDB = async () => {
  logConnectionEvents(mongoose.connection);
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error('MongoDB initial connection failed.', dbErrorMeta(error));
    process.exit(1);
  }
};

// True only while the default connection is open (readyState 1).
const isDbConnected = () => mongoose.connection.readyState === 1;

module.exports = connectDB;
module.exports.isDbConnected = isDbConnected;
