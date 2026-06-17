import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { formatUe, parseNumInput, ueToViewer, viewerToUe } from './coords';
import {
  type DisplayMode,
  applyDisplayModeToMesh,
  attachDashedOutline,
  getAdaptiveDashSizes,
  rebuildPivotCross,
  setMeshHighlight,
} from './display-mode';

const TYPE_LABELS: Record<string, string> = {
  box: 'Box',
  sphere: 'Sphere',
  capsule: 'Capsule',
  convex_mesh: 'ConvexMesh',
  heightfield: 'HeightField',
  triangle_mesh: 'TriangleMesh',
  plane: 'Plane',
  unknown: 'Unknown',
};

/** Per-type colors (hex). HF vs Convex etc. are visually distinct. */
const TYPE_COLORS: Record<string, number> = {
  heightfield: 0x33d966,
  convex_mesh: 0x3388ff,
  triangle_mesh: 0x9aa0a6,
  box: 0xffb020,
  sphere: 0xff6688,
  capsule: 0xb366ff,
  plane: 0x33cccc,
  unknown: 0xd0d4dc,
};

function colorHexForType(type: string): number {
  return TYPE_COLORS[type] ?? TYPE_COLORS.unknown;
}

function colorCssForType(type: string): string {
  return `#${colorHexForType(type).toString(16).padStart(6, '0')}`;
}

function applyMeshTypeColor(mesh: THREE.Mesh, shapeType: string) {
  const hex = colorHexForType(shapeType);
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const raw of mats) {
    const mat = raw as THREE.MeshStandardMaterial;
    if (!mat?.isMaterial) continue;
    mat.color.setHex(hex);
    mat.emissive.setHex(0x000000);
    mat.metalness = 0;
    mat.roughness = 0.82;
    mat.transparent = true;
    mat.opacity = 0.78;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.needsUpdate = true;
  }
  mesh.userData.baseColor = hex;
  attachDashedOutline(mesh, hex);
}

interface MeshEntry {
  mesh: THREE.Mesh;
  shapeType: string;
  isTrigger: boolean;
  id: string;
}

interface ConvertResult {
  url: string;
  source: string;
  cached?: boolean;
}

const canvas = document.getElementById('canvas') as HTMLCanvasElement;
const statsEl = document.getElementById('stats')!;
const selectionEl = document.getElementById('selection')!;
const typeFiltersEl = document.getElementById('type-filters')!;
const displayModeInputs = document.querySelectorAll<HTMLInputElement>('input[name="display-mode"]');
const showTriggersCb = document.getElementById('show-triggers') as HTMLInputElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const openBtn = document.getElementById('open-btn') as HTMLButtonElement;
const loadingEl = document.getElementById('loading')!;
const loadingTextEl = document.getElementById('loading-text')!;
const sourceEl = document.getElementById('source')!;
const guideXInput = document.getElementById('guide-x') as HTMLInputElement;
const guideYInput = document.getElementById('guide-y') as HTMLInputElement;
const guideShowCb = document.getElementById('guide-show') as HTMLInputElement;
const guideApplyBtn = document.getElementById('guide-apply') as HTMLButtonElement;
const guidePickBtn = document.getElementById('guide-pick') as HTMLButtonElement;
const pivotXInput = document.getElementById('pivot-x') as HTMLInputElement;
const pivotYInput = document.getElementById('pivot-y') as HTMLInputElement;
const pivotZInput = document.getElementById('pivot-z') as HTMLInputElement;
const pivotApplyBtn = document.getElementById('pivot-apply') as HTMLButtonElement;
const pivotPickBtn = document.getElementById('pivot-pick') as HTMLButtonElement;
const pivotClearBtn = document.getElementById('pivot-clear') as HTMLButtonElement;
const pivotInfoEl = document.getElementById('pivot-info')!;
const pickHintEl = document.getElementById('pick-hint')!;
const segAxInput = document.getElementById('seg-ax') as HTMLInputElement;
const segAyInput = document.getElementById('seg-ay') as HTMLInputElement;
const segAzInput = document.getElementById('seg-az') as HTMLInputElement;
const segBxInput = document.getElementById('seg-bx') as HTMLInputElement;
const segByInput = document.getElementById('seg-by') as HTMLInputElement;
const segBzInput = document.getElementById('seg-bz') as HTMLInputElement;
const segApplyBtn = document.getElementById('seg-apply') as HTMLButtonElement;
const segPickABtn = document.getElementById('seg-pick-a') as HTMLButtonElement;
const segPickBBtn = document.getElementById('seg-pick-b') as HTMLButtonElement;
const segShowCb = document.getElementById('seg-show') as HTMLInputElement;
const segClearBtn = document.getElementById('seg-clear') as HTMLButtonElement;
const segInfoEl = document.getElementById('seg-info')!;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1a1d24);

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 10, 500000);
const initialCameraPos = new THREE.Vector3(80000, 60000, 80000);
camera.position.copy(initialCameraPos);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.sortObjects = true;

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false;
controls.target.set(0, 0, 0);
controls.update();

