'use client';

import { useEffect } from 'react';
import { StatusPage } from '@/components/layout/StatusPage';
import { Button, LinkButton } from '@/components/ui/Primitives';

// Route-level error boundary: the error is logged (never swallowed) and the
// visitor can retry the page or go back to the dashboard.
export default function ErrorPage({ error, reset }) {
  useEffect(() => {
    console.error('Unhandled page error.', { name: error?.name, message: error?.message, digest: error?.digest });
  }, [error]);

  return <StatusPage
    actions={<><Button onClick={() => reset()} type="button">Try again</Button><LinkButton href="/dashboard">Go to your dashboard</LinkButton></>}
    code="Something went wrong"
    title="This page hit an unexpected error."
  >
    Try again. If it keeps happening, reload the page or come back in a minute.
  </StatusPage>;
}
