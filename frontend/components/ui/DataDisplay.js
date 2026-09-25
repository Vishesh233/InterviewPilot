export function ProgressBar({ value = 0, className = '' }) {
  const safeValue = Math.max(0, Math.min(100, Number(value) || 0));
  return <div className={`h-2 overflow-hidden rounded-full bg-[#edf1ec] ${className}`} role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={safeValue}>
    <div className="h-full rounded-full bg-brand-500 transition-[width] duration-300" style={{ width: `${safeValue}%` }} />
  </div>;
}

export function Stat({ label, value, detail, tone = 'default' }) {
  return <div className="rounded-xl border border-line bg-[#fbfcfa] px-4 py-4">
    <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">{label}</p>
    <p className={`mt-2 text-2xl font-semibold tracking-tight ${tone === 'green' ? 'text-brand-600' : 'text-ink'}`}>{value}</p>
    {detail && <p className="mt-1 text-xs text-muted">{detail}</p>}
  </div>;
}
