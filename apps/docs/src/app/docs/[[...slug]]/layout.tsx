import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';
import { VersionSwitcher } from '@/components/version-switcher';
import type { Folder, Root } from 'fumadocs-core/page-tree';

const VERSION_SLUGS = ['v0.1.0-alpha', 'v0.1.0-beta', 'v0.1.0', 'v0.2.0', 'v1.0.0'];
const DEFAULT_VERSION_SLUG = 'v0.1.0-alpha';

function getVersionTree(root: Root, versionSlug: string): Root {
  const versionNode = root.children.find((child): child is Folder => {
    return child.type === 'folder' && typeof child.name === 'string' && child.name === versionSlug;
  });
  if (!versionNode) return root;
  return {
    ...root,
    name: versionNode.name,
    children: versionNode.children,
  };
}

export default async function Layout({
  children,
  params,
}: LayoutProps<'/docs/[[...slug]]'>) {
  const { slug } = await params;
  const first = slug?.[0];
  const activeVersion =
    first && VERSION_SLUGS.includes(first) ? first : DEFAULT_VERSION_SLUG;
  const tree = getVersionTree(source.getPageTree(), activeVersion);

  return (
    <DocsLayout
      tree={tree}
      sidebar={{ banner: <VersionSwitcher key="version-switcher" /> }}
      {...baseOptions()}
    >
      {children}
    </DocsLayout>
  );
}
