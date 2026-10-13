'use client';

import { Suspense } from 'react';
import NewKitForm from '@/components/kit/NewKitForm';
import { PageFrame } from '@/components/layout/AppHeader';
import { LoadingState } from '@/components/ui/Primitives';

// NewKitForm reads ?job=<id> with useSearchParams, which needs a Suspense
// boundary in the App Router.
export default function NewKitPage() {
  return <Suspense fallback={<PageFrame><LoadingState label="Loading" /></PageFrame>}><NewKitForm /></Suspense>;
}
