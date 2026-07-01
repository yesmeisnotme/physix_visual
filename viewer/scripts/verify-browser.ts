/**
 * Browser E2E verification (dev server must be running on 5173).
 * Run: npx tsx scripts/verify-browser.ts
 */
import { chromium } from 'playwright';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');
const collisionBin = path.join(projectRoot, 'collision.bin');
const defaultAirWallTable = 'E:\\qsp4\\TSGame_Depot\\GameProject\\Data\\Table\\SharedTable\\Map\\1002301\\AirWallTable.xml';
const defaultAirWallBinDir = path.join(path.dirname(defaultAirWallTable), 'bin');
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

function nearly(a: number, b: number, eps = 1.5) {
  return Math.abs(a - b) <= eps;
}

const expectedAirWallCenters: Record<string, { x: number; y: number; z: number }> = {
  '1': { x: -5730, y: 9060, z: 515 },
  '2': { x: -5730, y: 9060, z: 515 },
  '3': { x: 6400, y: 9060, z: 515 },
  '4': { x: 6400, y: 6400, z: 515 },
};

type AirWallDebug = {
  meshCount: number;
  aabbs: Array<{
    id: string;
    center: { x: number; y: number; z: number };
    size: { x: number; y: number; z: number };
  }>;
  labels: Array<{
    id: string;
    text: string;
    visible: boolean;
    ue: { x: number; y: number; z: number };
  }>;
};

function assertAirWallGeometry(airWall: AirWallDebug, label: string) {
  assert(airWall.meshCount === 5, `${label}: airwall mesh count is ${airWall.meshCount} (expected 5)`);
  const counts = new Map<string, number>();
  for (const item of airWall.aabbs) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  assert(counts.get('1') === 1, `${label}: airwall #1 has 1 collision mesh`);
  assert(counts.get('2') === 2, `${label}: airwall #2 has 2 collision meshes`);
  assert(counts.get('3') === 1, `${label}: airwall #3 has 1 collision mesh`);
  assert(counts.get('4') === 1, `${label}: airwall #4 has 1 collision mesh`);

  for (const item of airWall.aabbs) {
    const expected = expectedAirWallCenters[item.id];
    assert(Boolean(expected), `${label}: airwall #${item.id} has expected config row`);
    if (!expected) continue;
    assert(
      nearly(item.center.x, expected.x) && nearly(item.center.y, expected.y) && nearly(item.center.z, expected.z),
      `${label}: airwall #${item.id} center UE (${item.center.x.toFixed(1)}, ${item.center.y.toFixed(1)}, ${item.center.z.toFixed(1)})`,
    );
    assert(
      nearly(item.size.x, 120) && nearly(item.size.y, 2000) && nearly(item.size.z, 800),
      `${label}: airwall #${item.id} size UE (${item.size.x.toFixed(1)}, ${item.size.y.toFixed(1)}, ${item.size.z.toFixed(1)})`,
    );
  }

  assert(airWall.labels.length === 4, `${label}: airwall label count is ${airWall.labels.length} (expected 4)`);
  for (const [id, expected] of Object.entries(expectedAirWallCenters)) {
    const item = airWall.labels.find((candidate) => candidate.id === id);
    assert(Boolean(item), `${label}: label for airwall #${id} exists`);
    if (!item) continue;
    assert(item.visible, `${label}: label for airwall #${id} is visible`);
    assert(item.text.includes(`#${id}`), `${label}: label text marks #${id}: ${item.text}`);
    assert(
      nearly(item.ue.x, expected.x, 3) && nearly(item.ue.y, expected.y, 3) && item.ue.z > expected.z + 350,
      `${label}: label #${id} is above matching airwall at UE (${item.ue.x.toFixed(1)}, ${item.ue.y.toFixed(1)}, ${item.ue.z.toFixed(1)})`,
    );
  }
}

async function waitForDebug(page: import('playwright').Page) {
  await page.waitForFunction(() => window.__physixDebug != null, undefined, { timeout: 15000 });
}

async function readAirWallDebug(page: import('playwright').Page): Promise<AirWallDebug> {
  return await page.evaluate(() => {
    const d = window.__physixDebug!;
    return {
      meshCount: d.getAirWallMeshCount(),
      aabbs: d.getAirWallAabbs(),
      labels: d.getAirWallLabels(),
    };
  });
}

async function interactWithAirWallScene(page: import('playwright').Page) {
  const canvas = page.locator('#canvas');
  await canvas.hover();
  await page.mouse.wheel(0, -900);
  await page.mouse.move(640, 400);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(880, 520, { steps: 12 });
  await page.mouse.up({ button: 'left' });
  await page.evaluate(() => {
    window.__physixDebug!.nudgeTarget(3000);
  });
}