const overlays = new THREE.Group();
overlays.name = 'overlays';
scene.add(overlays);

const guideGroup = new THREE.Group();
guideGroup.name = 'guide_lines';
overlays.add(guideGroup);

const segmentGroup = new THREE.Group();
segmentGroup.name = 'segment_lines';
overlays.add(segmentGroup);

const pivotCrossGroup = new THREE.Group();
pivotCrossGroup.name = 'pivot_cross';
pivotCrossGroup.visible = false;
overlays.add(pivotCrossGroup);

let customPivotActive = false;
let guideUeX: number | null = null;
let guideUeY: number | null = null;
let sceneLoaded = false;
let displayMode: DisplayMode = 'surface';
type PickMode = 'none' | 'guide' | 'pivot' | 'segment-a' | 'segment-b';
let pickMode: PickMode = 'none';

interface UePos {
  x: number;
  y: number;
  z: number;
}

let segmentA: UePos | null = null;
let segmentB: UePos | null = null;

const grid = new THREE.GridHelper(200000, 200, 0x444444, 0x2a2a2a);
grid.position.y = 0;
scene.add(grid);

const axes = new THREE.AxesHelper(5000);
scene.add(axes);

const ambient = new THREE.AmbientLight(0xffffff, 0.65);
scene.add(ambient);
const dir = new THREE.DirectionalLight(0xffffff, 0.85);
dir.position.set(50000, 80000, 40000);
scene.add(dir);

const root = new THREE.Group();
root.name = 'collision_root';
scene.add(root);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const meshEntries: MeshEntry[] = [];
let selectedMesh: THREE.Mesh | null = null;
let typeFilterState: Record<string, boolean> = {};
let loading = false;

function setLoading(on: boolean, text = '正在转换 collision.bin…') {
  loading = on;
  loadingTextEl.textContent = text;
  loadingEl.classList.toggle('hidden', !on);
  openBtn.disabled = on;
}

function showSource(source: string, cached?: boolean) {
  const name = source.split(/[/\\]/).pop() ?? source;
  sourceEl.classList.remove('hidden');
  sourceEl.innerHTML = `
    <div class="source-title">当前文件</div>
    <div class="source-name" title="${source}">${name}</div>
    <div class="source-meta">${cached ? '来自缓存' : '已转换'} · 原始文件未修改</div>
  `;
}

function showError(message: string) {
  statsEl.innerHTML = `<p class="error">${message}</p>`;
}

function clearScene() {
  while (root.children.length) {
    const child = root.children[0];
    root.remove(child);
    child.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
      if (obj instanceof THREE.LineSegments || obj instanceof THREE.Line) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
        else obj.material.dispose();
      }
    });
  }
  meshEntries.length = 0;
  selectedMesh = null;
  selectionEl.classList.add('hidden');
  sceneLoaded = false;
  setPickMode('none');
}

function computeStats() {
  const box = new THREE.Box3();
  let triangles = 0;
  const typeCounts: Record<string, number> = {};

  for (const entry of meshEntries) {
    if (!entry.mesh.visible) continue;
    box.expandByObject(entry.mesh);
    const geo = entry.mesh.geometry;
    if (geo.index) triangles += geo.index.count / 3;
    else triangles += geo.attributes.position.count / 3;
    typeCounts[entry.shapeType] = (typeCounts[entry.shapeType] ?? 0) + 1;
  }

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  return { box, center, size, triangles, typeCounts, meshCount: meshEntries.length };
}

function sceneVerticalSpan(): { yMin: number; yMax: number } {
  const s = computeStats();
  if (s.box.isEmpty()) return { yMin: -50000, yMax: 50000 };
  const pad = Math.max(500, Math.max(s.size.x, s.size.y, s.size.z) * 0.05);
  return { yMin: s.box.min.y - pad, yMax: s.box.max.y + pad };
}

