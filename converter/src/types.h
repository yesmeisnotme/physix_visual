#pragma once

#include <cstdint>
#include <string>
#include <vector>

struct Vec3 {
    float x, y, z;
};

struct Aabb {
    Vec3 min{0, 0, 0};
    Vec3 max{0, 0, 0};
    bool valid = false;
};

struct MeshData {
    std::string id;
    std::string shapeType;
    std::vector<float> positions; // xyz...
    std::vector<uint32_t> indices;
    bool isTrigger = false;
    float color[4]{0.5f, 0.5f, 0.5f, 0.6f};
};

struct SceneStats {
    uint32_t nbObjects = 0;
    uint32_t nbShapes = 0;
    uint32_t nbConvexMeshes = 0;
    uint32_t nbHeightFields = 0;
    uint32_t nbTriangleMeshes = 0;
    uint32_t nbMaterials = 0;
    uint32_t nbRigidActors = 0;
    uint32_t totalTriangles = 0;
    Aabb bounds;
};

inline void expandAabb(Aabb& b, float x, float y, float z) {
    if (!b.valid) {
        b.min = b.max = {x, y, z};
        b.valid = true;
        return;
    }
    if (x < b.min.x) b.min.x = x;
    if (y < b.min.y) b.min.y = y;
    if (z < b.min.z) b.min.z = z;
    if (x > b.max.x) b.max.x = x;
    if (y > b.max.y) b.max.y = y;
    if (z > b.max.z) b.max.z = z;
}
