import { notFound } from 'next/navigation';
import { BackLink } from '@/components/layout/AppHeader';
import { DemoFrame } from '@/components/demo/DemoFrame';
import { DemoKitWorkspace } from '@/components/demo/DemoKitWorkspace';
import { demoKits, getDemoKit } from '@/lib/demoKits';

export const dynamicParams = false;

export function generateStaticParams() {
  return demoKits.map((kit) => ({ slug: kit.slug }));
}

export default function DemoKitPage({ params }) {
  const kit = getDemoKit(params.slug);
  if (!kit) notFound();
  return <DemoFrame className="max-w-none pt-5 sm:pt-6">
    <BackLink href="/demo">All demo kits</BackLink>
    <div className="mt-4"><DemoKitWorkspace kit={kit} /></div>
  </DemoFrame>;
}