function clearGuideLines() {
  while (guideGroup.children.length) {
    const child = guideGroup.children[0];
    guideGroup.remove(child);
    if (child instanceof THREE.Line || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
  }
}

function rebuildGuideLine() {
  clearGuideLines();
  if (!guideShowCb.checked || guideUeX === null || guideUeY === null) return;

  const { yMin, yMax } = sceneVerticalSpan();
  const x = guideUeX;
  const z = -guideUeY;
  const points = [new THREE.Vector3(x, yMin, z), new THREE.Vector3(x, yMax, z)];
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const line = new THREE.Line(
    geo,
    new THREE.LineBasicMaterial({ color: 0xff4444, depthTest: false, transparent: true, opacity: 0.95 }),
  );
  line.renderOrder = 998;
  guideGroup.add(line);

  const s = computeStats();
  const groundY = s.box.isEmpty() ? 0 : s.box.min.y;
  const crossSize = Math.max(200, (yMax - yMin) * 0.015);
  const crossPts = [
    new THREE.Vector3(x - crossSize, groundY, z),
    new THREE.Vector3(x + crossSize, groundY, z),
    new THREE.Vector3(x, groundY, z - crossSize),
    new THREE.Vector3(x, groundY, z + crossSize),
  ];
  const crossGeo = new THREE.BufferGeometry().setFromPoints(crossPts);
  const cross = new THREE.LineSegments(
    crossGeo,
    new THREE.LineBasicMaterial({ color: 0xff8888, depthTest: false, transparent: true, opacity: 0.85 }),
  );
  cross.renderOrder = 997;
  guideGroup.add(cross);
}

function clearSegmentLine() {
  while (segmentGroup.children.length) {
    const child = segmentGroup.children[0];
    segmentGroup.remove(child);
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
      else child.material.dispose();
    } else if (child instanceof THREE.Points) {
      child.geometry.dispose();
      if (child.material !== highlightPointMat) (child.material as THREE.Material).dispose();
    } else if (child instanceof THREE.Line || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
  }
}

function readUePos(ax: HTMLInputElement, ay: HTMLInputElement, az: HTMLInputElement): UePos | null {
  const x = parseNumInput(ax.value);
  const y = parseNumInput(ay.value);
  const z = parseNumInput(az.value);
  if (x === null || y === null || z === null) return null;
  return { x, y, z };
}

function writeUePos(pos: UePos, ax: HTMLInputElement, ay: HTMLInputElement, az: HTMLInputElement) {
  ax.value = pos.x.toFixed(1);
  ay.value = pos.y.toFixed(1);
  az.value = pos.z.toFixed(1);
}

function ueDistance(a: UePos, b: UePos): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function addEndpointMarker(viewerPos: THREE.Vector3, color: number, size: number) {
  const arm = size * 0.5;
  const pts = [
    new THREE.Vector3(viewerPos.x - arm, viewerPos.y, viewerPos.z),
    new THREE.Vector3(viewerPos.x + arm, viewerPos.y, viewerPos.z),
    new THREE.Vector3(viewerPos.x, viewerPos.y - arm, viewerPos.z),
    new THREE.Vector3(viewerPos.x, viewerPos.y + arm, viewerPos.z),
    new THREE.Vector3(viewerPos.x, viewerPos.y, viewerPos.z - arm),
    new THREE.Vector3(viewerPos.x, viewerPos.y, viewerPos.z + arm),
  ];
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const cross = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.9 }),
  );
  cross.renderOrder = 996;
  segmentGroup.add(cross);
}

const segDir = new THREE.Vector3();

function dedupeSegmentHits(
  points: THREE.Vector3[],
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  length: number,
  eps: number,
): THREE.Vector3[] {
  const sorted = points
    .map((p) => ({ p, t: p.clone().sub(origin).dot(dir) }))
    .filter(({ t }) => t >= -eps && t <= length + eps)
    .sort((a, b) => a.t - b.t);
  const out: THREE.Vector3[] = [];
  for (const { p } of sorted) {
    if (!out.length || p.distanceTo(out[out.length - 1]) >= eps) out.push(p);
  }
  return out;
}

function computeSegmentIntersections(va: THREE.Vector3, vb: THREE.Vector3): THREE.Vector3[] {
  const meshes = meshEntries.filter((m) => m.mesh.visible).map((m) => m.mesh);
  if (!meshes.length) return [];

  segDir.subVectors(vb, va);
  const length = segDir.length();
  if (length < 1e-6) return [];
  segDir.divideScalar(length);

  raycaster.near = 0;
  raycaster.far = length;
  raycaster.set(va, segDir);
  const hits = raycaster.intersectObjects(meshes, false);
  const eps = Math.max(2, length * 0.001);
  const points = hits.map((h) => h.point.clone());
  return dedupeSegmentHits(points, va, segDir, length, eps);
}

let highlightPointTex: THREE.CanvasTexture | null = null;
let highlightPointMat: THREE.PointsMaterial | null = null;

function getHighlightPointTexture(): THREE.CanvasTexture {
  if (highlightPointTex) return highlightPointTex;
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 32;
  const ctx = canvas.getContext('2d')!;
  const grd = ctx.createRadialGradient(16, 16, 0, 16, 16, 16);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,240,120,1)');
  grd.addColorStop(0.55, 'rgba(255,120,200,0.85)');
  grd.addColorStop(1, 'rgba(255,80,160,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 32, 32);
  highlightPointTex = new THREE.CanvasTexture(canvas);
  highlightPointTex.needsUpdate = true;
  return highlightPointTex;
}

