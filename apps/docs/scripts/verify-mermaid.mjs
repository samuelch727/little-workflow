import { chromium } from 'playwright';

const baseUrl = process.env.MERMAID_VERIFY_BASE ?? 'http://localhost:3000';

const pages = [
  { path: '/docs/v0.1.0-alpha/implementation', expect: 1 },
  { path: '/docs/v0.1.0-alpha/implementation/architecture', expect: 1 },
  { path: '/docs/v0.1.0-alpha/implementation/compile-pipeline', expect: 3 },
  { path: '/docs/v0.1.0-alpha/implementation/lwir-internals', expect: 2 },
  { path: '/docs/v0.1.0-alpha/implementation/planner-output', expect: 1 },
  { path: '/docs/v0.1.0-alpha/implementation/expressions', expect: 2 },
  { path: '/docs/v0.1.0-alpha/implementation/runtime-execution', expect: 2 },
  { path: '/docs/v0.1.0-alpha/implementation/parallel', expect: 2 },
  { path: '/docs/v0.1.0-alpha/implementation/event-log', expect: 2 },
  { path: '/docs/v0.1.0-alpha/implementation/local-world-storage', expect: 2 },
  { path: '/docs/v0.1.0-alpha/implementation/replay', expect: 1 },
  { path: '/docs/v0.1.0-alpha/implementation/ai-sdk-adapter', expect: 1 },
];

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

let failed = 0;
for (const { path, expect } of pages) {
  const url = baseUrl + path;
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    await page.waitForSelector('[aria-label="Mermaid diagram"] svg[id^="m_"]', {
      state: 'attached',
      timeout: 15_000,
    });
    await page.waitForTimeout(300);
    const wrappers = await page.locator('[aria-label="Mermaid diagram"]').count();
    // Mermaid emits <svg> with id starting with `m_` (set via our useId-derived prefix)
    const mermaidSvgs = await page.locator('[aria-label="Mermaid diagram"] svg[id^="m_"]').count();
    const errors = await page.locator('text=/Mermaid render error/').count();
    const status =
      wrappers === expect && mermaidSvgs === expect && errors === 0 ? 'ok' : 'fail';
    if (status === 'fail') failed += 1;
    console.log(
      `${status} ${path} — wrappers=${wrappers}/${expect} mermaidSvgs=${mermaidSvgs} errors=${errors}`,
    );
  } catch (cause) {
    failed += 1;
    console.log(`fail ${path} — ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

await browser.close();
process.exit(failed === 0 ? 0 : 1);
