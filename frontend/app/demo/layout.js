const title = 'Demo · InterviewPilot';
const description = 'Explore two complete interview prep kits, Frontend Developer at Vercel and Backend Developer at Stripe: company brief, requirement coverage map, grounded questions, flashcards, a day-by-day schedule and practice mode. No signup needed.';

export const metadata = {
  title: { absolute: title },
  description,
  openGraph: { type: 'website', siteName: 'InterviewPilot', title, description, url: '/demo' },
  twitter: { card: 'summary_large_image', title, description },
};

export default function DemoLayout({ children }) {
  return children;
}