function getHighlightPointMaterial(): THREE.PointsMaterial {
  if (highlightPointMat) return highlightPointMat;
  highlightPointMat = new THREE.PointsMaterial({
    map: getHighlightPointTexture(),
    color: 0xffffff,
    size: 10,
    sizeAttenuation: false,
    depthTest: false,
    transparent: true,
    opacity: 1,
    blending: THREE.AdditiveBlending,
    alphaTest: 0.05,
  });
  return highlightPointMat;
}

function addIntersectionMarkers(points: THREE.Vector3[]) {
  if (!points.length) return;
  const geo = new THREE.BufferGeometry().setFromPoints(points);
  const dots = new THREE.Points(geo, getHighlightPointMaterial());
  dots.renderOrder = 998;
  segmentGroup.add(dots);
}

function rebuildSegmentLine() {
  clearSegmentLine();
  if (!segShowCb.checked || !segmentA || !segmentB) {
    segInfoEl.textContent = '—';
    return;
  }

  const va = ueToViewer(segmentA.x, segmentA.y, segmentA.z);
  const vb = ueToViewer(segmentB.x, segmentB.y, segmentB.z);
  const geo = new THREE.BufferGeometry().setFromPoints([va, vb]);
  const line = new THREE.Line(
    geo,
    new THREE.LineBasicMaterial({ color: 0x44ddff, depthTest: false, transparent: true, opacity: 0.98 }),
  );
  line.renderOrder = 995;
  segmentGroup.add(line);

  const s = computeStats();
  const markerSize = s.box.isEmpty() ? 400 : Math.max(150, Math.max(s.size.x, s.size.y, s.size.z) * 0.006);
  addEndpointMarker(va, 0x66eeff, markerSize);
  addEndpointMarker(vb, 0xffcc44, markerSize);

  const hits = sceneLoaded ? computeSegmentIntersections(va, vb) : [];
  addIntersectionMarkers(hits);

  const dist = ueDistance(segmentA, segmentB);
  const hitPart = hits.length ? ` · 交点 ${hits.length} 个` : '';
  segInfoEl.textContent = `长度 ${dist.toFixed(1)} cm${hitPart} · A${formatUe(new THREE.Vector3(segmentA.x, segmentA.y, segmentA.z))} → B${formatUe(new THREE.Vector3(segmentB.x, segmentB.y, segmentB.z))}`;
  segInfoEl.classList.remove('error');
}

function applySegmentAtUe(a: UePos, b: UePos) {
  segmentA = a;
  segmentB = b;
  writeUePos(a, segAxInput, segAyInput, segAzInput);
  writeUePos(b, segBxInput, segByInput, segBzInput);
  segShowCb.checked = true;
  rebuildSegmentLine();
  segInfoEl.classList.remove('error');
}

function applySegmentFromInputs() {
  if (!requireScene('设置两点连线')) return;
  const a = readUePos(segAxInput, segAyInput, segAzInput);
  const b = readUePos(segBxInput, segByInput, segBzInput);
  if (!a || !b) {
    segShowCb.checked = false;
    segmentA = null;
    segmentB = null;
    clearSegmentLine();
    segInfoEl.textContent = '请填写 Pos A 与 Pos B 的完整 UE 坐标';
    segInfoEl.classList.add('error');
    return;
  }
  applySegmentAtUe(a, b);
}

function clearSegment() {
  segmentA = null;
  segmentB = null;
  segShowCb.checked = false;
  segAxInput.value = '';
  segAyInput.value = '';
  segAzInput.value = '';
  segBxInput.value = '';
  segByInput.value = '';
  segBzInput.value = '';
  clearSegmentLine();
  segInfoEl.textContent = '—';
  segInfoEl.classList.remove('error');
}

function showWelcome() {
  statsEl.innerHTML = `
    <p>请先点击「打开 collision.bin」加载地图。</p>
    <p class="field-hint" style="margin-top:8px">加载后可输入坐标，或使用「场景中拾取」设置辅助线、两点连线与视角中心。</p>
  `;
}

function hasScene(): boolean {
  return sceneLoaded && meshEntries.length > 0;
}

function requireScene(action: string): boolean {
  if (hasScene()) return true;
  pivotInfoEl.textContent = `请先加载 collision.bin，再${action}`;
  pivotInfoEl.classList.add('error');
  return false;
}

