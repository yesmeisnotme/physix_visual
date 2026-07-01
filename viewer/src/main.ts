import './style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { formatUe, parseNumInput, ueToViewer, viewerToUe } from './coords';
import { SceneOrigin } from './scene-origin';
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

const AIRWALL_COLOR = 0xff4fd8;
const AIRWALL_LABEL_COLOR = '#ff4fd8';
const AIRWALL_LABEL_BG = 'rgba(20, 24, 32, 0.88)';
const AIRWALL_LABEL_TEXT = '#f8fbff';

function colorHexForType(type: string): number {
  return TYPE_COLORS[type] ?? TYPE_COLORS.unknown;
}

function colorCssForType(type: string): string {
  return `#${colorHexForType(type).toString(16).padStart(6, '0')}`;
}

function applyMeshTypeColor(mesh: THREE.Mesh, shapeType: string, colorOverride?: number) {
  const hex = colorOverride ?? colorHexForType(shapeType);
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const raw of mats) {
    const mat = raw as THREE.MeshStandardMaterial;
    if (!mat?.isMaterial) continue;
    mat.color.setHex(hex);
    mat.emissive.setHex(0x000000);
    mat.metalness = 0;
    mat.roughness = 0.82;
    mat.transparent = false;
    mat.opacity = 1;
    mat.depthWrite = true;
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 1;
    mat.polygonOffsetUnits = 1;
    mat.side = THREE.DoubleSide;
    mat.needsUpdate = true;
  }
  mesh.userData.baseColor = hex;
  attachDashedOutline(mesh, hex);
}

function applyAirWallDisplayToMesh(
  mesh: THREE.Mesh,
  mode: DisplayMode,
  dashSize: number,
  gapSize: number,
  baseColor: number,
) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const raw of mats) {
    const mat = raw as THREE.MeshStandardMaterial;
    mat.wireframe = false;
    mat.color.setHex(baseColor);
    mat.emissive.setHex(0x000000);
    mat.transparent = true;
    mat.opacity = mode === 'dashed' ? 0.28 : 0.46;
    mat.depthWrite = false;
    mat.depthTest = false;
    mat.visible = true;
    mat.side = THREE.DoubleSide;
    mat.needsUpdate = true;
  }
  mesh.renderOrder = 3;

  const outline = mesh.getObjectByName('collision_outline') as THREE.LineSegments | undefined;
  if (!outline) return;
  const mat = outline.material as THREE.LineDashedMaterial;
  mat.color.setHex(baseColor);
  mat.dashSize = dashSize;
  mat.gapSize = gapSize;
  mat.opacity = 1;
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = false;
  mat.needsUpdate = true;
  outline.computeLineDistances();
  outline.visible = true;
  outline.renderOrder = 4;
  outline.frustumCulled = false;
}

interface MeshEntry {
  mesh: THREE.Mesh;
  shapeType: string;
  isTrigger: boolean;
  id: string;
  layer: 'map' | 'airwall';
  airWallId?: string;
  airWallDesc?: string;
  source?: string;
}

interface AirWallLabelEntry {
  key: string;
  id: string;
  desc: string;
  text: string;
  sprite: THREE.Sprite;
  line: THREE.Line;
}

interface ConvertResult {
  url: string;
  source: string;
  cached?: boolean;
}

interface LoadedMainCollision {
  url: string;
  source: string;
  cached?: boolean;
}

interface AirWallCollision {
  fileName: string;
  source: string;
  url: string;
  cached?: boolean;
}

interface AirWallRecord {
  id: string;
  desc: string;
  pos: { x: number; y: number; z: number };
  rot: { x: number; y: number; z: number; w: number };
  collisions: AirWallCollision[];
}

interface AirWallTableResult {
  source: string;
  binDir: string;
  airwalls: AirWallRecord[];
}

interface AirWallUploadFile {
  file: File;
  relativePath: string;
}

type AirWallLoadRequest =
  | { kind: 'path'; tablePath: string; binDir?: string }
  | { kind: 'upload'; tableFile: File; binFiles: AirWallUploadFile[] };

type AirWallTableSelection =
  | { kind: 'path'; path: string; label: string }
  | { kind: 'upload'; file: File; label: string };

type AirWallBinSelection =
  | { kind: 'path'; path: string; label: string }
  | { kind: 'upload'; files: AirWallUploadFile[]; label: string };

type BrowserFileSystemFileHandle = {
  kind: 'file';
  name: string;
  getFile(): Promise<File>;
};

type BrowserFileSystemDirectoryHandle = {
  kind: 'directory';
  name: string;
  entries(): AsyncIterableIterator<[string, BrowserFileSystemHandle]>;
};

type BrowserFileSystemHandle = BrowserFileSystemFileHandle | BrowserFileSystemDirectoryHandle;

interface BrowserFileSystemWindow extends Window {
  showOpenFilePicker?: (options?: unknown) => Promise<BrowserFileSystemFileHandle[]>;
  showDirectoryPicker?: (options?: unknown) => Promise<BrowserFileSystemDirectoryHandle>;
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
const airWallTablePickBtn = document.getElementById('airwall-table-pick') as HTMLButtonElement;
const airWallTableSelectedEl = document.getElementById('airwall-table-selected')!;
const airWallBinPickBtn = document.getElementById('airwall-bin-pick') as HTMLButtonElement;
const airWallBinSelectedEl = document.getElementById('airwall-bin-selected')!;
const airWallClearBtn = document.getElementById('airwall-clear') as HTMLButtonElement;
const airWallInfoEl = document.getElementById('airwall-info')!;
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

const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.5, 500000);
const initialCameraDistance = 120000;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.sortObjects = true;

const sceneOrigin = new SceneOrigin();

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false;
controls.enableZoom = false;
controls.minDistance = 1;
controls.target.set(0, 0, 0);
controls.update();

/** Scene extent (cm); used for clip planes and control sensitivity. */
let sceneMaxDim = 500000;

