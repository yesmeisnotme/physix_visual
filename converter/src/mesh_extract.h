#pragma once

#include "types.h"

#include <PxPhysicsAPI.h>

#include <vector>

void extractMeshesFromCollection(physx::PxCollection& collection, std::vector<MeshData>& out);
