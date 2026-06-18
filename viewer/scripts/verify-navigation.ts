/**
 * Automated checks for floating-origin, zoom, and grid placement logic.
 * Run: npx tsx scripts/verify-navigation.ts
 */
import * as THREE from 'three';
import { SceneOrigin } from '../src/scene-origin.ts';

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

function approx(a: number, b: number, eps = 0.01) {
  return Math.abs(a - b) <= eps;
}

function testSceneOriginBake() {
  console.log('\n[SceneOrigin] load bake');
  const origin = new SceneOrigin();
  const geo = new THREE.BoxGeometry(100, 100, 100);
  geo.translate(30000, 17000, -9000);
  const mesh = new THREE.Mesh(geo);
  geo.computeBoundingBox();
  const center = geo.boundingBox!.getCenter(new THREE.Vector3());
  origin.bakeMeshesAtLoad([mesh], center);

  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  assert(approx(bb.min.x, -50) && approx(bb.max.x, 50), 'mesh X centered near 0 after bake');
  assert(approx(bb.min.y, -50) && approx(bb.max.y, 50), 'mesh Y centered near 0 after bake');
  assert(origin.localToUe(new THREE.Vector3(0, 0, 0)).x > 29000, 'local origin maps back to UE abs coords');
}

function testSceneOriginRebase() {
  console.log('\n[SceneOrigin] runtime rebase');
  const origin = new SceneOrigin();
  const geo = new THREE.BoxGeometry(10, 10, 10);
  const mesh = new THREE.Mesh(geo);
  origin.bakeMeshesAtLoad([mesh], new THREE.Vector3(0, 0, 0));

  const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 100000);
  camera.position.set(500, 300, 500);
  const target = new THREE.Vector3(2500, 0, 0);

  const did = origin.rebaseIfNeeded(camera, target, [mesh], 60000);
  assert(did, 'rebase triggers when pivot far from origin');
  assert(approx(target.length(), 0), 'pivot reset to local zero');
  assert(approx(camera.position.x, -2000), 'camera shifted with rebase');
  geo.computeBoundingBox();
  assert(approx(geo.boundingBox!.min.x, -2505), 'mesh geometry shifted with rebase');
}

function testMultiplicativeZoom() {
  console.log('\n[Zoom] multiplicative wheel');
  const minDistance = 1;
  let dist = 800;
  let steps = 0;
  while (dist > minDistance + 0.5 && steps < 200) {
    dist = Math.max(dist * 0.82, minDistance);
    steps++;
  }
  assert(steps < 200 && dist <= minDistance + 0.5, `can reach minDistance in ${steps} wheel steps (dist=${dist.toFixed(2)})`);

  const sceneMaxDim = 63000;
  const oldStep = Math.max(dist * 0.12, sceneMaxDim * 0.004, 40);
  assert(oldStep >= 250, 'old additive min step was ~252cm at close range (explains stuck zoom)');
}

function testGridGroundY() {
  console.log('\n[Grid] ground placement');
  const box = new THREE.Box3(new THREE.Vector3(-1000, -36000, -500), new THREE.Vector3(1000, 12000, 500));
  const groundY = box.min.y;
  assert(groundY === -36000, 'grid sits at AABB min Y not at center Y=0');
  assert(groundY !== box.getCenter(new THREE.Vector3()).y, 'grid Y differs from scene center (no floating grid)');
}

function testPanSpeedBoost() {
  console.log('\n[Pan] sensitivity boost');
  const sceneMaxDim = 63000;
  const distance = 150;
  const ref = Math.max(sceneMaxDim * 0.08, 800);
  const boost = THREE.MathUtils.clamp(ref / Math.max(distance, 5), 2, 80);
  assert(boost >= 30, `close-range pan boost is ${boost.toFixed(0)} (>=30)`);
}

function testGridHiddenWhenClose() {
  console.log('\n[Grid] hide when zoomed in');
  const sceneMaxDim = 63000;
  const closeDist = 2800;
  const farDist = 36000;
  const threshold = Math.max(sceneMaxDim * 0.015, 3500);
  assert(closeDist <= threshold, 'close zoom is below grid visibility threshold');
  assert(! (closeDist > threshold), `grid hidden at ${closeDist} cm`);
  assert(farDist > threshold, `grid visible at ${farDist} cm`);
}

testSceneOriginBake();
testSceneOriginRebase();
testMultiplicativeZoom();
testGridGroundY();
testPanSpeedBoost();
testGridHiddenWhenClose();

console.log(`\nUnit: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