const contentRoot = new THREE.Group();
contentRoot.name = 'content_root';
scene.add(contentRoot);

function bakeSceneOrigin(center: THREE.Vector3) {
  const meshes = meshEntries.map((e) => e.mesh);
  sceneOrigin.bakeMeshesAtLoad(meshes, center);
  contentRoot.updateMatrixWorld(true);
}

function tryFloatingOriginRebase() {
  if (
    sceneOrigin.rebaseIfNeeded(
      camera,
      controls.target,
      meshEntries.map((e) => e.mesh),
      sceneMaxDim,
    )
  ) {
    rebuildAirWallLabels();
    rebuildGuideLine();
    rebuildSegmentLine();
    updateCameraClippingPlanes();
    updateControlSensitivity();
    if (customPivotActive) updatePivotCross();
    updateGridPlacement();
  }
}

function localToUe(v: THREE.Vector3): THREE.Vector3 {
  return sceneOrigin.localToUe(v);
}

function ueToLocal(x: number, y: number, z: number): THREE.Vector3 {
  return sceneOrigin.ueToLocal(x, y, z);
}

const wheelDolly = new THREE.Vector3();

/** Multiplicative wheel dolly — works at any distance (no huge additive step). */
function applyWheelZoom(deltaY: number) {
  const dist = wheelDolly.subVectors(camera.position, controls.target).length();
  if (dist < 1e-6) return;
  const inward = deltaY < 0;
  const factor = inward ? 0.82 : 1.18;
  const newDist = THREE.MathUtils.clamp(dist * factor, controls.minDistance, controls.maxDistance);
  wheelDolly.subVectors(camera.position, controls.target).setLength(newDist).add(controls.target);
  camera.position.copy(wheelDolly);
  controls.update();
  tryFloatingOriginRebase();
  updateCameraClippingPlanes();
  updateControlSensitivity();
  updateGridVisibility();
}

function updateCameraClippingPlanes() {
  const distance = camera.position.distanceTo(controls.target);
  const d = Math.max(distance, 1);
  const extent = Math.max(sceneMaxDim, 1000);
  camera.near = Math.max(0.5, d / 2000);
  camera.far = Math.max(extent * 4, d * 50, 20000);
  camera.updateProjectionMatrix();
}

/** Pan must stay usable when camera is close; OrbitControls default scales too small. */
function updateControlSensitivity() {
  const distance = camera.position.distanceTo(controls.target);
  const ref = Math.max(sceneMaxDim * 0.08, 800);
  const boost = THREE.MathUtils.clamp(ref / Math.max(distance, 5), 2, 80);
  controls.panSpeed = boost;
}

function placeCameraAroundTarget(dist: number) {
  camera.position.set(dist * 0.62, dist * 0.48, dist * 0.62);
}
placeCameraAroundTarget(initialCameraDistance);

const overlays = new THREE.Group();
overlays.name = 'overlays';
contentRoot.add(overlays);

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

let gridHelper: THREE.GridHelper | null = null;

const axes = new THREE.AxesHelper(5000);
axes.name = 'axes_helper';
contentRoot.add(axes);

function rebuildGroundGrid() {
  if (gridHelper) {
    contentRoot.remove(gridHelper);
    gridHelper.geometry.dispose();
    (gridHelper.material as THREE.Material).dispose();
    gridHelper = null;
  }
  if (!sceneLoaded) return;

  const s = computeStats();
  if (s.box.isEmpty()) return;

  const groundY = s.box.min.y;
  const size = Math.max(s.size.x, s.size.z) * 1.05;
  const divisions = THREE.MathUtils.clamp(Math.round(size / 2000), 20, 120);

  gridHelper = new THREE.GridHelper(size, divisions, 0x444444, 0x2a2a2a);
  gridHelper.name = 'ground_grid';
  gridHelper.position.y = groundY;
  gridHelper.renderOrder = -1;
  contentRoot.add(gridHelper);
}

function updateGridVisibility() {
  const dist = camera.position.distanceTo(controls.target);
  if (gridHelper) {
    gridHelper.visible = dist > Math.max(sceneMaxDim * 0.015, 3500);
  }
  axes.visible = dist > Math.max(sceneMaxDim * 0.008, 200);
}

function updateGridPlacement() {
  rebuildGroundGrid();
  updateGridVisibility();
}

const ambient = new THREE.AmbientLight(0xffffff, 0.65);
scene.add(ambient);
const dir = new THREE.DirectionalLight(0xffffff, 0.85);
dir.position.set(1, 1.2, 0.8);
scene.add(dir);

function updateSceneLighting() {
  const d = Math.max(sceneMaxDim * 0.8, 8000);
  dir.position.set(d, d * 1.2, d * 0.7);
}

const root = new THREE.Group();
root.name = 'collision_root';
contentRoot.add(root);

const airWallLabelGroup = new THREE.Group();
airWallLabelGroup.name = 'airwall_labels';
contentRoot.add(airWallLabelGroup);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const meshEntries: MeshEntry[] = [];
const airWallLabelEntries: AirWallLabelEntry[] = [];
let selectedMesh: THREE.Mesh | null = null;
let typeFilterState: Record<string, boolean> = {};
let loadedAirWallTable: AirWallTableResult | null = null;
let currentMainCollision: LoadedMainCollision | null = null;
let selectedAirWallTablePath: string | null = null;
let selectedAirWallBinDirPath: string | null = null;
let selectedAirWallTableFile: File | null = null;
let selectedAirWallBinFiles: AirWallUploadFile[] = [];
let selectedAirWallTableLabel: string | null = null;
let selectedAirWallBinLabel: string | null = null;
let loading = false;

