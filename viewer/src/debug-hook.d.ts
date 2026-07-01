/// <reference types="vite/client" />

interface PhysixDebug {
  isSceneLoaded: () => boolean;
  getDist: () => number;
  zoomIn: () => void;
  zoomOut: () => void;
  getGridY: () => number | null;
  getGridVisible: () => boolean;
  getBoxMinY: () => number;
  getOriginOffsetLen: () => number;
  getPanSpeed: () => number;
  getMeshCount: () => number;
  getAirWallMeshCount: () => number;
  getAirWallAabbs: () => Array<{
    id: string;
    desc: string;
    source: string;
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
    center: { x: number; y: number; z: number };
    size: { x: number; y: number; z: number };
  }>;
  getAirWallLabels: () => Array<{
    id: string;
    desc: string;
    text: string;
    visible: boolean;
    ue: { x: number; y: number; z: number };
  }>;
  getAirWallVisualStates: () => Array<{
    id: string;
    materialVisible: boolean;
    transparent: boolean;
    opacity: number;
    depthWrite: boolean;
    depthTest: boolean;
    renderOrder: number;
    outlineVisible: boolean;
    frustumCulled: boolean;
  }>;
  nudgeTarget: (dx: number) => void;
  getTargetX: () => number;
}

declare global {
  interface Window {
    __physixDebug?: PhysixDebug;
  }
}

export {};
