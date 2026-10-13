// In-memory implementation of the generation job store interface used by
// generationJobService (see mongoJobStore there), for tests only. It enforces
// the same unique-activeKey rule the MongoDB index does.

const { DuplicateActiveJobError } = require('../../src/services/generationJobService');

const createMemoryJobStore = () => {
  const jobs = new Map();
  let nextId = 1;
  const copy = (job) => (job ? structuredClone(job) : null);
  const keyTaken = (activeKey, exceptId) =>
    activeKey !== undefined && [...jobs.values()].some((job) => job.id !== exceptId && job.activeKey === activeKey);

  return {
    jobs,
    async create(doc) {
      if (keyTaken(doc.activeKey)) throw new DuplicateActiveJobError();
      const id = `job${String(nextId++).padStart(3, '0')}`;
      const at = new Date();
      const job = { ...structuredClone(doc), id, _id: id, createdAt: at, updatedAt: at };
      jobs.set(id, job);
      return copy(job);
    },
    async findById(id) {
      return copy(jobs.get(id));
    },
    async findOwned(id, userId) {
      const job = jobs.get(id);
      return job && String(job.userId) === String(userId) ? copy(job) : null;
    },
    async findByActiveKey(activeKey) {
      return copy([...jobs.values()].find((job) => job.activeKey === activeKey));
    },
    async update(id, { set = {}, unset = [], expectStatus } = {}) {
      const job = jobs.get(id);
      if (!job || (expectStatus && job.status !== expectStatus)) return null;
      if (set.activeKey !== undefined && keyTaken(set.activeKey, id)) throw new DuplicateActiveJobError();
      Object.assign(job, structuredClone(set));
      for (const field of unset) delete job[field];
      job.updatedAt = new Date();
      return copy(job);
    },
    async setCheckpoint(id, stage, value) {
      jobs.get(id).checkpoints[stage] = structuredClone(value);
    },
    async incrementAttempt(id, stage) {
      const job = jobs.get(id);
      job.attemptsByStage[stage] = (job.attemptsByStage[stage] || 0) + 1;
    },
    async setModelUsed(id, stage, model) {
      jobs.get(id).modelsUsed[stage] = model;
    },
    async pushEvent(id, event) {
      jobs.get(id).events.push(structuredClone(event));
    },
    async findUnfinished() {
      return [...jobs.values()].filter((job) => ['queued', 'running', 'retrying'].includes(job.status)).map(copy);
    },
  };
};

module.exports = { createMemoryJobStore };
