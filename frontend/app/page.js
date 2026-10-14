import { Landing } from '@/components/landing/Landing';
import { SignedInRedirect } from '@/components/landing/SignedInRedirect';

export default function HomePage() {
  return <>
    <SignedInRedirect />
    <Landing />
  </>;
}
