import Link from 'next/link';
import { StackIcon, type StackIconName } from '@/components/stack-icon';

type ProductStatusEntry = {
  product: string;
  status: string;
  available: boolean;
};

// Keep these entry-point labels aligned with the release catalog.
const PRODUCT_STATUS: Record<string, ProductStatusEntry> = {
  harness: {
    product: 'Little Harness',
    status: 'On npm as @little-stack/harness 0.2.0-alpha.4 (alpha).',
    available: true,
  },
  workflow: {
    product: 'Little Workflow',
    status: 'On npm as @little-stack/workflow 0.2.0-alpha.4 (alpha).',
    available: true,
  },
  compute: {
    product: 'Little Compute',
    status: 'Not published. The control plane is frozen, so there is no public install yet.',
    available: false,
  },
  littledb: {
    product: 'LittleDB',
    status: 'Client 0.2.0-alpha.4 is published on npm and needs a LittleDB account. The server is not open source.',
    available: false,
  },
};

export function ProductStatus({ product }: { product: string | undefined }) {
  const entry = product === undefined ? undefined : PRODUCT_STATUS[product];
  if (entry === undefined) return null;

  return (
    <aside aria-label={`${entry.product} release status`} data-product={product} className={`docs-product-status ${entry.available ? '' : 'docs-product-status-private'}`}>
      <StackIcon name={product as StackIconName} size={28} />
      <p><strong>{entry.product}.</strong> {entry.status} Sections marked UNRELEASED are in the source only. <Link href="/docs/releases">Release notes</Link></p>
    </aside>
  );
}
