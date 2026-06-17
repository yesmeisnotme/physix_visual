import * as THREE from 'three';

export type DisplayMode = 'surface' | 'dashed';

const OUTLINE_NAME = 'collision_outline';

export function getAdaptiveDashSizes(box: THREE.Box3, fallback = 1000): { dashSize: number; gapSize: number } {
  if (box.isEmpty()) {
    return { dashSize: fallback * 0.004, gapSize: fallback * 0.002 };
  }
  const size = box.getSize(new THREE.Vector3());
  const dim = Math.max(size.x, size.y, size.z);
  return { dashSize: Math.max(40, dim * 0.004), gapSize: Math.max(20, dim * 0.002) };
}

export function attachDashedOutline(mesh: THREE.Mesh, color: number): THREE.LineSegments {
  const existing = mesh.getObjectByName(OUTLINE_NAME) as THREE.LineSegments | undefined;
  if (existing) return existing;

  const edges = new THREE.EdgesGeometry(mesh.geometry, 18);
  const mat = new THREE.LineDashedMaterial({
    color,
    dashSize: 80,
    gapSize: 40,
    transparent: true,
    opacity: 0.95,
  });
  const lines = new THREE.LineSegments(edges, mat);
  lines.name = OUTLINE_NAME;
  lines.computeLineDistances();
  lines.visible = false;
  lines.renderOrder = 1;
  mesh.add(lines);
  return lines;
}

export function applyDisplayModeToMesh(
  mesh: THREE.Mesh,
  mode: DisplayMode,
  dashSize: number,
  gapSize: number,
  baseColor: number,
) {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const outline = mesh.getObjectByName(OUTLINE_NAME) as THREE.LineSegments | undefined;

  if (mode === 'surface') {
    for (const raw of mats) {
      const mat = raw as THREE.MeshStandardMaterial;
      mat.wireframe = false;
      mat.transparent = true;
      mat.opacity = 0.78;
      mat.depthWrite = false;
      mat.visible = true;
    }
    if (outline) outline.visible = false;
    return;
  }

  for (const raw of mats) {
    const mat = raw as THREE.MeshStandardMaterial;
    mat.wireframe = false;
    mat.transparent = true;
    mat.opacity = 0;
    mat.depthWrite = false;
  }
  if (outline) {
    const mat = outline.material as THREE.LineDashedMaterial;
    mat.color.setHex(baseColor);
    mat.dashSize = dashSize;
    mat.gapSize = gapSize;
    outline.computeLineDistances();
    outline.visible = true;
  }
}

export function setMeshHighlight(mesh: THREE.Mesh, mode: DisplayMode, on: boolean, baseColor: number) {
  if (mode === 'dashed') {
    const outline = mesh.getObjectByName(OUTLINE_NAME) as THREE.LineSegments | undefined;
    if (outline) {
      (outline.material as THREE.LineDashedMaterial).color.setHex(on ? 0xfbbf24 : baseColor);
    }
    return;
  }
  const mat = mesh.material as THREE.MeshStandardMaterial;
  if (on) {
    mat.emissive.setHex(0xfbbf24);
  } else {
    mat.emissive.setHex(0x000000);
    mat.color.setHex(baseColor);
  }
}

export function disposePivotCross(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    if (child instanceof THREE.Line || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
  }
}

export function rebuildPivotCross(group: THREE.Group, armLength: number) {
  disposePivotCross(group);
  const half = armLength * 0.5;
  const positions = new Float32Array([
    -half, 0, 0, half, 0, 0,
    0, -half, 0, 0, half, 0,
    0, 0, -half, 0, 0, half,
  ]);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const lines = new THREE.LineSegments(
    geo,
    new THREE.LineBasicMaterial({
      color: 0xff6b6b,
      depthTest: false,
      transparent: true,
      opacity: 0.95,
    }),
  );
  lines.renderOrder = 999;
  group.add(lines);
}