function setLoading(on: boolean, text = '正在转换 collision.bin…') {
  loading = on;
  loadingTextEl.textContent = text;
  loadingEl.classList.toggle('hidden', !on);
  openBtn.disabled = on;
  airWallTablePickBtn.disabled = on;
  airWallBinPickBtn.disabled = on;
  airWallClearBtn.disabled = on;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showSource(source: string, cached?: boolean, airwalls: AirWallTableResult | null = loadedAirWallTable) {
  const name = source.split(/[/\\]/).pop() ?? source;
  const airWallCount = airwalls?.airwalls.length ?? 0;
  const airWallFileCount = airwalls?.airwalls.reduce((sum, row) => sum + row.collisions.length, 0) ?? 0;
  const airWallName = airwalls?.source.split(/[/\\]/).pop() ?? '';
  sourceEl.classList.remove('hidden');
  sourceEl.innerHTML = `
    <div class="source-title">当前文件</div>
    <div class="source-name" title="${escapeHtml(source)}">${escapeHtml(name)}</div>
    <div class="source-meta">${cached ? '来自缓存' : '已转换'} · 原始文件未修改</div>
    ${
      airwalls
        ? `<div class="source-title airwall-source-title">空气墙</div>
           <div class="source-name" title="${escapeHtml(airwalls.source)}">${escapeHtml(airWallName)}</div>
           <div class="source-meta">实例 ${airWallCount} 个 · collision bin ${airWallFileCount} 个</div>`
        : ''
    }
  `;
}

function showError(message: string) {
  statsEl.innerHTML = `<p class="error">${message}</p>`;
}

function setAirWallInfo(message: string, error = false) {
  airWallInfoEl.textContent = message;
  airWallInfoEl.classList.toggle('error', error);
}

function fileDisplayName(pathOrName: string): string {
  return pathOrName.split(/[/\\]/).pop() ?? pathOrName;
}

function updateAirWallSelectionSummary() {
  airWallTableSelectedEl.textContent = selectedAirWallTableLabel ?? '未选择';
  airWallBinSelectedEl.textContent = selectedAirWallBinLabel ?? '未选择';
}

function clearAirWallSelection() {
  selectedAirWallTablePath = null;
  selectedAirWallBinDirPath = null;
  selectedAirWallTableFile = null;
  selectedAirWallBinFiles = [];
  selectedAirWallTableLabel = null;
  selectedAirWallBinLabel = null;
  updateAirWallSelectionSummary();
}

function airWallEntryKey(entry: Pick<MeshEntry, 'airWallId' | 'airWallDesc'>): string {
  return `${entry.airWallId ?? ''}\n${entry.airWallDesc ?? ''}`;
}

function airWallLabelText(id: string, desc: string): string {
  const title = desc.trim();
  const raw = title ? `#${id} ${title}` : `#${id}`;
  return raw.length > 48 ? `${raw.slice(0, 45)}...` : raw;
}

function createLabelTexture(text: string): { texture: THREE.CanvasTexture; aspect: number } {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建空气墙标签');

  const fontSize = 34;
  const padX = 18;
  const padY = 10;
  ctx.font = `600 ${fontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;
  const metrics = ctx.measureText(text);
  canvas.width = Math.ceil(metrics.width + padX * 2);
  canvas.height = fontSize + padY * 2 + 4;

  ctx.font = `600 ${fontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = AIRWALL_LABEL_BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = AIRWALL_LABEL_COLOR;
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3);
  ctx.fillStyle = AIRWALL_LABEL_TEXT;
  ctx.fillText(text, padX, canvas.height * 0.5);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return { texture, aspect: canvas.width / canvas.height };
}

function disposeAirWallLabels() {
  for (const entry of airWallLabelEntries) {
    const mat = entry.sprite.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.dispose();
    entry.line.geometry.dispose();
    (entry.line.material as THREE.Material).dispose();
  }
  airWallLabelEntries.length = 0;
  airWallLabelGroup.clear();
}

function rebuildAirWallLabels() {
  disposeAirWallLabels();
  const groups = new Map<
    string,
    { id: string; desc: string; entries: MeshEntry[]; box: THREE.Box3 }
  >();

  for (const entry of meshEntries) {
    if (entry.layer !== 'airwall' || !entry.airWallId) continue;
    const key = airWallEntryKey(entry);
    let group = groups.get(key);
    if (!group) {
      group = {
        id: entry.airWallId,
        desc: entry.airWallDesc ?? '',
        entries: [],
        box: new THREE.Box3(),
      };
      groups.set(key, group);
    }
    group.entries.push(entry);
    group.box.expandByObject(entry.mesh);
  }

  const labelHeight = THREE.MathUtils.clamp(sceneMaxDim * 0.015, 360, 1500);
  const stackCounts = new Map<string, number>();
  const rows = [...groups.entries()].sort((a, b) => {
    const an = Number(a[1].id);
    const bn = Number(b[1].id);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
    return a[1].id.localeCompare(b[1].id);
  });

  for (const [key, group] of rows) {
    if (group.box.isEmpty()) continue;
    const center = group.box.getCenter(new THREE.Vector3());
    const stackKey = `${Math.round(center.x / 100)}:${Math.round(center.z / 100)}`;
    const stackIndex = stackCounts.get(stackKey) ?? 0;
    stackCounts.set(stackKey, stackIndex + 1);

    const text = airWallLabelText(group.id, group.desc);
    const { texture, aspect } = createLabelTexture(text);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        depthTest: false,
        depthWrite: false,
      }),
    );

    const y = group.box.max.y + labelHeight * (0.82 + stackIndex * 1.08);
    sprite.name = `airwall_label_${group.id}`;
    sprite.renderOrder = 1002;
    sprite.scale.set(labelHeight * aspect, labelHeight, 1);
    sprite.position.set(center.x, y, center.z);

    const lineBottom = y - labelHeight * 0.48;
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(center.x, group.box.max.y, center.z),
      new THREE.Vector3(center.x, lineBottom, center.z),
    ]);
    const line = new THREE.Line(
      lineGeo,
      new THREE.LineBasicMaterial({
        color: AIRWALL_COLOR,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.9,
      }),
    );
    line.name = `airwall_label_line_${group.id}`;
    line.renderOrder = 1001;

    airWallLabelGroup.add(line);
    airWallLabelGroup.add(sprite);
    airWallLabelEntries.push({ key, id: group.id, desc: group.desc, text, sprite, line });
  }

  updateAirWallLabelVisibility();
}

