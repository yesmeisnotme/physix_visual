#pragma once

#include "types.h"

#include <PxPhysicsAPI.h>

// UE (X forward, Y right, Z up, cm) -> Three.js viewer (Y up, right-handed).
// Matches common UE -> glTF convention: (X, Z, -Y).
inline physx::PxVec3 ueToViewer(const physx::PxVec3& v) {
    return physx::PxVec3(v.x, v.z, -v.y);
}

// PhysX world (Y-up) -> viewer. Matches UE import: UE=(pxX, pxZ, pxY), viewer=(ueX, ueZ, -ueY).
inline physx::PxVec3 physxToViewer(const physx::PxVec3& v) {
    return physx::PxVec3(v.x, v.y, -v.z);
}

inline void flipTriangleWinding(MeshData& mesh) {
    for (size_t i = 0; i + 2 < mesh.indices.size(); i += 3) {
        const uint32_t b = mesh.indices[i + 1];
        mesh.indices[i + 1] = mesh.indices[i + 2];
        mesh.indices[i + 2] = b;
    }
}

inline void convertMeshToViewerCoords(MeshData& mesh) {
    for (size_t i = 0; i + 2 < mesh.positions.size(); i += 3) {
        const physx::PxVec3 out = ueToViewer(physx::PxVec3(
            mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]));
        mesh.positions[i] = out.x;
        mesh.positions[i + 1] = out.y;
        mesh.positions[i + 2] = out.z;
    }
    flipTriangleWinding(mesh);
}

inline void convertMeshPhysxToViewerCoords(MeshData& mesh) {
    for (size_t i = 0; i + 2 < mesh.positions.size(); i += 3) {
        const physx::PxVec3 out = physxToViewer(physx::PxVec3(
            mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]));
        mesh.positions[i] = out.x;
        mesh.positions[i + 1] = out.y;
        mesh.positions[i + 2] = out.z;
    }
    flipTriangleWinding(mesh);
}
