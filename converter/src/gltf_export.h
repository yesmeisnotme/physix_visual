#pragma once

#include "types.h"

#include <string>
#include <vector>

bool exportSceneToGltf(const std::vector<MeshData>& meshes, const SceneStats& stats,
                       const std::string& outputGltfPath, std::string& error);
