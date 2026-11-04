import Link from 'next/link';

type ProductStatusEntry = {
  product: string;
  status: string;
  available: boolean;
};

// Release status per product root, as of the 2026-10-09 checks recorded on /docs/releases.
const PRODUCT_STATUS: Record<string, ProductStatusEntry> = {
  harness: {
    product: 'Little Harness',
    status: 'published on npm as little-harness@0.2.0-alpha.0 (2026-10-05).',
    available: true,
  },
  workflow: {
    product: 'Little Workflow',
    status: 'published on npm as little-workflow@0.2.0-alpha.1 (2026-10-06).',
    available: true,
  },
  compute: {
    product: 'Little Compute',
    status:
      'the self-hosted workspace engine, unpublished source with its control plane frozen. Not on npm and not in the public repository, so there is no public install path.',
    available: false,
  },
  littledb: {
    product: 'LittleDB',
    status:
      'private source (@little-stack/littledb 0.1.0-alpha.2). Not on npm and not publicly available, so there is no public install path.',
    available: false,
  },
};

export function ProductStatus({ product }: { product: string | undefined }) {
  const entry = product === undefined ? undefined : PRODUCT_STATUS[product];
  if (entry === undefined) return null;

  return (
    <p
      className={
        entry.available
          ? 'rounded-md border px-3 py-2 text-sm text-fd-muted-foreground'
          : 'rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900/70 dark:bg-amber-950/40 dark:text-amber-200'
      }
    >
      <span className="font-medium">{entry.product}</span>: {entry.status} Sections labeled
      UNRELEASED describe source-only changes.{' '}
      <Link href="/docs/releases" className="font-medium underline underline-offset-2">
        Release status
      </Link>
    </p>
  );
}