function setPickMode(mode: PickMode) {
  pickMode = mode;
  controls.enabled = mode === 'none';
  guidePickBtn.classList.toggle('active-pick', mode === 'guide');
  pivotPickBtn.classList.toggle('active-pick', mode === 'pivot');
  segPickABtn.classList.toggle('active-pick', mode === 'segment-a');
  segPickBBtn.classList.toggle('active-pick', mode === 'segment-b');
  canvas.classList.toggle('pick-mode', mode !== 'none');
  if (mode === 'guide') {
    pickHintEl.textContent = '在场景中点击：拾取辅助线 X/Y（Esc 取消）';
    pickHintEl.classList.remove('hidden');
  } else if (mode === 'pivot') {
    pickHintEl.textContent = '在场景中点击：设视角中心（Esc 取消）';
    pickHintEl.classList.remove('hidden');
  } else if (mode === 'segment-a') {
    pickHintEl.textContent = '在场景中点击：拾取 Pos A（Esc 取消）';
    pickHintEl.classList.remove('hidden');
  } else if (mode === 'segment-b') {
    pickHintEl.textContent = '在场景中点击：拾取 Pos B（Esc 取消）';
    pickHintEl.classList.remove('hidden');
  } else {
    pickHintEl.classList.add('hidden');
  }
}

function updatePointerFromEvent(e: PointerEvent) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
}

function raycastScenePoint(): THREE.Vector3 | null {
  const meshes = meshEntries.filter((m) => m.mesh.visible).map((m) => m.mesh);
  const hits = raycaster.intersectObjects(meshes, false);
  if (hits.length) return hits[0].point.clone();

  const s = computeStats();
  const planeY = s.box.isEmpty() ? 0 : s.box.min.y;
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY);
  const pt = new THREE.Vector3();
  return raycaster.ray.intersectPlane(plane, pt) ? pt : null;
}

function applyGuideAtUe(ueX: number, ueY: number) {
  guideUeX = ueX;
  guideUeY = ueY;
  guideXInput.value = ueX.toFixed(1);
  guideYInput.value = ueY.toFixed(1);
  guideShowCb.checked = true;
  rebuildGuideLine();
  pivotInfoEl.classList.remove('error');
}

function applyGuideFromInputs() {
  if (!requireScene('设置辅助线')) return;
  const x = parseNumInput(guideXInput.value);
  const y = parseNumInput(guideYInput.value);
  if (x === null || y === null) {
    guideShowCb.checked = false;
    guideUeX = null;
    guideUeY = null;
    clearGuideLines();
    return;
  }
  applyGuideAtUe(x, y);
}

function updatePivotInfo() {
  pivotInfoEl.classList.remove('error');
  const ue = viewerToUe(controls.target);
  const tag = customPivotActive ? '自定义' : '默认';
  pivotInfoEl.textContent = `当前中心 (${tag}) UE: ${formatUe(ue)}`;
}

function updatePivotCross() {
  if (!customPivotActive) {
    pivotCrossGroup.visible = false;
    return;
  }
  pivotCrossGroup.position.copy(controls.target);
  const s = computeStats();
  const arm = s.box.isEmpty() ? 1600 : Math.max(400, Math.max(s.size.x, s.size.y, s.size.z) * 0.025);
  rebuildPivotCross(pivotCrossGroup, arm);
  pivotCrossGroup.visible = true;
}

function applyDisplayMode() {
  if (!hasScene()) return;
  const s = computeStats();
  const { dashSize, gapSize } = getAdaptiveDashSizes(s.box);
  for (const entry of meshEntries) {
    const base = (entry.mesh.userData.baseColor as number | undefined) ?? colorHexForType(entry.shapeType);
    applyDisplayModeToMesh(entry.mesh, displayMode, dashSize, gapSize, base);
  }
  if (selectedMesh) {
    const entry = meshEntries.find((e) => e.mesh === selectedMesh);
    if (entry) {
      const base = (entry.mesh.userData.baseColor as number) ?? colorHexForType(entry.shapeType);
      setMeshHighlight(entry.mesh, displayMode, true, base);
    }
  }
}

function setDisplayMode(mode: DisplayMode) {
  displayMode = mode;
  for (const input of displayModeInputs) {
    input.checked = input.value === mode;
  }
  applyDisplayMode();
}

function setOrbitCenterUe(ueX: number, ueY: number, ueZ: number, markCustom = true) {
  const next = ueToViewer(ueX, ueY, ueZ);
  const delta = next.clone().sub(controls.target);
  camera.position.add(delta);
  controls.target.copy(next);
  controls.update();
  customPivotActive = markCustom;
  pivotXInput.value = String(ueX);
  pivotYInput.value = String(ueY);
  pivotZInput.value = String(ueZ);
  updatePivotInfo();
  updatePivotCross();
}