function updateAirWallLabelVisibility() {
  for (const label of airWallLabelEntries) {
    const visible = meshEntries.some(
      (entry) => entry.layer === 'airwall' && airWallEntryKey(entry) === label.key && entry.mesh.visible,
    );
    label.sprite.visible = visible;
    label.line.visible = visible;
  }
}

function clearScene() {
  disposeAirWallLabels();
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
  loadedAirWallTable = null;
  selectionEl.classList.add('hidden');
  sceneLoaded = false;
  sceneOrigin.reset();
  contentRoot.position.set(0, 0, 0);
  setPickMode('none');
}

function computeStats() {
  const box = new THREE.Box3();
  let triangles = 0;
  const typeCounts: Record<string, number> = {};
  let mapMeshCount = 0;
  let airWallMeshCount = 0;
  const visibleAirWallIds = new Set<string>();

  for (const entry of meshEntries) {
    if (!entry.mesh.visible) continue;
    if (entry.layer === 'airwall') {
      airWallMeshCount++;
      if (entry.airWallId) visibleAirWallIds.add(entry.airWallId);
    } else {
      mapMeshCount++;
    }
    box.expandByObject(entry.mesh);
    const geo = entry.mesh.geometry;
    if (geo.index) triangles += geo.index.count / 3;
    else triangles += geo.attributes.position.count / 3;
    typeCounts[entry.shapeType] = (typeCounts[entry.shapeType] ?? 0) + 1;
  }

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());

  return {
    box,
    center,
    size,
    triangles,
    typeCounts,
    meshCount: meshEntries.length,
    mapMeshCount,
    airWallMeshCount,
    visibleAirWallCount: visibleAirWallIds.size,
  };
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
  const base = ueToLocal(guideUeX, guideUeY, 0);
  const x = base.x;
  const z = base.z;
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

  const va = ueToLocal(segmentA.x, segmentA.y, segmentA.z);
  const vb = ueToLocal(segmentB.x, segmentB.y, segmentB.z);
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
  const ue = localToUe(controls.target);
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
    if (entry.layer === 'airwall') {
      applyAirWallDisplayToMesh(entry.mesh, displayMode, dashSize, gapSize, base);
    } else {
      applyDisplayModeToMesh(entry.mesh, displayMode, dashSize, gapSize, base);
    }
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
  const next = ueToLocal(ueX, ueY, ueZ);
  const delta = next.clone().sub(controls.target);
  camera.position.add(delta);
  controls.target.copy(next);
  controls.update();
  updateCameraClippingPlanes();
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
  const ue = localToUe(pt);
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

  const ueMin = sceneOrigin.localToUe(s.box.min.clone());
  const ueMax = sceneOrigin.localToUe(s.box.max.clone());
  const ueCenter = sceneOrigin.localToUe(s.center.clone());

  statsEl.innerHTML = `
    <table>
      <tr><td>Mesh 数</td><td>${s.meshCount}</td></tr>
      <tr><td>可见 Mesh</td><td>${Object.values(s.typeCounts).reduce((a, b) => a + b, 0)}</td></tr>
      <tr><td>主地图 Mesh</td><td>${s.mapMeshCount}</td></tr>
      <tr><td>空气墙</td><td>${s.visibleAirWallCount} 实例 / ${s.airWallMeshCount} Mesh</td></tr>
      <tr><td>三角面</td><td>${Math.round(s.triangles).toLocaleString()}</td></tr>
      <tr><td>UE AABB min</td><td>${formatUe(ueMin)}</td></tr>
      <tr><td>UE AABB max</td><td>${formatUe(ueMax)}</td></tr>
      <tr><td>UE 中心</td><td>${formatUe(ueCenter)}</td></tr>
      <tr><td>范围 (cm)</td><td>(${fmt(s.size.x)}, ${fmt(s.size.y)}, ${fmt(s.size.z)})</td></tr>
      <tr><td>渲染原点 (UE)</td><td>${formatUe(sceneOrigin.localToUe(new THREE.Vector3()))}</td></tr>
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
  updateAirWallLabelVisibility();
  renderStats();
  if (segShowCb.checked && segmentA && segmentB) rebuildSegmentLine();
}

function focusAll() {
  const s = computeStats();
  if (s.box.isEmpty()) return;
  const maxDim = Math.max(s.size.x, s.size.y, s.size.z);
  const dist = maxDim * 1.2;
  sceneMaxDim = maxDim;
  updateSceneLighting();
  controls.target.set(0, 0, 0);
  placeCameraAroundTarget(dist);
  updateCameraClippingPlanes();
  updateControlSensitivity();
  controls.update();
  customPivotActive = false;
  pivotCrossGroup.visible = false;
  const ue = localToUe(new THREE.Vector3(0, 0, 0));
  pivotXInput.value = ue.x.toFixed(1);
  pivotYInput.value = ue.y.toFixed(1);
  pivotZInput.value = ue.z.toFixed(1);
  updatePivotInfo();
  rebuildGuideLine();
  rebuildSegmentLine();
  updateGridPlacement();
}

function resetCamera() {
  controls.target.set(0, 0, 0);
  if (sceneLoaded) {
    const dist = Math.max(sceneMaxDim * 1.2, 5000);
    placeCameraAroundTarget(dist);
  } else {
    placeCameraAroundTarget(initialCameraDistance);
  }
  updateCameraClippingPlanes();
  updateControlSensitivity();
  controls.update();
  clearCustomPivot();
  pivotXInput.value = '';
  pivotYInput.value = '';
  pivotZInput.value = '';
  updatePivotInfo();
}

function meshAabbInUe(mesh: THREE.Mesh) {
  const box = new THREE.Box3().setFromObject(mesh);
  const size = box.getSize(new THREE.Vector3());
  return {
    ueMin: sceneOrigin.localToUe(box.min.clone()),
    ueMax: sceneOrigin.localToUe(box.max.clone()),
    size,
  };
}

function getAirWallDebugAabbs() {
  return meshEntries
    .filter((entry) => entry.layer === 'airwall')
    .map((entry) => {
      const { ueMin, ueMax, size } = meshAabbInUe(entry.mesh);
      return {
        id: entry.airWallId ?? '',
        desc: entry.airWallDesc ?? '',
        source: entry.source ?? '',
        min: { x: ueMin.x, y: ueMin.y, z: ueMin.z },
        max: { x: ueMax.x, y: ueMax.y, z: ueMax.z },
        center: {
          x: (ueMin.x + ueMax.x) * 0.5,
          y: (ueMin.y + ueMax.y) * 0.5,
          z: (ueMin.z + ueMax.z) * 0.5,
        },
        size: { x: size.x, y: size.z, z: size.y },
      };
    });
}

function getAirWallDebugLabels() {
  return airWallLabelEntries.map((entry) => {
    const ue = sceneOrigin.localToUe(entry.sprite.position.clone());
    return {
      id: entry.id,
      desc: entry.desc,
      text: entry.text,
      visible: entry.sprite.visible,
      ue: { x: ue.x, y: ue.y, z: ue.z },
    };
  });
}

function getAirWallDebugVisualStates() {
  return meshEntries
    .filter((entry) => entry.layer === 'airwall')
    .map((entry) => {
      const mats = Array.isArray(entry.mesh.material) ? entry.mesh.material : [entry.mesh.material];
      const first = mats[0] as THREE.MeshStandardMaterial;
      const outline = entry.mesh.getObjectByName('collision_outline') as THREE.LineSegments | undefined;
      return {
        id: entry.airWallId ?? '',
        materialVisible: first.visible,
        transparent: first.transparent,
        opacity: first.opacity,
        depthWrite: first.depthWrite,
        depthTest: first.depthTest,
        renderOrder: entry.mesh.renderOrder,
        outlineVisible: outline?.visible ?? false,
        frustumCulled: entry.mesh.frustumCulled,
      };
    });
}

function renderSelectionPanel(entry: MeshEntry) {
  const fmt = (v: number) => v.toFixed(1);
  const { ueMin, ueMax, size } = meshAabbInUe(entry.mesh);
  const layerLabel = entry.layer === 'airwall' ? '空气墙' : '主地图';
  const airWallRows =
    entry.layer === 'airwall'
      ? `
      <tr><td>AirWall</td><td>#${escapeHtml(entry.airWallId ?? '—')} ${escapeHtml(entry.airWallDesc ?? '')}</td></tr>
      <tr><td>来源</td><td>${escapeHtml(entry.source ?? '—')}</td></tr>`
      : '';
  selectionEl.innerHTML = `
    <div class="sel-title">选中 Shape</div>
    <table>
      <tr><td>ID</td><td>${escapeHtml(entry.id)}</td></tr>
      <tr><td>层</td><td>${layerLabel}</td></tr>
      ${airWallRows}
      <tr><td>类型</td><td><span class="type-dot inline" style="background:${colorCssForType(entry.shapeType)}"></span>${TYPE_LABELS[entry.shapeType] ?? entry.shapeType}</td></tr>
      <tr><td>Trigger</td><td>${entry.isTrigger ? '是' : '否'}</td></tr>
      <tr><td>UE AABB min</td><td>${formatUe(ueMin)}</td></tr>
      <tr><td>UE AABB max</td><td>${formatUe(ueMax)}</td></tr>
      <tr><td>范围 (cm)</td><td>(${fmt(size.x)}, ${fmt(size.y)}, ${fmt(size.z)})</td></tr>
    </table>
  `;
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
  renderSelectionPanel(entry);
}

type GltfScene = {
  scene: THREE.Group;
  parser?: { json: { meshes?: Array<{ extras?: { shapeType?: string; isTrigger?: boolean }; name?: string }> } };
};

interface AddGltfOptions {
  layer: 'map' | 'airwall';
  airWall?: AirWallRecord;
  collision?: AirWallCollision;
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

function bakeAirWallMeshToWorld(mesh: THREE.Mesh, airWall: AirWallRecord) {
  mesh.updateWorldMatrix(true, false);
  const meshLocalToWorld = mesh.matrixWorld.clone();
  const meshWorldToLocal = mesh.matrixWorld.clone().invert();

  mesh.geometry = mesh.geometry.clone();
  const posAttr = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
  if (!posAttr) return;

  const q = new THREE.Quaternion(airWall.rot.x, airWall.rot.y, airWall.rot.z, airWall.rot.w);
  if (q.lengthSq() < 1e-12) q.identity();
  else q.normalize();

  const airWallPos = new THREE.Vector3(airWall.pos.x, airWall.pos.y, airWall.pos.z);
  const viewer = new THREE.Vector3();
  const ue = new THREE.Vector3();
  for (let i = 0; i < posAttr.count; i++) {
    viewer.fromBufferAttribute(posAttr, i);
    viewer.applyMatrix4(meshLocalToWorld);
    ue.copy(viewerToUe(viewer)).applyQuaternion(q).add(airWallPos);
    viewer.copy(ueToViewer(ue.x, ue.y, ue.z)).applyMatrix4(meshWorldToLocal);
    posAttr.setXYZ(i, viewer.x, viewer.y, viewer.z);
  }
  posAttr.needsUpdate = true;

  mesh.geometry.computeBoundingBox();
  mesh.geometry.computeBoundingSphere();
  mesh.geometry.computeVertexNormals();
}

function addGltfScene(gltf: GltfScene, options: AddGltfOptions) {
  root.add(gltf.scene);
  gltf.scene.updateMatrixWorld(true);

  const meshExtrasByIndex = new Map<number, { shapeType?: string; isTrigger?: boolean; name?: string }>();
  gltf.parser?.json.meshes?.forEach((m, i) => {
    if (m.extras || m.name) meshExtrasByIndex.set(i, { ...m.extras, name: m.name });
  });

  gltf.scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const meshIndex = (obj as THREE.Mesh & { userData?: { meshIndex?: number } }).userData?.meshIndex;
    const fromJson = meshIndex !== undefined ? meshExtrasByIndex.get(meshIndex) : undefined;
    if (fromJson) {
      obj.userData.shapeType = fromJson.shapeType;
      obj.userData.isTrigger = fromJson.isTrigger;
      if (fromJson.name) obj.name = fromJson.name;
    }
    if (options.layer === 'airwall' && options.airWall) {
      bakeAirWallMeshToWorld(obj, options.airWall);
      obj.frustumCulled = false;
    }
    const meta = readMeshMeta(obj);
    const baseColor = options.layer === 'airwall' ? AIRWALL_COLOR : undefined;
    applyMeshTypeColor(obj, meta.shapeType, baseColor);
    if (options.layer === 'airwall') {
      const outline = obj.getObjectByName('collision_outline');
      if (outline) outline.frustumCulled = false;
    }
    const fileName = options.collision?.fileName;
    const id =
      options.layer === 'airwall' && options.airWall
        ? `airwall_${options.airWall.id}_${fileName ?? 'collision'}_${meta.id}`
        : meta.id;
    if (id) obj.name = id;
    meshEntries.push({
      mesh: obj,
      ...meta,
      id,
      layer: options.layer,
      airWallId: options.airWall?.id,
      airWallDesc: options.airWall?.desc,
      source: fileName ?? options.collision?.source,
    });
  });
}

function finalizeLoadedScene() {
  const types = new Set(meshEntries.map((entry) => entry.shapeType));
  rebuildTypeFilters([...types]);
  applyVisibility();
  sceneLoaded = true;

  const s = computeStats();
  sceneMaxDim = Math.max(s.size.x, s.size.y, s.size.z, 1000);
  bakeSceneOrigin(s.center);
  rebuildAirWallLabels();

  applyDisplayMode();
  renderStats();
  focusAll();
  rebuildGuideLine();
  rebuildSegmentLine();
}

const loader = new GLTFLoader();

async function loadGltfUrl(url: string): Promise<GltfScene> {
  return await loader.loadAsync(url);
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

async function loadAirWallTable(filePath: string, binDir?: string): Promise<AirWallTableResult> {
  const res = await fetch('/api/airwalls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: filePath, binDir }),
  });
  const data = (await res.json()) as AirWallTableResult & { error?: string };
  if (!res.ok) throw new Error(data.error ?? '空气墙配置加载失败');
  return data;
}

async function loadAirWallTableUpload(tableFile: File, binFiles: AirWallUploadFile[]): Promise<AirWallTableResult> {
  const form = new FormData();
  form.append('table', tableFile, tableFile.name);
  for (const item of binFiles) {
    form.append('binPaths', item.relativePath);
    form.append('binFiles', item.file, item.file.name);
  }

  const res = await fetch('/api/airwalls-upload', {
    method: 'POST',
    body: form,
  });
  const data = (await res.json()) as AirWallTableResult & { error?: string };
  if (!res.ok) throw new Error(data.error ?? '空气墙配置加载失败');
  return data;
}

interface PickLocalPathResult {
  path: string | null;
  error?: string;
}

async function pickAirWallTablePath(): Promise<string | null> {
  const res = await fetch('/api/pick-airwall-table', { method: 'POST' });
  const data = (await res.json()) as PickLocalPathResult;
  if (!res.ok) throw new Error(data.error ?? '选择 AirWallTable.xml 失败');
  return data.path;
}

async function pickAirWallBinDirPath(): Promise<string | null> {
  const res = await fetch('/api/pick-airwall-bin-dir', { method: 'POST' });
  const data = (await res.json()) as PickLocalPathResult;
  if (!res.ok) throw new Error(data.error ?? '选择空气墙 bin 目录失败');
  return data.path;
}

function isPickerAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function supportsBrowserAirWallPickers(): boolean {
  const fsWindow = window as BrowserFileSystemWindow;
  return typeof fsWindow.showOpenFilePicker === 'function' && typeof fsWindow.showDirectoryPicker === 'function';
}

async function collectBinFilesFromDirectory(
  dir: BrowserFileSystemDirectoryHandle,
  prefix = '',
): Promise<AirWallUploadFile[]> {
  const files: AirWallUploadFile[] = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file') {
      if (!name.toLowerCase().endsWith('.bin')) continue;
      files.push({
        file: await handle.getFile(),
        relativePath: `${prefix}${name}`,
      });
      continue;
    }
    files.push(...await collectBinFilesFromDirectory(handle, `${prefix}${name}/`));
  }
  return files;
}

async function pickAirWallTableSelection(): Promise<AirWallTableSelection | null> {
  const fsWindow = window as BrowserFileSystemWindow;
  const showOpenFilePicker = fsWindow.showOpenFilePicker;
  if (supportsBrowserAirWallPickers() && showOpenFilePicker && !selectedAirWallBinDirPath) {
    try {
      const handles = await showOpenFilePicker.call(fsWindow, {
        multiple: false,
        types: [
          {
            description: 'AirWallTable.xml',
            accept: {
              'application/xml': ['.xml'],
              'text/xml': ['.xml'],
            },
          },
        ],
      });
      const handle = handles[0];
      if (!handle) return null;
      const file = await handle.getFile();
      return { kind: 'upload', file, label: file.name };
    } catch (err) {
      if (isPickerAbort(err)) return null;
      console.warn('showOpenFilePicker failed, falling back to local picker API', err);
    }
  }

  const path = await pickAirWallTablePath();
  return path ? { kind: 'path', path, label: fileDisplayName(path) } : null;
}

async function pickAirWallBinSelection(): Promise<AirWallBinSelection | null> {
  const fsWindow = window as BrowserFileSystemWindow;
  const showDirectoryPicker = fsWindow.showDirectoryPicker;
  if (supportsBrowserAirWallPickers() && showDirectoryPicker && !selectedAirWallTablePath) {
    try {
      const dir = await showDirectoryPicker.call(fsWindow, { mode: 'read' });
      const files = await collectBinFilesFromDirectory(dir);
      if (!files.length) throw new Error('选择的目录里没有 bin 文件');
      return { kind: 'upload', files, label: `${dir.name} · ${files.length} 个 bin` };
    } catch (err) {
      if (isPickerAbort(err)) return null;
      if (err instanceof Error && err.message.includes('没有 bin 文件')) throw err;
      console.warn('showDirectoryPicker failed, falling back to local picker API', err);
    }
  }

  const path = await pickAirWallBinDirPath();
  return path ? { kind: 'path', path, label: fileDisplayName(path) } : null;
}

async function loadCollisionScene(
  mainUrl: string,
  airWallRequest?: AirWallLoadRequest,
): Promise<AirWallTableResult | null> {
  const mainGltf = await loadGltfUrl(mainUrl);

  let airWalls: AirWallTableResult | null = null;
  const airWallGltfs: Array<{ gltf: GltfScene; row: AirWallRecord; collision: AirWallCollision }> = [];
  if (airWallRequest) {
    setLoading(true, '正在转换空气墙 collision.bin…');
    airWalls =
      airWallRequest.kind === 'path'
        ? await loadAirWallTable(airWallRequest.tablePath, airWallRequest.binDir)
        : await loadAirWallTableUpload(airWallRequest.tableFile, airWallRequest.binFiles);

    for (const row of airWalls.airwalls) {
      for (const collision of row.collisions) {
        setLoading(true, `正在加载空气墙 #${row.id} ${collision.fileName}…`);
        const gltf = await loadGltfUrl(collision.url);
        airWallGltfs.push({ gltf, row, collision });
      }
    }
  }

  clearScene();
  addGltfScene(mainGltf, { layer: 'map' });
  loadedAirWallTable = airWalls;
  for (const item of airWallGltfs) {
    addGltfScene(item.gltf, { layer: 'airwall', airWall: item.row, collision: item.collision });
  }

  finalizeLoadedScene();
  return airWalls;
}

