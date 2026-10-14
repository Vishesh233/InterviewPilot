// Loading placeholders shaped like the page they stand in for. The pulse is
// switched off for prefers-reduced-motion by the global rule in globals.css.

export function Skeleton({ className = '' }) {
  return <span aria-hidden="true" className={`block animate-pulse rounded-control bg-sunken ${className}`} />;
}

function Loading({ label, children, className = '' }) {
  return <div aria-busy="true" className={className} role="status">
    <span className="sr-only">{label}</span>
    {children}
  </div>;
}

export function DashboardSkeleton() {
  return <Loading label="Loading your kits">
    <div className="border-b border-line pb-8"><Skeleton className="h-3 w-28" /><Skeleton className="mt-4 h-10 w-full max-w-xl" /><Skeleton className="mt-4 h-4 w-full max-w-md" /></div>
    <div className="mt-8 grid gap-3 sm:grid-cols-3">{[0, 1, 2].map((key) => <div className="rounded-control border border-line bg-subtle p-4" key={key}><Skeleton className="h-3 w-24" /><Skeleton className="mt-3 h-7 w-16" /></div>)}</div>
    <div className="mt-12 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((key) => <div className="card p-5" key={key}><div className="flex items-center gap-3"><Skeleton className="h-10 w-10" /><div className="flex-1"><Skeleton className="h-4 w-3/4" /><Skeleton className="mt-2 h-3 w-1/2" /></div></div><Skeleton className="mt-6 h-12 w-full" /><Skeleton className="mt-4 h-2 w-full" /></div>)}</div>
  </Loading>;
}

export function KitSkeleton() {
  return <Loading label="Loading your kit">
    <div className="border-b border-line bg-surface"><div className="container-shell py-7 sm:py-9"><div className="flex flex-wrap gap-2"><Skeleton className="h-6 w-40 rounded-full" /><Skeleton className="h-6 w-32 rounded-full" /></div><Skeleton className="mt-5 h-9 w-full max-w-lg" /><Skeleton className="mt-3 h-4 w-full max-w-sm" /></div></div>
    <div className="border-b border-line bg-surface"><div className="container-shell flex gap-4 py-4">{[0, 1, 2, 3, 4].map((key) => <Skeleton className="h-4 w-20" key={key} />)}</div></div>
    <div className="grid gap-5 py-7 lg:grid-cols-[1.1fr_.9fr]"><div className="card p-6"><Skeleton className="h-3 w-24" /><Skeleton className="mt-4 h-8 w-2/3" /><Skeleton className="mt-5 h-4 w-full" /><Skeleton className="mt-2 h-4 w-full" /><Skeleton className="mt-2 h-4 w-4/5" /></div><div className="card p-6"><Skeleton className="h-3 w-24" /><Skeleton className="mt-4 h-5 w-1/2" /><Skeleton className="mt-4 h-4 w-full" /><Skeleton className="mt-2 h-4 w-3/4" /></div></div>
  </Loading>;
}
