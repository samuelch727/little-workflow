import assert from 'node:assert/strict';

// Verify the actual served site after `next build && next start`, or pass its
// deployed origin. This deliberately checks rendered links and HTTP redirects.
const origin = new URL(process.argv[2] ?? 'http://localhost:3000');
const canonicalOrigin = 'https://little-stack.dev';
const failures = [];
const pages = new Map();
let redirects = 0;
let markdownPages = 0;
let anchorLinks = 0;

async function pool(items, action) {
  let index = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (index < items.length) {
      const item = items[index++];
      try { await action(item); } catch (error) { failures.push(`${item}: ${error.message}`); }
    }
  }));
}

async function get(path, options) {
  return fetch(new URL(path, origin), { signal: AbortSignal.timeout(30_000), ...options });
}

const sitemapResponse = await get('/sitemap.xml');
assert.equal(sitemapResponse.status, 200);
const sitemap = await sitemapResponse.text();
const paths = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => {
  const url = new URL(match[1]);
  assert.equal(url.origin, canonicalOrigin, 'sitemap must use the canonical domain');
  return url.pathname;
});
assert(paths.length > 100, 'expected the complete unified documentation corpus');

await pool(paths, async (path) => {
  const response = await get(path);
  assert.equal(response.status, 200, 'page status');
  const html = await response.text();
  assert(html.includes('<h1'), 'page has a heading');
  assert(html.includes(`rel="canonical" href="${canonicalOrigin}${path === '/' ? '' : path}"`) ||
    html.includes(`rel="canonical" href="${canonicalOrigin}${path}"`), 'canonical URL');
  pages.set(path, html);
});

const internalLinks = new Set();
for (const [path, html] of pages) {
  for (const match of html.matchAll(/href="([^"<>]+)"/g)) {
    const url = new URL(match[1].replaceAll('&amp;', '&'), new URL(path, origin));
    if ((url.origin === origin.origin || url.origin === canonicalOrigin) &&
      (url.pathname === '/docs' || url.pathname.startsWith('/docs/'))) {
      internalLinks.add(url.pathname);
      if (url.hash && pages.has(url.pathname)) {
        const anchor = decodeURIComponent(url.hash.slice(1));
        const target = pages.get(url.pathname);
        anchorLinks++;
        if (!target.includes(`id="${anchor}"`) && !target.includes(`name="${anchor}"`)) {
          failures.push(`${path}: missing anchor ${url.pathname}${url.hash}`);
        }
      }
    }
  }
}
await pool([...internalLinks].filter((path) => !pages.has(path)), async (path) => {
  assert.equal((await get(path)).status, 200, 'rendered internal link resolves');
});

const migrationResponse = await get('/docs-migration.json');
assert.equal(migrationResponse.status, 200);
const migration = await migrationResponse.json();
const entries = [migration.workflow, migration.compute].flatMap((group) =>
  group.entries.filter((entry) => entry.redirected !== false));
await pool(entries, async ({ oldPath, newPath }) => {
  const response = await get(`${oldPath}?migration=check`, { redirect: 'manual' });
  assert.equal(response.status, 308, `permanent redirect for ${oldPath}`);
  const location = new URL(response.headers.get('location'), origin);
  assert.equal(location.pathname, newPath, `destination for ${oldPath}`);
  assert.equal(location.searchParams.get('migration'), 'check', 'query survives redirect');
  assert.equal((await get(newPath)).status, 200, 'redirect destination exists');
  redirects++;
});

await pool(paths.filter((path) => path.startsWith('/docs')), async (path) => {
  const response = await get(`/llms.mdx${path}/content.md`);
  assert.equal(response.status, 200, 'Markdown copy exists');
  assert((await response.text()).trim().length > 50, 'Markdown copy has content');
  markdownPages++;
});
await pool(['harness', 'workflow', 'littledb', 'compute'], async (product) => {
  const response = await get(`/api/search?query=${product}`);
  assert.equal(response.status, 200, 'search status');
  const results = await response.json();
  assert(Array.isArray(results) && results.length > 0, 'search finds product content');
  assert.equal((await get(`/og/docs/${product}/image.png`)).status, 200, 'Open Graph image');
});
for (const path of ['/llms.txt', '/llms-full.txt', '/robots.txt', '/icon.svg', '/opengraph-image']) {
  assert.equal((await get(path)).status, 200, path);
}
assert.equal((await get('/docs/this-page-does-not-exist')).status, 404, 'missing docs return 404');

console.log(JSON.stringify({ origin: origin.href, pages: pages.size, internalLinks: internalLinks.size,
  anchorLinks, markdownPages, redirects, failures }, null, 2));
assert.equal(failures.length, 0, `${failures.length} site checks failed`);
