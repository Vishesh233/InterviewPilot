import './globals.css';
import { AuthProvider } from '@/components/auth/AuthProvider';

export const metadata = {
  title: 'InterviewPilot | Trao',
  description: 'AI-powered interview preparation, tailored to the role you\'re applying for.',
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
