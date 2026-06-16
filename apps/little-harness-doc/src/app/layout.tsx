import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Lexend } from 'next/font/google';
import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';

const lexend = Lexend({
  subsets: ['latin'],
});

export const metadata = {
  metadataBase: new URL('https://little-harness.dev'),
  title: {
    default: 'Little Harness',
    template: '%s | Little Harness',
  },
  description:
    'Documentation-first design for a zero-config managed agent runtime.',
} satisfies Metadata;

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={GeistSans.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