async function openCollisionFromPath(filePath: string, airWallTablePath?: string, airWallBinDir?: string) {
  if (loading) return;
  let shouldAutoLoadSelectedAirWalls = false;
  setLoading(true, '正在转换 collision.bin…');
  try {
    const result = await convertByPath(filePath);
    setLoading(true, '正在加载三维场景…');
    const request: AirWallLoadRequest | undefined = airWallTablePath
      ? { kind: 'path', tablePath: airWallTablePath, binDir: airWallBinDir }
      : undefined;
    const airWalls = await loadCollisionScene(result.url, request);
    currentMainCollision = result;
    showSource(result.source, result.cached, airWalls);
    shouldAutoLoadSelectedAirWalls = !request && hasCompleteAirWallSelection();
    if (!shouldAutoLoadSelectedAirWalls) {
      setAirWallInfo(airWalls ? `已加载 ${airWalls.airwalls.length} 个空气墙实例` : '—');
    }
  } catch (err) {
    showError(err instanceof Error ? err.message : '加载失败');
  } finally {
    setLoading(false);
    if (shouldAutoLoadSelectedAirWalls) tryAutoApplyAirWalls();
  }
}

async function openCollisionFromFile(file: File) {
  if (loading) return;
  let shouldAutoLoadSelectedAirWalls = false;
  setLoading(true, `正在转换 ${file.name}…`);
  try {
    const result = await convertByUpload(file);
    setLoading(true, '正在加载三维场景…');
    await loadCollisionScene(result.url);
    currentMainCollision = result;
    showSource(result.source, result.cached, null);
    shouldAutoLoadSelectedAirWalls = hasCompleteAirWallSelection();
    if (!shouldAutoLoadSelectedAirWalls) setAirWallInfo('—');
  } catch (err) {
    showError(err instanceof Error ? err.message : '加载失败');
  } finally {
    setLoading(false);
    if (shouldAutoLoadSelectedAirWalls) tryAutoApplyAirWalls();
  }
}

