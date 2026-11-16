import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Bricolage_Grotesque, Figtree, JetBrains_Mono } from 'next/font/google';
import type { Metadata } from 'next';
import { appName, siteUrl } from '@/lib/shared';
import { StackIconMotion } from '@/components/stack-icon-motion';

// Figtree for reading, Bricolage Grotesque for headings, JetBrains Mono for code.
const body = Figtree({ subsets: ['latin'], variable: '--font-body' });
const display = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-display' });
const code = JetBrains_Mono({ subsets: ['latin'], variable: '--font-code' });

export const metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: `${appName} — Agents, workflows, and a feedback loop`,
    template: `%s | ${appName}`,
  },
  alternates: { canonical: '/' },
  openGraph: {
    siteName: appName,
    type: 'website',
    locale: 'en_US',
  },
  description:
    'Documentation for the Little stack: LittleDB traces and improves agents, Little Harness and Little Workflow are the SDK, and workspaces (managed by the LittleDB hosted service or self-hosted with Little Compute) are where their work lives.',
} satisfies Metadata;

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable} ${code.variable}`} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}<StackIconMotion /></RootProvider>
      </body>
    </html>
  );
}
