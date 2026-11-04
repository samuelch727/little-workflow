import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// Pages of the standalone Little Compute docs site, which used top-level
// /docs/<page> URLs. None collides with a shared page on this site.
const legacyComputePages = [
  'architecture',
  'artifacts',
  'cli',
  'concepts',
  'http-api',
  'planned-enforcement',
  'providers',
  'recovery',
  'runtime-io',
  'self-hosting',
  'topology-credential-worker',
];
const computePage = `:page(${legacyComputePages.join('|')})`;

/**
 * Old Little Workflow URLs on this host, and old Little Compute page names, moved
 * under product roots when the sites were combined. Order matters: the first
 * matching rule wins, so the LittleDB and version-root exceptions come before the
 * broad Workflow rules. The full map is in public/docs-migration.json.
 *
 * `/docs` itself is intentionally not redirected: it is now the family index.
 */
async function redirects() {
  return [
    // LittleDB moved to its own root.
    {
      source: '/docs/v0.1.0-alpha/running/using-littledb',
      destination: '/docs/littledb/workflow',
      permanent: true,
    },
    {
      source: '/llms.mdx/docs/v0.1.0-alpha/running/using-littledb/content.md',
      destination: '/llms.mdx/docs/littledb/workflow/content.md',
      permanent: true,
    },
    {
      source: '/og/docs/v0.1.0-alpha/running/using-littledb/image.png',
      destination: '/og/docs/littledb/workflow/image.png',
      permanent: true,
    },

    // The old Workflow version root never had a page; send it to the overview.
    {
      source: '/docs/v0.1.0-alpha',
      destination: '/docs/workflow/v0.1.0-alpha/getting-started',
      permanent: true,
    },

    // Old Little Workflow pages.
    {
      source: '/docs/v0.1.0-alpha/:path*',
      destination: '/docs/workflow/v0.1.0-alpha/:path*',
      permanent: true,
    },
    {
      source: '/docs/comparisons/:path*',
      destination: '/docs/workflow/comparisons/:path*',
      permanent: true,
    },
    {
      source: '/llms.mdx/docs/v0.1.0-alpha/:path*',
      destination: '/llms.mdx/docs/workflow/v0.1.0-alpha/:path*',
      permanent: true,
    },
    {
      source: '/llms.mdx/docs/comparisons/:path*',
      destination: '/llms.mdx/docs/workflow/comparisons/:path*',
      permanent: true,
    },
    {
      source: '/og/docs/v0.1.0-alpha/:path*',
      destination: '/og/docs/workflow/v0.1.0-alpha/:path*',
      permanent: true,
    },
    {
      source: '/og/docs/comparisons/:path*',
      destination: '/og/docs/workflow/comparisons/:path*',
      permanent: true,
    },

    // Old Little Compute page names.
    {
      source: `/docs/${computePage}`,
      destination: '/docs/compute/:page',
      permanent: true,
    },
    {
      source: `/llms.mdx/docs/${computePage}/:rest*`,
      destination: '/llms.mdx/docs/compute/:page/:rest*',
      permanent: true,
    },
    {
      source: `/og/docs/${computePage}/:rest*`,
      destination: '/og/docs/compute/:page/:rest*',
      permanent: true,
    },
  ];
}

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  allowedDevOrigins: ['192.168.50.47'],
  redirects,
};

export default withMDX(config);
