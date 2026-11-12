import type { MetadataRoute } from 'next';
import { source } from '@/lib/source';
import { siteUrl } from '@/lib/shared';

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: siteUrl, priority: 1 },
    ...source.getPages().map((page) => ({
      url: new URL(page.url, siteUrl).href,
      priority: page.slugs.length < 2 ? 0.8 : 0.6,
    })),
  ];
}
