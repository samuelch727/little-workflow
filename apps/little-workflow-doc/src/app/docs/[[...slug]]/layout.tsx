import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { StackIcon, type StackIconName } from '@/components/stack-icon';

const productIcons: Record<string, StackIconName> = {
  '/docs/harness': 'harness',
  '/docs/workflow': 'workflow',
  '/docs/littledb': 'littledb',
  '/docs/compute': 'compute',
};

// Each product folder (harness, workflow, compute, littledb) is a root folder
// (`"root": true` in its meta.json). Fumadocs turns root folders into sidebar
// tabs and scopes the sidebar to the root folder of the current page, so the
// full tree is passed here unchanged.
export default function Layout({ children }: LayoutProps<'/docs/[[...slug]]'>) {
  const tree = source.getPageTree();
  const brandedTree = {
    ...tree,
    children: tree.children.map((node) => {
      const product = node.type === 'folder' && node.index ? productIcons[node.index.url] : undefined;
      return product ? { ...node, icon: <StackIcon name={product} size={24} /> } : node;
    }),
  };

  return (
    <DocsLayout
      tree={brandedTree}
      {...baseOptions()}
      containerProps={{ className: 'stack-docs-layout' }}
      tabs={[
        { title: 'Overview', description: 'Get started with Little Stack', url: '/docs', icon: <StackIcon name="brand" size={24} className="stack-tab-icon" /> },
        { title: 'Little Harness', description: 'Agent runtime · published alpha', url: '/docs/harness', icon: <StackIcon name="harness" size={24} className="stack-tab-icon" /> },
        { title: 'Little Workflow', description: 'Durable workflows · published alpha', url: '/docs/workflow', icon: <StackIcon name="workflow" size={24} className="stack-tab-icon" /> },
        { title: 'LittleDB', description: 'Tracing & improvement · private source', url: '/docs/littledb', icon: <StackIcon name="littledb" size={24} className="stack-tab-icon" /> },
        { title: 'Little Compute', description: 'Workspace engine · unpublished source', url: '/docs/compute', icon: <StackIcon name="compute" size={24} className="stack-tab-icon" /> },
      ]}
      sidebar={{ footer: <Link className="sidebar-start-link" href="/docs/get-started/setup"><span>Start a project<small>The guided setup</small></span><ArrowUpRight size={16} aria-hidden="true" /></Link> }}
    >
      <a className="skip-link" href="#nd-page">Skip to content</a>
      {children}
    </DocsLayout>
  );
}
