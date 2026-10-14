import { Landing } from '@/components/landing/Landing';
import { SignedInRedirect } from '@/components/landing/SignedInRedirect';
import { ServerWakePing } from '@/components/layout/ServerWakeBanner';

export default function HomePage() {
  return <>
    <ServerWakePing />
    <SignedInRedirect />
    <Landing />
  </>;
}
