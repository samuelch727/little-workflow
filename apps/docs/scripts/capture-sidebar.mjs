import { chromium } from 'playwright';

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
await page.goto('http://localhost:3000/docs/v0.1.0-alpha/implementation/compile-pipeline', {
  waitUntil: 'networkidle',
});
await page.waitForTimeout(1500);
await page.screenshot({ path: 'scripts/sidebar-screenshot.png', fullPage: false });
console.log('saved scripts/sidebar-screenshot.png');
await browser.close();
