#include "physx_app.h"
#include "mesh_extract.h"

#include <extensions/PxSerialization.h>
#include <extensions/PxExtensionsAPI.h>

#include <cstdio>
#include <cstring>
#include <fstream>
#include <map>
#include <vector>

namespace {

std::vector<uint8_t> readFileBytes(const std::string& path) {
    std::ifstream in(path, std::ios::binary | std::ios::ate);
    if (!in) return {};
    const auto size = in.tellg();
    in.seekg(0);
    std::vector<uint8_t> data(static_cast<size_t>(size));
    in.read(reinterpret_cast<char*>(data.data()), size);
    return data;
}

} // namespace

PhysxApp::PhysxApp() {
    foundation_ = PxCreateFoundation(PX_FOUNDATION_VERSION, allocator_, errorCallback_);
    if (!foundation_) return;

    physics_ = PxCreatePhysics(PX_PHYSICS_VERSION, *foundation_, physx::PxTolerancesScale(), false, nullptr);
    if (!physics_) return;

    PxInitExtensions(*physics_, nullptr);
    registry_ = physx::PxSerialization::createSerializationRegistry(*physics_);
}

PhysxApp::~PhysxApp() {
    if (collection_) {
        collection_->release();
        collection_ = nullptr;
    }
    if (registry_) {
        registry_->release();
        registry_ = nullptr;
    }
    if (physics_) {
        PxCloseExtensions();
        physics_->release();
        physics_ = nullptr;
    }
    if (foundation_) {
        foundation_->release();
        foundation_ = nullptr;
    }
    if (binMemory_) {
        free(binMemory_);
        binMemory_ = nullptr;
        alignedBinMemory_ = nullptr;
    }
}

bool PhysxApp::loadBinFile(const std::string& path, std::string& error) {
    if (!physics_ || !registry_) {
        error = "PhysX not initialized";
        return false;
    }

    const auto bytes = readFileBytes(path);
    if (bytes.size() < 16) {
        error = "File too small";
        return false;
    }
    if (std::memcmp(bytes.data(), "SEBD", 4) != 0) {
        error = "Not a SEBD PhysX binary file";
        return false;
    }

    if (binMemory_) {
        free(binMemory_);
        binMemory_ = nullptr;
        alignedBinMemory_ = nullptr;
    }
    if (collection_) {
        collection_->release();
        collection_ = nullptr;
    }

    binMemory_ = malloc(bytes.size() + PX_SERIAL_FILE_ALIGN);
    if (!binMemory_) {
        error = "Out of memory";
        return false;
    }
    alignedBinMemory_ = reinterpret_cast<void*>(
        (reinterpret_cast<size_t>(binMemory_) + PX_SERIAL_FILE_ALIGN - 1) & ~(PX_SERIAL_FILE_ALIGN - 1));
    std::memcpy(alignedBinMemory_, bytes.data(), bytes.size());

    collection_ = physx::PxSerialization::createCollectionFromBinary(alignedBinMemory_, *registry_, nullptr);
    if (!collection_) {
        error = "PxSerialization::createCollectionFromBinary failed (SDK/version mismatch?)";
        return false;
    }
    return true;
}

const char* concreteTypeName(physx::PxConcreteType::Enum t) {
    switch (t) {
    case physx::PxConcreteType::eUNDEFINED: return "UNDEFINED";
    case physx::PxConcreteType::eHEIGHTFIELD: return "HEIGHTFIELD";
    case physx::PxConcreteType::eCONVEX_MESH: return "CONVEX_MESH";
    case physx::PxConcreteType::eTRIANGLE_MESH_BVH33: return "TRIANGLE_MESH_BVH33";
    case physx::PxConcreteType::eTRIANGLE_MESH_BVH34: return "TRIANGLE_MESH_BVH34";
    case physx::PxConcreteType::eRIGID_DYNAMIC: return "RIGID_DYNAMIC";
    case physx::PxConcreteType::eRIGID_STATIC: return "RIGID_STATIC";
    case physx::PxConcreteType::eSHAPE: return "SHAPE";
    case physx::PxConcreteType::eMATERIAL: return "MATERIAL";
    case physx::PxConcreteType::ePARTICLE_SYSTEM: return "PARTICLE_SYSTEM";
    default: return "OTHER";
    }
}

const char* geometryTypeName(physx::PxGeometryType::Enum t) {
    switch (t) {
    case physx::PxGeometryType::eSPHERE: return "sphere";
    case physx::PxGeometryType::ePLANE: return "plane";
    case physx::PxGeometryType::eCAPSULE: return "capsule";
    case physx::PxGeometryType::eBOX: return "box";
    case physx::PxGeometryType::eCONVEXMESH: return "convex_mesh";
    case physx::PxGeometryType::eTRIANGLEMESH: return "triangle_mesh";
    case physx::PxGeometryType::eHEIGHTFIELD: return "heightfield";
    default: return "unknown";
    }
}

SceneStats PhysxApp::collectStats() const {
    SceneStats stats;
    if (!collection_) return stats;

    stats.nbObjects = collection_->getNbObjects();
    std::map<std::string, uint32_t> geomCounts;

    for (physx::PxU32 i = 0; i < collection_->getNbObjects(); ++i) {
        physx::PxBase& obj = collection_->getObject(i);
        const auto ctype = static_cast<physx::PxConcreteType::Enum>(obj.getConcreteType());
        switch (ctype) {
        case physx::PxConcreteType::eCONVEX_MESH: stats.nbConvexMeshes++; break;
        case physx::PxConcreteType::eHEIGHTFIELD: stats.nbHeightFields++; break;
        case physx::PxConcreteType::eTRIANGLE_MESH_BVH33:
        case physx::PxConcreteType::eTRIANGLE_MESH_BVH34:
            stats.nbTriangleMeshes++;
            break;
        case physx::PxConcreteType::eSHAPE: stats.nbShapes++; break;
        case physx::PxConcreteType::eMATERIAL: stats.nbMaterials++; break;
        case physx::PxConcreteType::eRIGID_STATIC:
        case physx::PxConcreteType::eRIGID_DYNAMIC:
            stats.nbRigidActors++;
            break;
        default: break;
        }

        if (obj.is<physx::PxShape>()) {
            auto* shape = obj.is<physx::PxShape>();
            const char* gname = geometryTypeName(shape->getGeometryType());
            geomCounts[gname]++;
        }
    }

    const auto meshes = extractMeshes();
    stats.totalTriangles = 0;
    for (const auto& m : meshes) {
        stats.totalTriangles += static_cast<uint32_t>(m.indices.size() / 3);
        for (size_t vi = 0; vi + 2 < m.positions.size(); vi += 3) {
            expandAabb(stats.bounds, m.positions[vi], m.positions[vi + 1], m.positions[vi + 2]);
        }
    }

    return stats;
}

std::vector<MeshData> PhysxApp::extractMeshes() const {
    std::vector<MeshData> out;
    if (!collection_) return out;
    extractMeshesFromCollection(*collection_, out);
    return out;
}
