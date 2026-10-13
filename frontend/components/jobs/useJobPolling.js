'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { isActiveJob, pollDelayMs } from '@/lib/jobs';

// Polls GET /api/jobs/:id until the job succeeds or fails, then calls
// onFinished(job) once. Polling stops on unmount, when jobId changes, and when
// the job finishes; bump `epoch` to start watching the same job again (for
// example after a resume). A failed poll (timeout, network) is reported in
// `pollError` and retried on the next tick; a 404 stops polling and sets
// `notFound`.
export function useJobPolling({ token, jobId, epoch = 0, onFinished }) {
  const [job, setJob] = useState(null);
  const [pollError, setPollError] = useState('');
  const [notFound, setNotFound] = useState(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;

  useEffect(() => {
    setJob(null);
    setPollError('');
    setNotFound(false);
    if (!token || !jobId) return undefined;
    let cancelled = false;
    let timer;
    const startedAt = Date.now();

    const tick = async () => {
      try {
        const next = await api.getJob(token, jobId);
        if (cancelled) return;
        setJob(next);
        setPollError('');
        if (!isActiveJob(next)) {
          onFinishedRef.current?.(next);
          return;
        }
      } catch (error) {
        if (cancelled) return;
        if (error?.status === 404) {
          setPollError('This generation could not be found. It may have expired.');
          setNotFound(true);
          return;
        }
        setPollError('Checking progress failed for a moment. Still trying…');
      }
      timer = setTimeout(tick, pollDelayMs(Date.now() - startedAt));
    };

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [token, jobId, epoch]);

  return { job, pollError, notFound };
}