function hasAnyAirWallSelection(): boolean {
  return Boolean(selectedAirWallTablePath || selectedAirWallTableFile || selectedAirWallBinDirPath || selectedAirWallBinFiles.length);
}

function hasCompleteAirWallSelection(): boolean {
  return Boolean(
    (selectedAirWallTablePath && selectedAirWallBinDirPath) ||
      (selectedAirWallTableFile && selectedAirWallBinFiles.length),
  );
}

function selectedAirWallRequest(): AirWallLoadRequest | null {
  if (selectedAirWallTablePath && selectedAirWallBinDirPath) {
    return { kind: 'path', tablePath: selectedAirWallTablePath, binDir: selectedAirWallBinDirPath };
  }
  if (selectedAirWallTableFile && selectedAirWallBinFiles.length) {
    return { kind: 'upload', tableFile: selectedAirWallTableFile, binFiles: selectedAirWallBinFiles };
  }
  return null;
}

function tryAutoApplyAirWalls() {
  if (loading) return;

  const hasTable = selectedAirWallTablePath !== null || selectedAirWallTableFile !== null;
  const hasBinDir = selectedAirWallBinDirPath !== null || selectedAirWallBinFiles.length > 0;
  if (!hasAnyAirWallSelection()) return;

  if (hasTable && !hasBinDir) {
    setAirWallInfo('已选择 AirWallTable.xml，请继续选择空气墙 bin 目录');
    return;
  }
  if (!hasTable && hasBinDir) {
    setAirWallInfo('已选择空气墙 bin 目录，请继续选择 AirWallTable.xml');
    return;
  }
  if (!currentMainCollision) {
    setAirWallInfo('空气墙数据已选齐，请先加载主地图 collision.bin');
    return;
  }

  if (!hasCompleteAirWallSelection()) {
    setAirWallInfo('请重新选择 AirWallTable.xml 与空气墙 bin 目录，保持两者来自同一种选择方式', true);
    return;
  }

  void applyAirWallsFromSelection();
}

