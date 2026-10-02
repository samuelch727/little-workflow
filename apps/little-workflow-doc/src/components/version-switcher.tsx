'use client';

import { ChevronsUpDown, Tag } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo } from 'react';

type Version = {
  label: string;
  version: string;
  slug: string;
};

const versions: Version[] = [
  { label: 'Latest', version: 'v0.1.0-alpha', slug: 'v0.1.0-alpha' },
];

function getActiveVersion(pathname: string): Version {
  const segments = pathname.split('/').filter(Boolean);
  const docsIdx = segments.indexOf('docs');
  const versionSegment = docsIdx >= 0 ? segments[docsIdx + 1] : undefined;
  return versions.find((v) => v.slug === versionSegment) ?? versions[0];
}

export function VersionSwitcher() {
  const pathname = usePathname();
  const router = useRouter();
  const selected = useMemo(() => getActiveVersion(pathname), [pathname]);

  return (
    <label className="relative mb-4 flex min-h-14 cursor-pointer items-center gap-3 rounded-lg border bg-fd-card px-3 py-2 text-sm shadow-sm transition-colors hover:bg-fd-accent/60">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-900/70 dark:bg-blue-950/50 dark:text-blue-300">
        <Tag className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-fd-foreground">{selected.label}</span>
        <span className="block truncate text-xs text-fd-muted-foreground">{selected.version}</span>
      </span>
      <ChevronsUpDown className="size-4 shrink-0 text-fd-muted-foreground" />
      <select
        aria-label="Select documentation version"
        className="absolute inset-0 cursor-pointer opacity-0"
        value={selected.slug}
        onChange={(event) => {
          const slug = event.target.value;
          // The version root has no index page; Overview lives under getting-started.
          router.push(`/docs/${slug}/getting-started`);
        }}
      >
        {versions.map((version) => (
          <option key={version.slug} value={version.slug}>
            {version.label} - {version.version}
          </option>
        ))}
      </select>
    </label>
  );
}