function clearCustomPivot() {
  customPivotActive = false;
  pivotCrossGroup.visible = false;
  updatePivotInfo();
}

function applyPivotFromInputs() {
  if (!requireScene('设置视角中心')) return;
  const x = parseNumInput(pivotXInput.value);
  const y = parseNumInput(pivotYInput.value);
  const z = parseNumInput(pivotZInput.value);
  if (x === null || y === null || z === null) return;
  setOrbitCenterUe(x, y, z, true);
}

function handleScenePick(e: PointerEvent): boolean {
  if (pickMode === 'none') return false;
  if (!requireScene('拾取坐标')) {
    setPickMode('none');
    return true;
  }
  updatePointerFromEvent(e);
  const pt = raycastScenePoint();
  if (!pt) return true;
  const ue = viewerToUe(pt);
  if (pickMode === 'guide') {
    applyGuideAtUe(ue.x, ue.y);
    setPickMode('none');
  } else if (pickMode === 'pivot') {
    setOrbitCenterUe(ue.x, ue.y, ue.z, true);
    setPickMode('none');
  } else if (pickMode === 'segment-a') {
    writeUePos({ x: ue.x, y: ue.y, z: ue.z }, segAxInput, segAyInput, segAzInput);
    segmentA = { x: ue.x, y: ue.y, z: ue.z };
    setPickMode('none');
    const b = readUePos(segBxInput, segByInput, segBzInput);
    if (b) applySegmentAtUe(segmentA, b);
    else {
      segInfoEl.textContent = '已设 Pos A，请填写或拾取 Pos B';
      segInfoEl.classList.remove('error');
    }
  } else if (pickMode === 'segment-b') {
    writeUePos({ x: ue.x, y: ue.y, z: ue.z }, segBxInput, segByInput, segBzInput);
    segmentB = { x: ue.x, y: ue.y, z: ue.z };
    setPickMode('none');
    const a = readUePos(segAxInput, segAyInput, segAzInput);
    if (a) applySegmentAtUe(a, segmentB);
    else {
      segInfoEl.textContent = '已设 Pos B，请填写或拾取 Pos A';
      segInfoEl.classList.remove('error');
    }
  }
  return true;
}

function renderStats() {
  const s = computeStats();
  const fmt = (v: number) => v.toFixed(1);
  const typeLines = Object.entries(s.typeCounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, c]) => `<span class="type-dot" style="background:${colorCssForType(t)}"></span>${TYPE_LABELS[t] ?? t}: ${c}`)
    .join('<br/>');

  statsEl.innerHTML = `
    <table>
      <tr><td>Mesh 数</td><td>${s.meshCount}</td></tr>
      <tr><td>可见 Mesh</td><td>${Object.values(s.typeCounts).reduce((a, b) => a + b, 0)}</td></tr>
      <tr><td>三角面</td><td>${Math.round(s.triangles).toLocaleString()}</td></tr>
      <tr><td>AABB min (cm)</td><td>(${fmt(s.box.min.x)}, ${fmt(s.box.min.y)}, ${fmt(s.box.min.z)})</td></tr>
      <tr><td>AABB max (cm)</td><td>(${fmt(s.box.max.x)}, ${fmt(s.box.max.y)}, ${fmt(s.box.max.z)})</td></tr>
      <tr><td>中心 (cm)</td><td>(${fmt(s.center.x)}, ${fmt(s.center.y)}, ${fmt(s.center.z)})</td></tr>
      <tr><td>范围 (cm)</td><td>(${fmt(s.size.x)}, ${fmt(s.size.y)}, ${fmt(s.size.z)})</td></tr>
      <tr><td>类型</td><td>${typeLines || '—'}</td></tr>
    </table>
  `;
}

function rebuildTypeFilters(types: string[]) {
  typeFiltersEl.innerHTML = '';
  typeFilterState = {};
  for (const t of types.sort()) {
    typeFilterState[t] = true;
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.addEventListener('change', () => {
      typeFilterState[t] = cb.checked;
      applyVisibility();
    });
    label.append(cb);
    const dot = document.createElement('span');
    dot.className = 'type-dot';
    dot.style.background = colorCssForType(t);
    label.append(dot, document.createTextNode(TYPE_LABELS[t] ?? t));
    typeFiltersEl.appendChild(label);
  }
}

function applyVisibility() {
  for (const entry of meshEntries) {
    const typeOk = typeFilterState[entry.shapeType] !== false;
    const triggerOk = showTriggersCb.checked || !entry.isTrigger;
    entry.mesh.visible = typeOk && triggerOk;
  }
  renderStats();
  if (segShowCb.checked && segmentA && segmentB) rebuildSegmentLine();
}

