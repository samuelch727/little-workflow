import { chromium } from 'playwright';

const baseUrl = process.env.MERMAID_VERIFY_BASE ?? 'http://localhost:3000';

const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();

await page.goto(`${baseUrl}/docs/v0.1.0-alpha/getting-started`, {
  waitUntil: 'networkidle',
  timeout: 30_000,
});
await page.waitForTimeout(500);

const sidebarText = await page.locator('aside, nav').first().innerText().catch(() => '');
console.log('--- sidebar text (first 2000 chars) ---');
console.log(sidebarText.slice(0, 2000));
console.log('--- /sidebar ---');

const expected = [
  'Implementation Details',
  'Architecture',
  'Compile Pipeline',
  'LWIR Internals',
  'Planner Output Walkthrough',
  'Expressions',
  'Runtime Execution',
  'Parallel Execution',
  'Event Log',
  'Local World Storage',
  'Replay',
  'AI SDK Adapter',
];

let missing = 0;
for (const label of expected) {
  const found = sidebarText.includes(label);
  if (!found) missing += 1;
  console.log(`${found ? 'ok  ' : 'MISS'} ${label}`);
}

await browser.close();
process.exit(missing === 0 ? 0 : 1);