async function assertAirWallFilledVisual(page: import('playwright').Page, label: string) {
  const states = await page.evaluate(() => window.__physixDebug!.getAirWallVisualStates());
  assert(states.length === 5, `${label}: airwall visual state count is ${states.length} (expected 5)`);
  for (const state of states) {
    assert(state.materialVisible, `${label}: airwall #${state.id} material is visible`);
    assert(state.transparent, `${label}: airwall #${state.id} material is transparent`);
    assert(state.opacity > 0.1, `${label}: airwall #${state.id} keeps filled faces (opacity=${state.opacity})`);
    assert(!state.depthTest, `${label}: airwall #${state.id} filled faces render as overlay`);
    assert(state.renderOrder >= 3, `${label}: airwall #${state.id} render order is above map (${state.renderOrder})`);
    assert(state.outlineVisible, `${label}: airwall #${state.id} outline is visible`);
    assert(!state.frustumCulled, `${label}: airwall #${state.id} frustum culling is disabled`);
  }
}

async function main() {
  console.log('\n[Browser] launch');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
    Object.defineProperty(window, 'showDirectoryPicker', { value: undefined, configurable: true });
  });

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

    if (fs.existsSync(defaultAirWallTable) && fs.existsSync(defaultAirWallBinDir)) {
      console.log('\n[Browser] manually select AirWallTable.xml and bin directory from sidebar');
      assert((await page.locator('#airwall-table-path').count()) === 0, 'manual UI has no AirWall path text input');
      assert((await page.locator('#airwall-bin-dir').count()) === 0, 'manual UI has no bin directory text input');
      assert((await page.locator('#airwall-table-input').count()) === 0, 'manual UI has no hidden AirWall XML upload input');
      assert((await page.locator('#airwall-bin-dir-input').count()) === 0, 'manual UI has no hidden AirWall directory upload input');
      assert((await page.locator('input[webkitdirectory], input[directory]').count()) === 0, 'manual UI has no browser directory upload input');
      assert((await page.locator('#airwall-load').count()) === 0, 'manual UI has no separate AirWall load button');
      await page.route('**/api/pick-airwall-table', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ path: defaultAirWallTable }),
        });
      });
      await page.route('**/api/pick-airwall-bin-dir', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ path: defaultAirWallBinDir }),
        });
      });
      await page.locator('#airwall-table-pick').click();
      await page.locator('#airwall-bin-pick').click();
      const selectedLabels = await page.evaluate(() => ({
        table: document.getElementById('airwall-table-selected')?.textContent ?? '',
        bin: document.getElementById('airwall-bin-selected')?.textContent ?? '',
      }));
      assert(selectedLabels.table.includes('AirWallTable.xml'), `manual UI selected XML label: ${selectedLabels.table}`);
      assert(selectedLabels.bin.includes('bin'), `manual UI selected bin directory label: ${selectedLabels.bin}`);
      await page.waitForFunction(() => window.__physixDebug?.getAirWallMeshCount() === 5, undefined, { timeout: 120000 });

      const manualAirWall = await readAirWallDebug(page);
      assertAirWallGeometry(manualAirWall, 'manual UI');
      await assertAirWallFilledVisual(page, 'manual UI surface mode');

      console.log('\n[Browser] AirWall remains filled in dashed display mode');
      await page.locator('input[name="display-mode"][value="dashed"]').check();
      await assertAirWallFilledVisual(page, 'manual UI dashed mode');

      console.log('\n[Browser] orbit, zoom and pan with AirWall loaded');
      await interactWithAirWallScene(page);
      assertAirWallGeometry(await readAirWallDebug(page), 'manual UI after interaction');
      await assertAirWallFilledVisual(page, 'manual UI dashed mode after interaction');

      console.log('\n[Browser] clear AirWall from sidebar');
      await page.locator('#airwall-clear').click();
      await page.waitForFunction(() => window.__physixDebug?.getAirWallMeshCount() === 0, undefined, { timeout: 120000 });
      const cleared = await page.evaluate(() => ({
        meshCount: window.__physixDebug!.getAirWallMeshCount(),
        labelCount: window.__physixDebug!.getAirWallLabels().length,
      }));
      assert(cleared.meshCount === 0, `manual UI: airwall mesh count after clear is ${cleared.meshCount}`);
      assert(cleared.labelCount === 0, `manual UI: airwall label count after clear is ${cleared.labelCount}`);

      console.log('\n[Browser] load map + AirWallTable.xml via URL');
      await page.goto(
        `${baseUrl}?bin=${encodeURIComponent(collisionBin)}&airwall=${encodeURIComponent(defaultAirWallTable)}&airwallbin=${encodeURIComponent(defaultAirWallBinDir)}`,
        { waitUntil: 'networkidle', timeout: 60000 },
      );
      await page.waitForFunction(() => window.__physixDebug?.getAirWallMeshCount() === 5, undefined, { timeout: 120000 });

      const urlAirWall = await readAirWallDebug(page);
      assertAirWallGeometry(urlAirWall, 'URL');

      await page.locator('input[name="display-mode"][value="dashed"]').check();
      await assertAirWallFilledVisual(page, 'URL dashed mode');

      console.log('\n[Browser] orbit, zoom and pan URL AirWall scene');
      await interactWithAirWallScene(page);
      assertAirWallGeometry(await readAirWallDebug(page), 'URL after interaction');
      await assertAirWallFilledVisual(page, 'URL dashed mode after interaction');
    } else {
      console.log(`\n[Browser] skip airwall check; missing ${defaultAirWallTable} or ${defaultAirWallBinDir}`);
    }

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
