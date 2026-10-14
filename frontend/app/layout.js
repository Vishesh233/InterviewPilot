import './globals.css';
import { AuthProvider } from '@/components/auth/AuthProvider';

// Absolute base for Open Graph / Twitter image URLs: NEXT_PUBLIC_SITE_URL when
// set, else the Vercel production domain, else the local dev server.
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : 'http://localhost:3000');

const description = 'Paste a job description and get a tailored interview prep kit: a requirement coverage map, grounded practice questions, flashcards, a day-by-day schedule and an optional resume match.';

export const metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: 'InterviewPilot · Interview prep from any job description',
    template: '%s · InterviewPilot',
  },
  description,
  applicationName: 'InterviewPilot',
  openGraph: {
    type: 'website',
    siteName: 'InterviewPilot',
    title: 'InterviewPilot · Interview prep from any job description',
    description,
    url: '/',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'InterviewPilot · Interview prep from any job description',
    description,
  },
};

export const viewport = {
  themeColor: '#216b42',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