function focusAll() {
  const s = computeStats();
  if (s.box.isEmpty()) return;
  const center = s.center;
  const size = s.size;
  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = maxDim * 1.2;
  controls.target.copy(center);
  camera.position.set(center.x + dist * 0.6, center.y + dist * 0.5, center.z + dist * 0.6);
  camera.near = Math.max(1, maxDim / 1000);
  camera.far = maxDim * 20;
  camera.updateProjectionMatrix();
  controls.update();
  customPivotActive = false;
  pivotCrossGroup.visible = false;
  const ue = viewerToUe(center);
  pivotXInput.value = ue.x.toFixed(1);
  pivotYInput.value = ue.y.toFixed(1);
  pivotZInput.value = ue.z.toFixed(1);
  updatePivotInfo();
  rebuildGuideLine();
  rebuildSegmentLine();
}

function resetCamera() {
  camera.position.copy(initialCameraPos);
  camera.near = 10;
  camera.far = 500000;
  camera.updateProjectionMatrix();
  controls.target.set(0, 0, 0);
  controls.update();
  clearCustomPivot();
  pivotXInput.value = '';
  pivotYInput.value = '';
  pivotZInput.value = '';
  updatePivotInfo();
}

function selectMesh(mesh: THREE.Mesh | null) {
  if (selectedMesh) {
    const prev = meshEntries.find((e) => e.mesh === selectedMesh);
    if (prev) {
      const base = (prev.mesh.userData.baseColor as number) ?? colorHexForType(prev.shapeType);
      setMeshHighlight(prev.mesh, displayMode, false, base);
    }
  }
  selectedMesh = mesh;
  if (!mesh) {
    selectionEl.classList.add('hidden');
    return;
  }
  const entry = meshEntries.find((e) => e.mesh === mesh);
  if (!entry) return;
  const base = (entry.mesh.userData.baseColor as number) ?? colorHexForType(entry.shapeType);
  setMeshHighlight(entry.mesh, displayMode, true, base);
  selectionEl.classList.remove('hidden');
  selectionEl.innerHTML = `
    <div class="sel-title">选中 Shape</div>
    <div>ID: ${entry.id}</div>
    <div>类型: <span class="type-dot inline" style="background:${colorCssForType(entry.shapeType)}"></span>${TYPE_LABELS[entry.shapeType] ?? entry.shapeType}</div>
    <div>Trigger: ${entry.isTrigger ? '是' : '否'}</div>
  `;
}

function readMeshMeta(obj: THREE.Mesh): { shapeType: string; isTrigger: boolean; id: string } {
  const ud = obj.userData as { shapeType?: string; isTrigger?: boolean; name?: string };
  let shapeType = ud.shapeType ?? 'unknown';
  let isTrigger = ud.isTrigger ?? false;
  let p: THREE.Object3D | null = obj.parent;
  while (p) {
    const pe = p.userData as { shapeType?: string; isTrigger?: boolean };
    if (pe.shapeType) shapeType = pe.shapeType;
    if (pe.isTrigger) isTrigger = pe.isTrigger;
    p = p.parent;
  }
  return { shapeType, isTrigger, id: obj.name || ud.name || 'mesh' };
}

function ingestGltf(gltf: { scene: THREE.Group; parser?: { json: { meshes?: Array<{ extras?: { shapeType?: string; isTrigger?: boolean }; name?: string }> } } }) {
  clearScene();
  root.add(gltf.scene);

  const meshExtrasByIndex = new Map<number, { shapeType?: string; isTrigger?: boolean; name?: string }>();
  gltf.parser?.json.meshes?.forEach((m, i) => {
    if (m.extras || m.name) meshExtrasByIndex.set(i, { ...m.extras, name: m.name });
  });

  const types = new Set<string>();
  gltf.scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const meshIndex = (obj as THREE.Mesh & { userData?: { meshIndex?: number } }).userData?.meshIndex;
    const fromJson = meshIndex !== undefined ? meshExtrasByIndex.get(meshIndex) : undefined;
    if (fromJson) {
      obj.userData.shapeType = fromJson.shapeType;
      obj.userData.isTrigger = fromJson.isTrigger;
      if (fromJson.name) obj.name = fromJson.name;
    }
    const meta = readMeshMeta(obj);
    applyMeshTypeColor(obj, meta.shapeType);
    types.add(meta.shapeType);
    meshEntries.push({ mesh: obj, ...meta });
  });

  rebuildTypeFilters([...types]);
  applyVisibility();
  sceneLoaded = true;
  applyDisplayMode();
  renderStats();
  focusAll();
  rebuildGuideLine();
  rebuildSegmentLine();
}

const loader = new GLTFLoader();

async function loadGltfUrl(url: string) {
  const gltf = await loader.loadAsync(url);
  ingestGltf(gltf);
}

