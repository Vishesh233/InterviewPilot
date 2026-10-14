import { StatusPage } from '@/components/layout/StatusPage';
import { LinkButton } from '@/components/ui/Primitives';

export const metadata = { title: 'Page not found' };

export default function NotFound() {
  return <StatusPage
    actions={<><LinkButton href="/dashboard" variant="primary">Go to your dashboard</LinkButton><LinkButton href="/">Back to the home page</LinkButton></>}
    code="Error 404"
    title="This page doesn’t exist."
  >
    The link may be out of date, or the kit may have been deleted.
  </StatusPage>;
}