async function applyAirWallsFromSelection() {
  if (loading) return;
  if (!currentMainCollision) {
    setAirWallInfo('请先加载主地图 collision.bin', true);
    return;
  }

  const request = selectedAirWallRequest();
  if (!selectedAirWallTablePath && !selectedAirWallTableFile) {
    setAirWallInfo('请选择 AirWallTable.xml', true);
    return;
  }
  if (!selectedAirWallBinDirPath && !selectedAirWallBinFiles.length) {
    setAirWallInfo('请选择空气墙 bin 目录', true);
    return;
  }
  if (!request) {
    setAirWallInfo('请重新选择 AirWallTable.xml 与空气墙 bin 目录，保持两者来自同一种选择方式', true);
    return;
  }

  setLoading(true, '正在加载空气墙配置…');
  try {
    const airWalls = await loadCollisionScene(currentMainCollision.url, request);
    showSource(currentMainCollision.source, currentMainCollision.cached, airWalls);
    const fileCount = airWalls?.airwalls.reduce((sum, row) => sum + row.collisions.length, 0) ?? 0;
    setAirWallInfo(`已加载 ${airWalls?.airwalls.length ?? 0} 个实例 / ${fileCount} 个 collision bin`);
  } catch (err) {
    setAirWallInfo(err instanceof Error ? err.message : '空气墙加载失败', true);
  } finally {
    setLoading(false);
  }
}

