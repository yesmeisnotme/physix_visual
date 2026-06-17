#pragma once

#include "types.h"

#include <PxPhysicsAPI.h>
#include <extensions/PxExtensionsAPI.h>

#include <memory>
#include <string>
#include <vector>

class PhysxApp {
public:
    PhysxApp();
    ~PhysxApp();

    PhysxApp(const PhysxApp&) = delete;
    PhysxApp& operator=(const PhysxApp&) = delete;

    bool loadBinFile(const std::string& path, std::string& error);
    SceneStats collectStats() const;
    std::vector<MeshData> extractMeshes() const;

    physx::PxCollection* collection() const { return collection_; }

private:
    physx::PxDefaultAllocator allocator_;
    physx::PxDefaultErrorCallback errorCallback_;
    physx::PxFoundation* foundation_ = nullptr;
    physx::PxPhysics* physics_ = nullptr;
    physx::PxSerializationRegistry* registry_ = nullptr;
    physx::PxCollection* collection_ = nullptr;
    void* binMemory_ = nullptr;
    void* alignedBinMemory_ = nullptr;
};

const char* geometryTypeName(physx::PxGeometryType::Enum t);
const char* concreteTypeName(physx::PxConcreteType::Enum t);