async function convertByPath(filePath: string): Promise<ConvertResult> {
  const res = await fetch('/api/convert', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath }),
  });
  const data = (await res.json()) as ConvertResult & { error?: string };
  if (!res.ok) throw new Error(data.error ?? '转换失败');
  return data;
}

async function convertByUpload(file: File): Promise<ConvertResult> {
  const res = await fetch('/api/convert-upload', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Filename': file.name,
    },
    body: await file.arrayBuffer(),
  });
  const data = (await res.json()) as ConvertResult & { error?: string };
  if (!res.ok) throw new Error(data.error ?? '转换失败');
  return data;
}

async function openCollisionFromPath(filePath: string) {
  if (loading) return;
  setLoading(true, '正在转换 collision.bin…');
  try {
    const result = await convertByPath(filePath);
    showSource(result.source, result.cached);
    setLoading(true, '正在加载三维场景…');
    await loadGltfUrl(result.url);
  } catch (err) {
    showError(err instanceof Error ? err.message : '加载失败');
  } finally {
    setLoading(false);
  }
}

async function openCollisionFromFile(file: File) {
  if (loading) return;
  setLoading(true, `正在转换 ${file.name}…`);
  try {
    const result = await convertByUpload(file);
    showSource(result.source, result.cached);
    setLoading(true, '正在加载三维场景…');
    await loadGltfUrl(result.url);
  } catch (err) {
    showError(err instanceof Error ? err.message : '加载失败');
  } finally {
    setLoading(false);
  }
}

async function tryLoadDefault() {
  const params = new URLSearchParams(window.location.search);
  const binParam = params.get('bin');
  if (binParam) {
    await openCollisionFromPath(binParam);
    return;
  }
  showWelcome();
}

openBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  fileInput.value = '';
  if (f) void openCollisionFromFile(f);
});

displayModeInputs.forEach((input) => {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    setDisplayMode(input.value as DisplayMode);
  });
});
showTriggersCb.addEventListener('change', applyVisibility);

guideApplyBtn.addEventListener('click', applyGuideFromInputs);
guidePickBtn.addEventListener('click', () => {
  if (!requireScene('拾取辅助线坐标')) return;
  setPickMode(pickMode === 'guide' ? 'none' : 'guide');
});
guideShowCb.addEventListener('change', () => {
  if (guideShowCb.checked) applyGuideFromInputs();
  else clearGuideLines();
});
for (const el of [guideXInput, guideYInput]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyGuideFromInputs();
  });
}

pivotApplyBtn.addEventListener('click', applyPivotFromInputs);
pivotPickBtn.addEventListener('click', () => {
  if (!requireScene('拾取视角中心')) return;
  setPickMode(pickMode === 'pivot' ? 'none' : 'pivot');
});
pivotClearBtn.addEventListener('click', () => {
  clearCustomPivot();
  pivotXInput.value = '';
  pivotYInput.value = '';
  pivotZInput.value = '';
});
for (const el of [pivotXInput, pivotYInput, pivotZInput]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyPivotFromInputs();
  });
}

segApplyBtn.addEventListener('click', applySegmentFromInputs);
segPickABtn.addEventListener('click', () => {
  if (!requireScene('拾取 Pos A')) return;
  setPickMode(pickMode === 'segment-a' ? 'none' : 'segment-a');
});
segPickBBtn.addEventListener('click', () => {
  if (!requireScene('拾取 Pos B')) return;
  setPickMode(pickMode === 'segment-b' ? 'none' : 'segment-b');
});
segShowCb.addEventListener('change', () => {
  if (segShowCb.checked) applySegmentFromInputs();
  else clearSegmentLine();
});
segClearBtn.addEventListener('click', clearSegment);
for (const el of [segAxInput, segAyInput, segAzInput, segBxInput, segByInput, segBzInput]) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applySegmentFromInputs();
  });
}

controls.addEventListener('change', () => {
  updatePivotInfo();
  if (customPivotActive) updatePivotCross();
});

updatePivotInfo();

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') setPickMode('none');
  if (e.key === 'f' || e.key === 'F') focusAll();
  if (e.key === 'r' || e.key === 'R') resetCamera();
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (handleScenePick(e)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  updatePointerFromEvent(e);
  const hits = raycaster.intersectObjects(
    meshEntries.filter((m) => m.mesh.visible).map((m) => m.mesh),
    false,
  );
  selectMesh(hits.length ? (hits[0].object as THREE.Mesh) : null);
});

canvas.addEventListener('dragover', (e) => {
  e.preventDefault();
});
canvas.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files[0];
  if (f && f.name.toLowerCase().endsWith('.bin')) void openCollisionFromFile(f);
});

void tryLoadDefault();

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