async function clearAirWallsFromScene() {
  if (loading) return;
  if (!currentMainCollision) {
    setAirWallInfo('请先加载主地图 collision.bin', true);
    return;
  }

  setLoading(true, '正在清除空气墙…');
  try {
    await loadCollisionScene(currentMainCollision.url);
    clearAirWallSelection();
    showSource(currentMainCollision.source, currentMainCollision.cached, null);
    setAirWallInfo('已清除空气墙');
  } catch (err) {
    setAirWallInfo(err instanceof Error ? err.message : '清除空气墙失败', true);
  } finally {
    setLoading(false);
  }
}

async function tryLoadDefault() {
  const params = new URLSearchParams(window.location.search);
  const binParam = params.get('bin');
  const airWallParam = params.get('airwall') ?? undefined;
  const airWallBinDirParam = params.get('airwallbin') ?? undefined;
  if (airWallParam) {
    airWallTableSelectedEl.textContent = `${fileDisplayName(airWallParam)} · URL 参数`;
  }
  if (airWallBinDirParam) {
    airWallBinSelectedEl.textContent = `${fileDisplayName(airWallBinDirParam)} · URL 参数`;
  }
  if (binParam) {
    await openCollisionFromPath(binParam, airWallParam, airWallBinDirParam);
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

airWallClearBtn.addEventListener('click', () => {
  void clearAirWallsFromScene();
});
airWallTablePickBtn.addEventListener('click', () => {
  if (loading) return;
  setAirWallInfo('正在选择 AirWallTable.xml…');
  void (async () => {
    try {
      const picked = await pickAirWallTableSelection();
      if (!picked) {
        setAirWallInfo('已取消选择 AirWallTable.xml');
        return;
      }
      selectedAirWallTablePath = picked.kind === 'path' ? picked.path : null;
      selectedAirWallTableFile = picked.kind === 'upload' ? picked.file : null;
      selectedAirWallTableLabel = picked.label;
      updateAirWallSelectionSummary();
      tryAutoApplyAirWalls();
    } catch (err) {
      setAirWallInfo(err instanceof Error ? err.message : '选择 AirWallTable.xml 失败', true);
    }
  })();
});
airWallBinPickBtn.addEventListener('click', () => {
  if (loading) return;
  setAirWallInfo('正在选择空气墙 bin 目录…');
  void (async () => {
    try {
      const picked = await pickAirWallBinSelection();
      if (!picked) {
        setAirWallInfo('已取消选择空气墙 bin 目录');
        return;
      }
      selectedAirWallBinDirPath = picked.kind === 'path' ? picked.path : null;
      selectedAirWallBinFiles = picked.kind === 'upload' ? picked.files : [];
      selectedAirWallBinLabel = picked.label;
      updateAirWallSelectionSummary();
      tryAutoApplyAirWalls();
    } catch (err) {
      setAirWallInfo(err instanceof Error ? err.message : '选择空气墙 bin 目录失败', true);
    }
  })();
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
  tryFloatingOriginRebase();
  updateCameraClippingPlanes();
  updateControlSensitivity();
  updatePivotInfo();
  if (customPivotActive) updatePivotCross();
  updateGridVisibility();
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
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

canvas.addEventListener('wheel', (e) => {
  if (!sceneLoaded) return;
  e.preventDefault();
  applyWheelZoom(e.deltaY);
}, { passive: false });

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

if (import.meta.env.DEV) {
  window.__physixDebug = {
    isSceneLoaded: () => sceneLoaded,
    getDist: () => camera.position.distanceTo(controls.target),
    zoomIn: () => applyWheelZoom(-120),
    zoomOut: () => applyWheelZoom(120),
    getGridY: () => gridHelper?.position.y ?? null,
    getGridVisible: () => gridHelper?.visible ?? false,
    getBoxMinY: () => computeStats().box.min.y,
    getOriginOffsetLen: () => sceneOrigin.offset.length(),
    getPanSpeed: () => controls.panSpeed,
    getMeshCount: () => meshEntries.length,
    getAirWallMeshCount: () => meshEntries.filter((entry) => entry.layer === 'airwall').length,
    getAirWallAabbs: () => getAirWallDebugAabbs(),
    getAirWallLabels: () => getAirWallDebugLabels(),
    getAirWallVisualStates: () => getAirWallDebugVisualStates(),
    nudgeTarget: (dx: number) => {
      controls.target.x += dx;
      camera.position.x += dx;
      controls.update();
    },
    getTargetX: () => controls.target.x,
  };
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();
