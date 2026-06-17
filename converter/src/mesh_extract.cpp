#include "mesh_extract.h"
#include "physx_app.h"
#include "coord.h"

#include <extensions/PxShapeExt.h>

#include <cmath>
#include <cstring>
#include <set>
#include <string>
#include <vector>

namespace {

void setColorForType(MeshData& m, const char* type) {
    if (std::strcmp(type, "heightfield") == 0) {
        m.color[0] = 0.2f; m.color[1] = 0.85f; m.color[2] = 0.4f; m.color[3] = 0.78f;
    } else if (std::strcmp(type, "convex_mesh") == 0) {
        m.color[0] = 0.2f; m.color[1] = 0.53f; m.color[2] = 1.0f; m.color[3] = 0.78f;
    } else if (std::strcmp(type, "triangle_mesh") == 0) {
        m.color[0] = 0.6f; m.color[1] = 0.63f; m.color[2] = 0.65f; m.color[3] = 0.78f;
    } else if (std::strcmp(type, "box") == 0) {
        m.color[0] = 1.0f; m.color[1] = 0.69f; m.color[2] = 0.13f; m.color[3] = 0.78f;
    } else if (std::strcmp(type, "sphere") == 0) {
        m.color[0] = 1.0f; m.color[1] = 0.4f; m.color[2] = 0.53f; m.color[3] = 0.78f;
    } else if (std::strcmp(type, "capsule") == 0) {
        m.color[0] = 0.7f; m.color[1] = 0.4f; m.color[2] = 1.0f; m.color[3] = 0.78f;
    } else if (std::strcmp(type, "plane") == 0) {
        m.color[0] = 0.2f; m.color[1] = 0.8f; m.color[2] = 0.8f; m.color[3] = 0.78f;
    } else {
        m.color[0] = 0.82f; m.color[1] = 0.83f; m.color[2] = 0.86f; m.color[3] = 0.78f;
    }
}

void addVertex(MeshData& mesh, const physx::PxVec3& v) {
    mesh.positions.push_back(v.x);
    mesh.positions.push_back(v.y);
    mesh.positions.push_back(v.z);
}

void addTriangle(MeshData& mesh, uint32_t a, uint32_t b, uint32_t c) {
    mesh.indices.push_back(a);
    mesh.indices.push_back(b);
    mesh.indices.push_back(c);
}

void transformMesh(MeshData& mesh, const physx::PxTransform& pose) {
    for (size_t i = 0; i + 2 < mesh.positions.size(); i += 3) {
        physx::PxVec3 v(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
        v = pose.transform(v);
        mesh.positions[i] = v.x;
        mesh.positions[i + 1] = v.y;
        mesh.positions[i + 2] = v.z;
    }
}

void buildBox(const physx::PxVec3& he, MeshData& mesh) {
    const physx::PxVec3 c[8] = {
        {-he.x, -he.y, -he.z}, {he.x, -he.y, -he.z}, {he.x, he.y, -he.z}, {-he.x, he.y, -he.z},
        {-he.x, -he.y, he.z},  {he.x, -he.y, he.z},  {he.x, he.y, he.z},  {-he.x, he.y, he.z},
    };
    for (const auto& v : c) addVertex(mesh, v);
    const uint32_t faces[12][3] = {
        {0, 1, 2}, {0, 2, 3}, {4, 6, 5}, {4, 7, 6}, {0, 4, 5}, {0, 5, 1},
        {2, 6, 7}, {2, 7, 3}, {0, 3, 7}, {0, 7, 4}, {1, 5, 6}, {1, 6, 2},
    };
    for (const auto& f : faces) addTriangle(mesh, f[0], f[1], f[2]);
}

void buildSphere(float radius, MeshData& mesh, int stacks = 12, int slices = 16) {
    for (int i = 0; i <= stacks; ++i) {
        const float v = static_cast<float>(i) / stacks;
        const float phi = v * physx::PxPi;
        for (int j = 0; j <= slices; ++j) {
            const float u = static_cast<float>(j) / slices;
            const float theta = u * 2.0f * physx::PxPi;
            addVertex(mesh, physx::PxVec3(
                radius * std::sin(phi) * std::cos(theta),
                radius * std::cos(phi),
                radius * std::sin(phi) * std::sin(theta)));
        }
    }
    for (int i = 0; i < stacks; ++i) {
        for (int j = 0; j < slices; ++j) {
            const uint32_t a = static_cast<uint32_t>(i * (slices + 1) + j);
            const uint32_t b = a + static_cast<uint32_t>(slices + 1);
            addTriangle(mesh, a, b, a + 1);
            addTriangle(mesh, a + 1, b, b + 1);
        }
    }
}

void buildCapsule(float radius, float halfHeight, MeshData& mesh, int stacks = 8, int slices = 12) {
    // UE capsule major axis = Z
    for (int i = 0; i <= stacks; ++i) {
        const float v = static_cast<float>(i) / stacks;
        const float phi = v * physx::PxPi;
        for (int j = 0; j <= slices; ++j) {
            const float u = static_cast<float>(j) / slices;
            const float theta = u * 2.0f * physx::PxPi;
            addVertex(mesh, physx::PxVec3(
                radius * std::sin(phi) * std::cos(theta),
                radius * std::sin(phi) * std::sin(theta),
                radius * std::cos(phi)));
        }
    }
    for (int i = 0; i < stacks; ++i) {
        for (int j = 0; j < slices; ++j) {
            const uint32_t a = static_cast<uint32_t>(i * (slices + 1) + j);
            const uint32_t b = a + static_cast<uint32_t>(slices + 1);
            addTriangle(mesh, a, b, a + 1);
            addTriangle(mesh, a + 1, b, b + 1);
        }
    }
    for (size_t i = 0; i + 2 < mesh.positions.size(); i += 3) {
        mesh.positions[i + 2] += (mesh.positions[i + 2] >= 0.0f ? halfHeight : -halfHeight);
    }
}

void buildConvex(const physx::PxConvexMeshGeometry& cg, MeshData& mesh) {
    physx::PxConvexMesh* convex = cg.convexMesh;
    const physx::PxVec3* verts = convex->getVertices();
    const physx::PxU8* indexBuffer = convex->getIndexBuffer();
    const physx::PxU32 nbPolys = convex->getNbPolygons();

    physx::PxU32 offset = 0;
    for (physx::PxU32 i = 0; i < nbPolys; ++i) {
        physx::PxHullPolygon poly;
        if (!convex->getPolygonData(i, poly)) continue;
        const physx::PxU8* faceIndices = indexBuffer + poly.mIndexBase;
        for (physx::PxU32 j = 0; j < poly.mNbVerts; ++j) {
            physx::PxVec3 v = verts[faceIndices[j]];
            v = v.multiply(cg.scale.scale);
            addVertex(mesh, v);
        }
        for (physx::PxU32 j = 2; j < poly.mNbVerts; ++j) {
            addTriangle(mesh, offset, offset + j, offset + j - 1);
        }
        offset += poly.mNbVerts;
    }
}

void buildTriangleMesh(const physx::PxTriangleMeshGeometry& tg, MeshData& mesh) {
    physx::PxTriangleMesh* tm = tg.triangleMesh;
    const physx::PxVec3* verts = tm->getVertices();
    const physx::PxU32 nbVerts = tm->getNbVertices();
    const physx::PxU32 nbTris = tm->getNbTriangles();
    const void* tris = tm->getTriangles();
    const bool is16 = tm->getTriangleMeshFlags().isSet(physx::PxTriangleMeshFlag::e16_BIT_INDICES);

    for (physx::PxU32 i = 0; i < nbVerts; ++i) {
        addVertex(mesh, verts[i].multiply(tg.scale.scale));
    }
    for (physx::PxU32 i = 0; i < nbTris; ++i) {
        physx::PxU32 i0, i1, i2;
        if (is16) {
            const auto* idx = reinterpret_cast<const physx::PxU16*>(tris);
            i0 = idx[i * 3 + 0];
            i1 = idx[i * 3 + 1];
            i2 = idx[i * 3 + 2];
        } else {
            const auto* idx = reinterpret_cast<const physx::PxU32*>(tris);
            i0 = idx[i * 3 + 0];
            i1 = idx[i * 3 + 1];
            i2 = idx[i * 3 + 2];
        }
        addTriangle(mesh, i0, i1, i2);
    }
}

void buildHeightField(const physx::PxHeightFieldGeometry& hg, MeshData& mesh) {
    const physx::PxReal rs = hg.rowScale;
    const physx::PxReal hs = hg.heightScale;
    const physx::PxReal cs = hg.columnScale;
    physx::PxHeightField* hf = hg.heightField;
    const physx::PxU32 nbCols = hf->getNbColumns();
    const physx::PxU32 nbRows = hf->getNbRows();
    const physx::PxU32 nbVerts = nbRows * nbCols;

    std::vector<physx::PxHeightFieldSample> samples(nbVerts);
    hf->saveCells(samples.data(), nbVerts * sizeof(physx::PxHeightFieldSample));

    for (physx::PxU32 i = 0; i < nbRows; ++i) {
        for (physx::PxU32 j = 0; j < nbCols; ++j) {
            const auto& s = samples[j + i * nbCols];
            // PhysX native HF: rows along X, columns along Z, height along Y.
            addVertex(mesh, physx::PxVec3(physx::PxReal(i) * rs, physx::PxReal(s.height) * hs,
                                          physx::PxReal(j) * cs));
        }
    }

    for (physx::PxU32 i = 0; i + 1 < nbCols; ++i) {
        for (physx::PxU32 j = 0; j + 1 < nbRows; ++j) {
            const physx::PxU8 tessFlag = samples[i + j * nbCols].tessFlag();
            const uint32_t i0 = j * nbCols + i;
            const uint32_t i1 = j * nbCols + i + 1;
            const uint32_t i2 = (j + 1) * nbCols + i;
            const uint32_t i3 = (j + 1) * nbCols + i + 1;
            addTriangle(mesh, i0, tessFlag ? i3 : i1, i2);
            addTriangle(mesh, i1, tessFlag ? i0 : i2, i3);
        }
    }
}

void extractShapeGeometry(physx::PxShape& shape, const physx::PxTransform& worldPose, uint32_t shapeIndex,
                          std::vector<MeshData>& out, std::set<physx::PxShape*>& seen) {
    if (!seen.insert(&shape).second) return;

    physx::PxGeometryHolder geom = shape.getGeometry();
    MeshData mesh;
    mesh.id = "shape_" + std::to_string(shapeIndex) + "_" + geometryTypeName(geom.getType());
    mesh.shapeType = geometryTypeName(geom.getType());
    mesh.isTrigger = (shape.getFlags() & physx::PxShapeFlag::eTRIGGER_SHAPE) != physx::PxShapeFlags();
    setColorForType(mesh, mesh.shapeType.c_str());

    switch (geom.getType()) {
    case physx::PxGeometryType::eBOX:
        buildBox(geom.box().halfExtents, mesh);
        break;
    case physx::PxGeometryType::eSPHERE:
        buildSphere(geom.sphere().radius, mesh);
        break;
    case physx::PxGeometryType::eCAPSULE:
        buildCapsule(geom.capsule().radius, geom.capsule().halfHeight, mesh);
        break;
    case physx::PxGeometryType::eCONVEXMESH:
        buildConvex(geom.convexMesh(), mesh);
        break;
    case physx::PxGeometryType::eTRIANGLEMESH:
        buildTriangleMesh(geom.triangleMesh(), mesh);
        break;
    case physx::PxGeometryType::eHEIGHTFIELD:
        buildHeightField(geom.heightField(), mesh);
        break;
    case physx::PxGeometryType::ePLANE: {
        const float s = 5000.0f;
        // UE ground plane XY
        buildBox(physx::PxVec3(s, s, 0.01f), mesh);
        break;
    }
    default:
        return;
    }

    if (mesh.positions.empty() || mesh.indices.empty()) return;
    transformMesh(mesh, worldPose);
    // HF: worldPose maps PhysX-native local into UE Z-up world (see shape quat ~ (0,0.707,0.707,0)).
    convertMeshToViewerCoords(mesh);
    out.push_back(std::move(mesh));
}

} // namespace

void extractMeshesFromCollection(physx::PxCollection& collection, std::vector<MeshData>& out) {
    std::set<physx::PxShape*> seen;
    uint32_t shapeIndex = 0;

    for (physx::PxU32 i = 0; i < collection.getNbObjects(); ++i) {
        physx::PxBase& obj = collection.getObject(i);
        if (!obj.is<physx::PxRigidActor>()) continue;

        auto* actor = obj.is<physx::PxRigidActor>();
        const physx::PxTransform actorPose = actor->getGlobalPose();
        const physx::PxU32 n = actor->getNbShapes();
        if (n == 0) continue;

        std::vector<physx::PxShape*> shapes(n);
        actor->getShapes(shapes.data(), n);
        for (physx::PxShape* shape : shapes) {
            const physx::PxTransform worldPose = actorPose * shape->getLocalPose();
            extractShapeGeometry(*shape, worldPose, shapeIndex++, out, seen);
        }
    }

    for (physx::PxU32 i = 0; i < collection.getNbObjects(); ++i) {
        physx::PxBase& obj = collection.getObject(i);
        if (!obj.is<physx::PxShape>()) continue;
        auto* shape = obj.is<physx::PxShape>();
        extractShapeGeometry(*shape, shape->getLocalPose(), shapeIndex++, out, seen);
    }
}
