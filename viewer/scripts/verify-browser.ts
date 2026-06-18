/**
 * Browser E2E verification (dev server must be running on 5173).
 * Run: npx tsx scripts/verify-browser.ts
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const collisionBin = path.join(projectRoot, 'collision.bin');
const baseUrl = 'http://127.0.0.1:5173';

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  OK  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

async function waitForDebug(page: import('playwright').Page) {
  await page.waitForFunction(() => window.__physixDebug != null, undefined, { timeout: 15000 });
}

async function main() {
  console.log('\n[Browser] launch');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 });
    await waitForDebug(page);

    console.log('\n[Browser] load collision.bin via ?bin=');
    await page.goto(`${baseUrl}?bin=${encodeURIComponent(collisionBin)}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(() => window.__physixDebug?.isSceneLoaded() === true, undefined, { timeout: 120000 });

    const stats = await page.evaluate(() => {
      const d = window.__physixDebug!;
      return {
        dist: d.getDist(),
        gridY: d.getGridY(),
        boxMinY: d.getBoxMinY(),
        panSpeed: d.getPanSpeed(),
        originLen: d.getOriginOffsetLen(),
      };
    });

    console.log('\n[Browser] scene stats', stats);
    assert(stats.dist > 100, `initial camera distance ${stats.dist.toFixed(0)} cm`);
    assert(stats.gridY != null && Math.abs(stats.gridY! - stats.boxMinY) < 1, `grid Y (${stats.gridY}) matches ground minY (${stats.boxMinY})`);
    assert(stats.panSpeed >= 2, `pan speed ${stats.panSpeed}`);

    console.log('\n[Browser] zoom in 12 steps');
    const zoomResult = await page.evaluate(() => {
      const d = window.__physixDebug!;
      const start = d.getDist();
      for (let i = 0; i < 12; i++) d.zoomIn();
      const end = d.getDist();
      return { start, end };
    });
    assert(zoomResult.end < zoomResult.start * 0.2, `zoom in: ${zoomResult.start.toFixed(0)} -> ${zoomResult.end.toFixed(0)} cm`);
    assert(zoomResult.end > 1, `can zoom closer than ${zoomResult.end.toFixed(1)} cm without stuck at old floor`);

    console.log('\n[Browser] pan via target nudge + rebase');
    const panResult = await page.evaluate(() => {
      const d = window.__physixDebug!;
      const originBefore = d.getOriginOffsetLen();
      d.nudgeTarget(3000);
      return {
        tx: d.getTargetX(),
        originAfter: d.getOriginOffsetLen(),
        originBefore,
      };
    });
    assert(
      panResult.originAfter > panResult.originBefore + 800,
      `origin offset grew after pan rebase (${panResult.originBefore.toFixed(0)} -> ${panResult.originAfter.toFixed(0)})`,
    );
    assert(Math.abs(panResult.tx) < 500, `floating origin rebase pulled target back (${panResult.tx.toFixed(0)})`);

    console.log('\n[Browser] grid hidden when close');
    const gridVis = await page.evaluate(() => {
      const d = window.__physixDebug!;
      return { visible: d.getGridVisible(), dist: d.getDist() };
    });
    assert(!gridVis.visible, `grid hidden at dist=${gridVis.dist.toFixed(0)}`);

    console.log('\n[Browser] context menu blocked');
    const ctx = page.locator('#canvas');
    const menuPromise = page.waitForEvent('dialog', { timeout: 500 }).catch(() => null);
    await ctx.click({ button: 'right' });
    const menu = await menuPromise;
    assert(menu == null, 'no dialog on right-click');
  } finally {
    await browser.close();
  }

  console.log(`\nBrowser: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
