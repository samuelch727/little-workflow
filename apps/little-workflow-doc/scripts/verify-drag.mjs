import { chromium } from 'playwright';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();

await page.goto('http://localhost:3000/docs/v0.1.0-alpha/internals/compile-pipeline', {
  waitUntil: 'networkidle',
});
await page.waitForSelector('[aria-label="Mermaid diagram"] svg[id^="m_"]', { timeout: 30_000 });
await page.waitForTimeout(800);

const diagram = page.locator('[aria-label="Mermaid diagram"]').first();
await diagram.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);

const measure = async (label) => {
  const data = await diagram.evaluate((el) => {
    const svg = el.querySelector('svg[id^="m_"]');
    const readout = Array.from(el.querySelectorAll('span')).find((s) =>
      (s.textContent ?? '').includes('%'),
    );
    return {
      svgWidth: svg ? svg.getBoundingClientRect().width : null,
      svgInlineStyle: svg ? svg.getAttribute('style') : null,
      percentText: readout?.textContent?.trim() ?? null,
    };
  });
  console.log(`${label}: ${JSON.stringify(data)}`);
  return data;
};

await measure('initial');

const zoomIn = diagram.locator('button[aria-label="Zoom in"]').first();
for (let i = 0; i < 4; i += 1) {
  await zoomIn.click();
  await page.waitForTimeout(150);
}
const zoomed = await measure('after 4× zoom in');

// Now drag in the scroll container area (not on a button)
const box = await diagram.boundingBox();
if (!box) throw new Error('no diagram box');
const startX = box.x + box.width / 2;
const startY = box.y + box.height / 2;

console.log(`dragging from (${startX}, ${startY}) by (-200, -150)`);
await page.mouse.move(startX, startY);
await page.mouse.down();
await page.mouse.move(startX - 200, startY - 150, { steps: 20 });
await page.mouse.up();
await page.waitForTimeout(300);

const afterDrag = await measure('after drag');

const widthPreserved = afterDrag.svgWidth === zoomed.svgWidth;
const percentPreserved = afterDrag.percentText === zoomed.percentText;
console.log(`zoom preserved after drag? width=${widthPreserved} percent=${percentPreserved}`);

await page.screenshot({ path: 'scripts/drag-after.png', clip: {
  x: box.x - 10, y: box.y - 10, width: box.width + 20, height: box.height + 20,
} });

await browser.close();
process.exit(widthPreserved && percentPreserved ? 0 : 1);
