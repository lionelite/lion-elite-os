import type { ReactNode } from 'react';
import './styles.css';

export const metadata = { title: 'BuildPipeline', description: 'Book qualified sales calls from a video funnel.' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
