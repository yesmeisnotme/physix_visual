import * as THREE from 'three';

/** UE (X forward, Y right, Z up, cm) -> Three.js viewer (Y up). */
export function ueToViewer(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x, z, -y);
}

export function viewerToUe(v: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(v.x, -v.z, v.y);
}

export function formatUe(v: THREE.Vector3): string {
  return `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`;
}

export function viewerLocalToUe(local: THREE.Vector3, sceneCenter: THREE.Vector3): THREE.Vector3 {
  return viewerToUe(local.clone().add(sceneCenter));
}

export function ueToViewerLocal(x: number, y: number, z: number, sceneCenter: THREE.Vector3): THREE.Vector3 {
  return ueToViewer(x, y, z).sub(sceneCenter);
}

export function parseNumInput(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
