import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: appName,
      url: '/',
    },
    links: [
      { text: 'Setup', url: '/docs/get-started/setup', active: 'nested-url' },
      { text: 'How they fit', url: '/docs/how-they-fit', active: 'url' },
      { text: 'Releases', url: '/docs/releases', active: 'url' },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
