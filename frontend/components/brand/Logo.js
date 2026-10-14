// InterviewPilot brand: an original mark (an ascending route line ending in a
// waypoint, on a rounded green square) plus the "InterviewPilot" wordmark.
// The same geometry is used for app/icon.svg, the favicon and the OG image.

export const MARK_PATH = 'M8 22.5 13.5 17l4 3.5L24 11.5';

// `inverse`: white square with a green route, for green backgrounds.
export function LogoMark({ size = 32, className = '', title, inverse = false }) {
  return <svg
    aria-hidden={title ? undefined : true}
    className={className}
    height={size}
    role={title ? 'img' : undefined}
    viewBox="0 0 32 32"
    width={size}
    xmlns="http://www.w3.org/2000/svg"
  >
    {title && <title>{title}</title>}
    <rect fill={inverse ? '#fff' : 'rgb(var(--color-brand-600))'} height="32" rx="8" width="32" />
    <path d={MARK_PATH} fill="none" stroke={inverse ? 'rgb(var(--color-brand-600))' : '#fff'} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.6" />
    <circle cx="24" cy="11.5" fill={inverse ? 'rgb(var(--color-brand-500))' : 'rgb(var(--color-brand-200))'} r="2.9" />
  </svg>;
}

// `tone="light"` for dark backgrounds (the auth side panel).
export function Wordmark({ size = 28, tone = 'dark', className = '' }) {
  const ink = tone === 'light' ? 'text-white' : 'text-ink';
  const accent = tone === 'light' ? 'text-brand-200' : 'text-brand-600';
  return <span className={`inline-flex items-center gap-2.5 ${className}`}>
    <LogoMark inverse={tone === 'light'} size={size} />
    <span className={`text-[15px] font-semibold tracking-tight ${ink}`}>Interview<span className={accent}>Pilot</span></span>
  </span>;
}
