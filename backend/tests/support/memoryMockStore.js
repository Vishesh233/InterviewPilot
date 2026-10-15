// In-memory implementation of the mock interview store (see mongoMockStore in
// mockInterviewService), for tests only. It enforces the same "one active
// session per user" rule as the partial unique index and supports the filters
// the handlers use: status, report, turns.$size and turns.<n>.answer.

const { DuplicateActiveSessionError } = require('../../src/services/mockInterviewService');

const createMemoryMockStore = () => {
  const sessions = new Map();
  let nextId = 1;
  const copy = (value) => (value ? structuredClone(value) : null);
  const owned = (id, userId) => {
    const session = sessions.get(String(id));
    return session && String(session.userId) === String(userId) ? session : null;
  };
  const matches = (session, match) => Object.entries(match).every(([key, expected]) => {
    if (key === 'turns' && expected?.$size !== undefined) return session.turns.length === expected.$size;
    const turnAnswer = /^turns\.(\d+)\.answer$/.exec(key);
    if (turnAnswer) return session.turns[Number(turnAnswer[1])]?.answer === expected;
    return (session[key] ?? null) === expected;
  });

  return {
    sessions,
    async create(doc) {
      const active = [...sessions.values()].some((session) => String(session.userId) === String(doc.userId) && session.status === 'active');
      if (doc.status === 'active' && active) throw new DuplicateActiveSessionError();
      const id = `mock${String(nextId++).padStart(3, '0')}`;
      const at = new Date(Date.now() + nextId);
      const session = { ...structuredClone(doc), _id: id, createdAt: at, updatedAt: at };
      sessions.set(id, session);
      return copy(session);
    },
    async findOwned(id, userId) {
      return copy(owned(id, userId));
    },
    async findActive(userId) {
      return copy([...sessions.values()].find((session) => String(session.userId) === String(userId) && session.status === 'active'));
    },
    async listForKit(userId, kitId, limit) {
      return [...sessions.values()]
        .filter((session) => String(session.userId) === String(userId) && String(session.kitId) === String(kitId))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map(copy);
    },
    async update(id, userId, match, set) {
      const session = owned(id, userId);
      if (!session || !matches(session, match)) return null;
      Object.assign(session, structuredClone(set), { updatedAt: new Date() });
      return copy(session);
    },
    async expireStale(userId, cutoff) {
      let count = 0;
      for (const session of sessions.values()) {
        if (String(session.userId) === String(userId) && session.status === 'active' && session.lastActivityAt < cutoff) {
          Object.assign(session, { status: 'abandoned', abandonedReason: 'inactive' });
          count += 1;
        }
      }
      return count;
    },
  };
};

module.exports = { createMemoryMockStore };
