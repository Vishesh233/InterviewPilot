import Link from 'next/link';
import { Icon } from './Icon';

export function Button({ children, variant = 'primary', className = '', ...props }) {
  const styles = {
    primary: 'button-primary',
    secondary: 'button-secondary',
    quiet: 'button-quiet',
  };
  return <button className={`${styles[variant] || styles.primary} ${className}`} {...props}>{children}</button>;
}

export function LinkButton({ href, children, variant = 'secondary', className = '', ...props }) {
  const styles = { primary: 'button-primary', secondary: 'button-secondary', quiet: 'button-quiet' };
  return <Link className={`${styles[variant] || styles.secondary} ${className}`} href={href} {...props}>{children}</Link>;
}

export function Badge({ children, tone = 'green', className = '' }) {
  const tones = {
    green: 'bg-brand-50 text-brand-700',
    gray: 'bg-[#f0f2ef] text-muted',
    amber: 'bg-[#fff7e7] text-[#96651a]',
    red: 'bg-[#fff0ee] text-[#a24a3f]',
  };
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold ${tones[tone] || tones.green} ${className}`}>{children}</span>;
}

export function Card({ children, className = '', ...props }) {
  return <section className={`card ${className}`} {...props}>{children}</section>;
}

export function Alert({ tone = 'error', title, children, className = '' }) {
  const styles = tone === 'success'
    ? 'border-brand-100 bg-brand-50 text-brand-700'
    : tone === 'info'
      ? 'border-[#dce7e5] bg-[#f5faf9] text-[#35655c]'
      : 'border-[#f1d2ce] bg-[#fff7f5] text-[#9d4b42]';
  return <div className={`rounded-xl border px-4 py-3 text-sm ${styles} ${className}`} role={tone === 'error' ? 'alert' : 'status'}>
    {title && <p className="font-semibold">{title}</p>}
    {children && <div className={title ? 'mt-1' : ''}>{children}</div>}
  </div>;
}

export function LoadingState({ label = 'Loading…', detail = '' }) {
  return <div className="flex min-h-[220px] flex-col items-center justify-center rounded-2xl border border-dashed border-line bg-white/60 px-6 text-center">
    <span className="mb-4 h-8 w-8 animate-spin rounded-full border-2 border-brand-100 border-t-brand-600" />
    <p className="text-sm font-medium text-ink">{label}</p>
    {detail && <p className="mt-1 max-w-md text-xs leading-5 text-muted">{detail}</p>}
  </div>;
}

export function EmptyState({ icon = 'spark', title, children, action }) {
  return <div className="rounded-2xl border border-dashed border-line bg-white px-6 py-12 text-center">
    <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Icon name={icon} size={20} /></div>
    <h2 className="mt-5 text-lg font-semibold text-ink">{title}</h2>
    {children && <div className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">{children}</div>}
    {action && <div className="mt-6">{action}</div>}
  </div>;
}
