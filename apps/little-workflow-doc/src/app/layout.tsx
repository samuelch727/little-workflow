import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import { Inter } from 'next/font/google';
import type { Metadata } from 'next';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata = {
  metadataBase: new URL(process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://little-workflow.dev'),
  title: {
    default: 'Little documentation',
    template: '%s | Little documentation',
  },
  description:
    'Documentation for the Little stack: LittleDB traces and improves agents, Little Harness and Little Workflow are the SDK, and workspaces (managed by the LittleDB hosted service or self-hosted with Little Compute) are where their work lives.',
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
