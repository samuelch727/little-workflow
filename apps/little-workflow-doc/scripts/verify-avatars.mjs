import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

// Run against a built site. Playwright's clock exercises idle/cooldown behavior
// without making a browser wait through each 12-second expression sequence.
const origin = process.argv[2] ?? 'http://localhost:3100';
const screenshotDir = process.env.AVATAR_SCREENSHOT_DIR;
if (screenshotDir) mkdirSync(screenshotDir, { recursive: true });
const executablePath = process.env.CHROMIUM_EXECUTABLE ??
  (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
const errors = [];
const checks = [];
const names = ['brand', 'harness', 'workflow', 'littledb', 'compute'];

async function state(page) {
  return page.locator('html').getAttribute('data-avatar-motion');
}
async function activity(page, type = 'pointermove') {
  await page.evaluate((eventType) => document.dispatchEvent(new Event(eventType)), type);
}
async function ready(page) {
  await page.waitForFunction(() => document.documentElement.dataset.avatarMotionReady === 'true');
}
async function assertPlain(page) {
  assert.equal(await page.locator('[data-stack-icon]:not([data-avatar-state="plain"])').count(), 0);
  assert(await page.locator('.stack-avatar-eyes').evaluateAll((eyes) => eyes.every((eye) => getComputedStyle(eye).visibility === 'hidden')));
}
async function screenshot(page, name) {
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/${name}.png`, fullPage: true, animations: 'disabled' });
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.clock.install();
  await page.goto(origin);
  await ready(page);
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await activity(page);
  await assertPlain(page);
  for (const name of names) assert(await page.locator(`svg[data-stack-icon="${name}"]`).count() > 0, `${name} SVG is present`);
  const geometry = await page.locator('[data-stack-icon]').evaluateAll((icons) => icons.map((icon) => ({
    width: icon.getBoundingClientRect().width, height: icon.getBoundingClientRect().height,
    decorative: icon.getAttribute('aria-hidden'), viewBox: icon.getAttribute('viewBox'),
  })));
  assert(geometry.every((icon) => icon.width > 0 && icon.width === icon.height && icon.viewBox === '0 0 48 48'));
  assert(geometry.every((icon) => icon.decorative === 'true'));
  await screenshot(page, 'home-desktop-plain');

  await page.clock.runFor(4999);
  assert.equal(await state(page), 'active');
  await page.clock.runFor(2);
  assert.equal(await state(page), 'playing');
  assert(await page.locator('[data-visible="true"][data-avatar-state="playing"]').count() > 0);
  assert.equal(await page.locator('[data-visible="false"]:not([data-avatar-state="plain"])').count(), 0);
  const animations = await page.locator('[data-avatar-state="playing"]').first().evaluate((icon) =>
    [...icon.querySelectorAll('*')].map((node) => getComputedStyle(node)).filter((css) => css.animationName !== 'none')
      .map((css) => ({ count: css.animationIterationCount, duration: css.animationDuration })));
  assert(animations.length > 0 && animations.every((css) => css.count === '1' && css.duration === '12s'), 'expressions play once for 12s');
  assert(await page.locator('[data-avatar-state="playing"] .stack-avatar-eyes').evaluateAll((eyes) => eyes.every((eye) => getComputedStyle(eye).visibility === 'visible')));
  await screenshot(page, 'home-desktop-idle');
  await page.clock.runFor(12001);
  assert.equal(await state(page), 'still');
  await page.clock.runFor(120000);
  assert.equal(await state(page), 'still', 'one idle spell never loops');
  checks.push('plain initial icons; five-second idle; finite 12-second sequence; still eyes; no idle loop; offscreen icons plain');

  await activity(page, 'keydown');
  await assertPlain(page);
  await page.clock.runFor(5001);
  assert.equal(await state(page), 'playing');
  await activity(page, 'pointerdown');
  await assertPlain(page);
  await page.clock.runFor(5001);
  assert.notEqual(await state(page), 'playing', 'cooldown prevents rapid replay');
  await page.clock.runFor(67001);
  assert.equal(await state(page), 'playing', 'playback can return after cooldown and another idle spell');
  await activity(page, 'scroll');
  await assertPlain(page);
  checks.push('keyboard, pointer and scroll interrupt immediately; cooldown prevents rapid replay');

  // Media-query change events use the browser rendering cycle, not just timers.
  await page.clock.resume();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => document.documentElement.dataset.avatarMotion === 'reduced');
  assert.equal(await state(page), 'reduced');
  await page.clock.runFor(120000);
  await assertPlain(page);
  assert.equal(await page.locator('[data-stack-icon]').evaluateAll((icons) => icons.flatMap((icon) => icon.getAnimations({ subtree: true })).length), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.waitForFunction(() => document.documentElement.dataset.avatarMotion === 'active');
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  assert.equal(await state(page), 'hidden');
  await page.clock.runFor(120000);
  await assertPlain(page);
  await page.evaluate(() => {
    delete document.visibilityState;
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await assertPlain(page);
  checks.push('live reduced-motion preference changes and hidden-document events cancel motion');
  await context.close();

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'no-preference' });
  const mobilePage = await mobile.newPage();
  mobilePage.on('pageerror', (error) => errors.push(error.message));
  await mobilePage.goto(origin);
  await ready(mobilePage);
  await mobilePage.locator('.product-card').first().scrollIntoViewIfNeeded();
  await mobilePage.waitForFunction(() => document.querySelector('.product-card [data-stack-icon]')?.getAttribute('data-visible') === 'true');
  await activity(mobilePage, 'touchstart');
  await mobilePage.waitForFunction(() => document.querySelector('.product-card [data-stack-icon]')?.getAttribute('data-avatar-state') === 'playing');
  assert.equal(await mobilePage.locator('.product-card [data-stack-icon]').first().getAttribute('data-avatar-state'), 'playing');
  await screenshot(mobilePage, 'home-mobile-idle');
  await mobilePage.touchscreen.tap(5, 400);
  await assertPlain(mobilePage);
  await mobilePage.locator('.product-card').first().tap();
  await mobilePage.waitForURL('**/docs/harness');
  await mobilePage.waitForFunction(() => document.querySelector('[data-stack-icon][data-visible="true"]'));
  await assertPlain(mobilePage);
  await mobile.close();
  checks.push('mobile idle playback, real touch interruption, and icon registration after client navigation');

  for (const width of [320, 390, 768, 1440]) {
    for (const colorScheme of ['light', 'dark']) {
      const layout = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, reducedMotion: 'reduce' });
      const tab = await layout.newPage();
      tab.on('pageerror', (error) => errors.push(error.message));
      for (const path of ['/', '/docs/harness']) {
        await tab.goto(new URL(path, origin).href);
        await ready(tab);
        await assertPlain(tab);
        assert.equal(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${path} fits ${width}px ${colorScheme}`);
        assert(await tab.locator('svg[data-stack-icon]').count() > 0);
        if ([390, 1440].includes(width)) await screenshot(tab, `${path === '/' ? 'home' : 'docs'}-${width}-${colorScheme}`);
      }
      await layout.close();
    }
  }
  checks.push('home and docs at 320/390/768/1440px, light and dark, no horizontal overflow');

  const fallback = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const staticPage = await fallback.newPage();
  await staticPage.goto(origin);
  await assertPlain(staticPage);
  assert(await staticPage.locator('svg[data-stack-icon="harness"]').count() > 0);
  await fallback.close();
  checks.push('server-rendered SVGs and plain fallback work without JavaScript');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ origin, checks, pageErrors: errors }, null, 2));
} finally {
  await browser.close();
}
