import * as THREE from 'three';
import { ueToViewer, viewerToUe } from './coords';

/**
 * Keeps rendering math in a local frame near (0,0,0) to avoid float32 jitter
 * when UE / PhysX world coords are tens of thousands of cm.
 *
 * Local viewer position + offset = absolute viewer position (double math in JS).
 */
export class SceneOrigin {
  /** Absolute viewer coords represented by local (0,0,0). */
  readonly offset = new THREE.Vector3();
  private active = false;

  reset() {
    this.offset.set(0, 0, 0);
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  ueToLocal(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(ueToViewer(x, y, z)).sub(this.offset);
  }

  localToUe(v: THREE.Vector3): THREE.Vector3 {
    return viewerToUe(_abs.copy(v).add(this.offset));
  }

  localToAbs(v: THREE.Vector3): THREE.Vector3 {
    return _abs.copy(v).add(this.offset);
  }

  absToLocal(v: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(v).sub(this.offset);
  }

  /** One-time: glTF vertices are absolute viewer coords — shift to scene-centered local. */
  bakeMeshesAtLoad(meshes: THREE.Mesh[], center: THREE.Vector3) {
    this.offset.copy(center);
    this.active = true;
    translateMeshGeometries(meshes, center.clone().negate());
  }

  /**
   * Runtime floating origin: when orbit pivot drifts far in local space,
   * re-bake mesh geometry and reset camera pivot to local zero.
   * Caller should rebuild overlay lines (guide / segment) after this returns true.
   */
  rebaseIfNeeded(
    camera: THREE.PerspectiveCamera,
    orbitTarget: THREE.Vector3,
    meshes: THREE.Mesh[],
    sceneMaxDim: number,
  ): boolean {
    if (!this.active) return false;

    const threshold = Math.max(1200, sceneMaxDim * 0.025);
    if (orbitTarget.lengthSq() < threshold * threshold) return false;

    const delta = orbitTarget.clone();
    const shift = delta.clone().negate();

    camera.position.add(shift);
    orbitTarget.set(0, 0, 0);

    translateMeshGeometries(meshes, shift);

    this.offset.add(delta);
    return true;
  }
}

const _abs = new THREE.Vector3();

function translateMeshGeometries(meshes: THREE.Mesh[], shift: THREE.Vector3) {
  for (const mesh of meshes) {
    mesh.geometry.translate(shift.x, shift.y, shift.z);
    mesh.geometry.computeBoundingBox();
    mesh.geometry.computeBoundingSphere();
    for (const child of mesh.children) {
      if (child instanceof THREE.Line || child instanceof THREE.LineSegments || child instanceof THREE.Points) {
        child.geometry.translate(shift.x, shift.y, shift.z);
        child.geometry.computeBoundingBox();
        child.geometry.computeBoundingSphere();
      }
    }
  }
}
