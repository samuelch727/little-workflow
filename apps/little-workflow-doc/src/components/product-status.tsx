import Link from 'next/link';
import { CircleCheck, Info } from 'lucide-react';

type ProductStatusEntry = {
  product: string;
  status: string;
  available: boolean;
};

// Keep these entry-point labels aligned with the release catalog.
const PRODUCT_STATUS: Record<string, ProductStatusEntry> = {
  harness: {
    product: 'Little Harness',
    status: '@little-stack/harness · 0.2.0-alpha.3 · alpha release.',
    available: true,
  },
  workflow: {
    product: 'Little Workflow',
    status: '@little-stack/workflow · 0.2.0-alpha.3 · alpha release.',
    available: true,
  },
  compute: {
    product: 'Little Compute',
    status:
      'Unpublished workspace engine; control plane frozen. No public install path.',
    available: false,
  },
  littledb: {
    product: 'LittleDB',
    status:
      'Private source (@little-stack/littledb 0.1.0-alpha.2). No public install path.',
    available: false,
  },
};

export function ProductStatus({ product }: { product: string | undefined }) {
  const entry = product === undefined ? undefined : PRODUCT_STATUS[product];
  if (entry === undefined) return null;

  return (
    <aside aria-label={`${entry.product} release status`} className={`docs-product-status ${entry.available ? '' : 'docs-product-status-private'}`}>
      {entry.available ? <CircleCheck size={15} aria-hidden="true" /> : <Info size={15} aria-hidden="true" />}
      <div><strong>{entry.product}</strong> — {entry.status} Sections marked UNRELEASED are source-only.{' '}<Link href="/docs/releases">Release details</Link></div>
    </aside>
  );
}
