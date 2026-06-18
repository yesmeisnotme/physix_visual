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
  nudgeTarget: (dx: number) => void;
  getTargetX: () => number;
}

declare global {
  interface Window {
    __physixDebug?: PhysixDebug;
  }
}

export {};
