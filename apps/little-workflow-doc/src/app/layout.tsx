import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Inter } from 'next/font/google';
import type { Metadata } from 'next';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata = {
  metadataBase: new URL('https://little-workflow.dev'),
  title: {
    default: 'Little Workflow',
    template: '%s | Little Workflow',
  },
  description:
    'Documentation-first design for a TypeScript AI workflow compiler and durable runtime.',
} satisfies Metadata;

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
