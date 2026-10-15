// `label` is the progress bar's accessible name (e.g. "Requirement coverage").
export function ProgressBar({ value = 0, className = '', label = 'Progress' }) {
  const safeValue = Math.max(0, Math.min(100, Number(value) || 0));
  return <div className={`h-2 overflow-hidden rounded-full bg-sunken ${className}`} role="progressbar" aria-label={label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={safeValue}>
    <div className="h-full rounded-full bg-brand-500 transition-[width] duration-300" style={{ width: `${safeValue}%` }} />
  </div>;
}

// `compact` shrinks the tile on small screens (stat rows above content on mobile).
export function Stat({ label, value, detail, tone = 'default', compact = false }) {
  return <div className={`rounded-control border border-line bg-subtle ${compact ? 'px-3 py-2.5 sm:px-4 sm:py-4' : 'px-4 py-4'}`}>
    <p className={`font-semibold uppercase text-muted ${compact ? 'text-[10px] tracking-[0.1em] sm:text-[11px] sm:tracking-[0.12em]' : 'text-[11px] tracking-[0.12em]'}`}>{label}</p>
    <p className={`font-semibold tracking-tight ${compact ? 'mt-1 text-lg sm:mt-2 sm:text-2xl' : 'mt-2 text-2xl'} ${tone === 'green' ? 'text-brand-600' : 'text-ink'}`}>{value}</p>
    {detail && <p className={`mt-1 text-xs text-muted ${compact ? 'hidden sm:block' : ''}`}>{detail}</p>}
  </div>;
}
