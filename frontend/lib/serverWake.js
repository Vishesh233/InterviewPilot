// Cold-start state for the API. Render's free tier stops the backend after a
// period of inactivity; the next request then waits while it starts again
// (often 30–60 s). The UI shows a "waking up" notice from this store, and every
// failed request shares one wake-up loop instead of each retrying on its own.

export const SLOW_REQUEST_MS = 8_000;      // a request this slow may be a cold start
export const WAKE_BUDGET_MS = 90_000;      // give up waking after this long
const MAX_PROBE_TIMEOUT_MS = 60_000;       // one health check may wait this long
const FIRST_RETRY_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 15_000;

let state = 'idle'; // 'idle' | 'waking' | 'failed'
const listeners = new Set();
let wakeLoop = null;

export const getWakeState = () => state;

export const subscribeWake = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const setState = (next) => {
  if (state === next) return;
  state = next;
  for (const listener of listeners) listener(state);
};

// A request has been pending for SLOW_REQUEST_MS: tell the user why.
export const markSlowRequest = () => {
  if (state === 'idle') setState('waking');
};

// Any answer from the API means it is awake.
export const markServerResponded = () => {
  if (!wakeLoop && state !== 'idle') setState('idle');
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Waits until `probe(timeoutMs)` reports the API healthy, with backoff, for at
 * most WAKE_BUDGET_MS. Concurrent callers share the same loop.
 * Resolves true when the API is awake, false when it gave up.
 */
export const ensureServerAwake = (probe) => {
  if (wakeLoop) return wakeLoop;
  setState('waking');
  wakeLoop = (async () => {
    const deadline = Date.now() + WAKE_BUDGET_MS;
    let delay = FIRST_RETRY_DELAY_MS;
    while (Date.now() < deadline) {
      try {
        if (await probe(Math.min(deadline - Date.now(), MAX_PROBE_TIMEOUT_MS))) return true;
      } catch (error) {
        console.info('Server is not awake yet; checking again.', error?.code || error?.name || 'unknown');
      }
      const wait = Math.min(delay, deadline - Date.now());
      if (wait <= 0) break;
      await sleep(wait);
      delay = Math.min(delay * 2, MAX_RETRY_DELAY_MS);
    }
    return false;
  })().then((awake) => {
    wakeLoop = null;
    setState(awake ? 'idle' : 'failed');
    return awake;
  });
  return wakeLoop;
};
