import { ImageResponse } from 'next/og';

// Link-preview image (LinkedIn, Slack, X ...), rendered on request (edge) from the
// brand mark and the product's one-line value proposition.
export const alt = 'InterviewPilot: turn a job description into a tailored interview prep kit';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
// Edge runtime: next/og loads its bundled font with fetch() there; the Node
// runtime's file-URL font loading fails on Windows builds ("Invalid URL").
export const runtime = 'edge';

const FEATURES = ['Coverage map', 'Practice questions', 'Flashcards', 'Day-by-day schedule'];

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '72px 80px', background: '#f7f8f4', color: '#17201b' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 20 }}>
          <svg height="72" viewBox="0 0 32 32" width="72" xmlns="http://www.w3.org/2000/svg">
            <rect fill="#216b42" height="32" rx="8" width="32" />
            <path d="M8 22.5 13.5 17l4 3.5L24 11.5" fill="none" stroke="#fff" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.6" />
            <circle cx="24" cy="11.5" fill="#b5dcbd" r="2.9" />
          </svg>
          <div style={{ display: 'flex', fontSize: 40, fontWeight: 700, letterSpacing: -1 }}>
            <span>Interview</span><span style={{ color: '#216b42' }}>Pilot</span>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ fontSize: 68, fontWeight: 700, lineHeight: 1.08, letterSpacing: -2, maxWidth: 980 }}>
            Turn any job description into a focused interview plan.
          </div>
          <div style={{ fontSize: 30, color: '#5d665f', maxWidth: 940 }}>
            Requirements extracted, company researched, questions grounded in both.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 14 }}>
          {FEATURES.map((feature) => (
            <div key={feature} style={{ display: 'flex', padding: '10px 20px', borderRadius: 999, background: '#eff8f0', color: '#185536', fontSize: 24, fontWeight: 600 }}>{feature}</div>
          ))}
        </div>
      </div>
    ),
    size
  );
}
