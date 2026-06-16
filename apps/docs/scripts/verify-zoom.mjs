import { chromium } from 'playwright';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();

await page.goto('http://localhost:3000/docs/v0.1.0-alpha/implementation/compile-pipeline', {
  waitUntil: 'networkidle',
});
await page.waitForSelector('[aria-label="Mermaid diagram"] svg[id^="m_"]', { timeout: 30_000 });
await page.waitForTimeout(800);

const diagram = page.locator('[aria-label="Mermaid diagram"]').first();
await diagram.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);

const box = await diagram.boundingBox();
const clip = box && {
  x: Math.max(0, box.x - 10),
  y: Math.max(0, box.y - 10),
  width: Math.min(1400, box.width + 20),
  height: Math.min(900, box.height + 20),
};

await page.screenshot({ path: 'scripts/zoom-100.png', clip });

const zoomIn = diagram.locator('button[aria-label="Zoom in"]').first();
for (let i = 0; i < 4; i += 1) {
  await zoomIn.click();
  await page.waitForTimeout(120);
}
await page.screenshot({ path: 'scripts/zoom-after-4x.png', clip });

const svgAttrs = await diagram.evaluate((el) => {
  const svg = el.querySelector('svg[id^="m_"]');
  if (svg === null) return null;
  const cs = getComputedStyle(svg);
  const parent = svg.parentElement;
  const pcs = parent ? getComputedStyle(parent) : null;
  return {
    width: svg.getAttribute('width'),
    style: svg.getAttribute('style'),
    viewBox: svg.getAttribute('viewBox'),
    bcr: svg.getBoundingClientRect(),
    computed_width: cs.width,
    computed_max_width: cs.maxWidth,
    computed_zoom: cs.zoom,
    parent_class: parent?.className?.toString(),
    parent_computed_width: pcs?.width,
    parent_computed_zoom: pcs?.zoom,
  };
});
console.log(`mermaid svg attrs: ${JSON.stringify(svgAttrs, null, 2)}`);

const innerStyle = await diagram.evaluate((el) => {
  const inner = el.querySelector('[style*="zoom"]');
  if (inner === null) return null;
  return {
    style: (inner).getAttribute('style'),
    width: inner.getBoundingClientRect().width,
    height: inner.getBoundingClientRect().height,
  };
});
console.log(`inner after 4× zoom in: ${JSON.stringify(innerStyle)}`);

const svgBox = await diagram.locator('svg[id^="m_"]').first().boundingBox();
console.log(`mermaid svg box: ${JSON.stringify(svgBox)}`);

await browser.close();
