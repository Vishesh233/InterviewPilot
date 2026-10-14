'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/components/auth/AuthProvider';
import { Button } from '@/components/ui/Primitives';
import { Icon } from '@/components/ui/Icon';
import { Wordmark } from '@/components/brand/Logo';

const links = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/kits/new', label: 'New kit' },
];

// Exactly one nav item is active: "New kit" on /kits/new, "Dashboard" on the
// dashboard and on every saved kit (/kits/[id], /kits/[id]/practice).
export const activeNavHref = (pathname = '') => {
  if (pathname === '/kits/new' || pathname.startsWith('/kits/new/')) return '/kits/new';
  if (pathname === '/dashboard' || pathname.startsWith('/kits/')) return '/dashboard';
  return null;
};

function NavLinks({ pathname, className }) {
  const active = activeNavHref(pathname);
  return links.map((link) => <Link aria-current={active === link.href ? 'page' : undefined} className={`rounded-lg px-3 py-2 text-sm font-medium transition ${active === link.href ? 'bg-brand-50 text-brand-700' : 'text-muted hover:bg-canvas hover:text-ink'} ${className}`} href={link.href} key={link.href}>{link.label}</Link>);
}

export function AppHeader({ compact = false }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, logout } = useAuth();

  const handleLogout = () => {
    logout();
    router.replace('/login');
  };

  return <header className="border-b border-line bg-surface/90 backdrop-blur">
    <div className="container-shell flex min-h-[72px] items-center justify-between gap-5">
      <Link aria-label="InterviewPilot dashboard" className="rounded-control" href="/dashboard">
        <Wordmark />
      </Link>
      {!compact && <nav aria-label="Primary navigation" className="hidden items-center gap-1 md:flex">
        <NavLinks pathname={pathname} />
      </nav>}
      <div className="flex items-center gap-2">
        {user?.email && <span className="hidden max-w-[180px] truncate text-xs text-muted lg:block">{user.email}</span>}
        <Button onClick={handleLogout} title="Log out" variant="quiet"><Icon name="logout" size={17} /><span>Log out</span></Button>
      </div>
    </div>
    {/* Below md the primary navigation moves to its own row instead of disappearing. */}
    {!compact && <nav aria-label="Primary navigation" className="container-shell flex gap-1 border-t border-line py-2 md:hidden">
      <NavLinks className="flex-1 text-center" pathname={pathname} />
    </nav>}
  </header>;
}

export function PageFrame({ children, className = '' }) {
  return <div className="min-h-screen bg-canvas"><AppHeader /> <main className={`container-shell py-8 sm:py-10 ${className}`}>{children}</main></div>;
}

// The wordmark already names the product, so the eyebrow is optional (it used
// to default to "InterviewPilot" and repeat the wordmark right above it).
export function AuthShell({ children, eyebrow = '', title, description }) {
  return <main className="min-h-screen bg-canvas lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(420px,0.72fr)]">
    <section className="relative hidden overflow-hidden border-r border-line bg-brand-700 px-12 py-12 text-white lg:flex lg:flex-col lg:justify-between xl:px-20">
      <div className="absolute inset-0 opacity-20" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,.24) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.24) 1px, transparent 1px)', backgroundSize: '56px 56px' }} />
      <div className="relative"><Wordmark tone="light" /></div>
      <div className="relative max-w-xl"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-100">Prepare with intention</p><h1 className="mt-5 font-display text-6xl leading-[1.02] tracking-tight">Turn a job description into a clear plan.</h1><p className="mt-6 max-w-md text-base leading-7 text-brand-100">Research the company, understand the requirements, and walk into every interview with a sharper point of view.</p></div>
      <p className="relative text-xs text-brand-100">Your preparation workspace for better conversations.</p>
    </section>
    <section className="flex min-h-screen items-center justify-center px-5 py-10 sm:px-10"><div className="w-full max-w-[440px]"><div className="mb-10 lg:hidden"><Wordmark /></div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2 className="mt-3 font-display text-4xl tracking-tight text-ink">{title}</h2>{description && <p className="mt-3 text-sm leading-6 text-muted">{description}</p>}<div className="mt-8">{children}</div></div></section>
  </main>;
}

export function BackLink({ href, children }) {
  return <Link className="inline-flex items-center gap-2 text-sm font-medium text-muted transition hover:text-brand-700" href={href}><Icon className="rotate-180" name="arrow" size={16} />{children}</Link>;
}
