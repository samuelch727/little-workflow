import { source } from '@/lib/source';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { baseOptions } from '@/lib/layout.shared';

// Each product folder (harness, workflow, compute, littledb) is a root folder
// (`"root": true` in its meta.json). Fumadocs turns root folders into sidebar
// tabs and scopes the sidebar to the root folder of the current page, so the
// full tree is passed here unchanged.
export default function Layout({ children }: LayoutProps<'/docs/[[...slug]]'>) {
  return (
    <DocsLayout tree={source.getPageTree()} {...baseOptions()}>
      {children}
    </DocsLayout>
  );
}
