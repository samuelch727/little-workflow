import { chromium } from 'playwright';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();

await page.goto('http://localhost:3000/docs/v0.1.0-alpha/implementation/compile-pipeline', {
  waitUntil: 'networkidle',
});
await page.waitForSelector('[aria-label="Mermaid diagram"] svg[id^="m_"]', { timeout: 30_000 });
await page.waitForTimeout(800);

await page.locator('[aria-label="Mermaid diagram"]').first().scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
const box = await page.locator('[aria-label="Mermaid diagram"]').first().boundingBox();
await page.screenshot({
  path: 'scripts/toolbar-normal.png',
  clip: box ? {
    x: Math.max(0, box.x - 20),
    y: Math.max(0, box.y - 20),
    width: Math.min(1600, box.width + 40),
    height: Math.min(1100, box.height + 40),
  } : undefined,
});

// Click zoom in twice
await page.locator('button[aria-label="Zoom in"]').first().click();
await page.waitForTimeout(150);
await page.locator('button[aria-label="Zoom in"]').first().click();
await page.waitForTimeout(300);
await page.screenshot({
  path: 'scripts/toolbar-zoomed.png',
  clip: box ? {
    x: Math.max(0, box.x - 20),
    y: Math.max(0, box.y - 20),
    width: Math.min(1600, box.width + 40),
    height: Math.min(1100, box.height + 40),
  } : undefined,
});

// Fullscreen
await page.locator('button[aria-label="Fullscreen"]').first().click();
await page.waitForTimeout(600);
await page.screenshot({ path: 'scripts/toolbar-fullscreen.png' });

await browser.close();
console.log('saved scripts/toolbar-{normal,zoomed,fullscreen}.png');
