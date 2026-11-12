import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { gitConfig } from './shared';
import { StackBrand } from '@/components/stack-brand';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <StackBrand />,
      url: '/',
    },
    links: [
      { text: 'Documentation', url: '/docs', active: 'url' },
      { text: 'How they fit', url: '/docs/how-they-fit', active: 'url' },
      { text: 'Releases', url: '/docs/releases', active: 'url' },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    searchToggle: { full: { className: 'stack-search-trigger' } },
  };
}
