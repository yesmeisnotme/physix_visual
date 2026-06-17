#include "gltf_export.h"

#include <cstdint>
#include <fstream>
#include <filesystem>
#include <iomanip>
#include <sstream>
#include <vector>

namespace fs = std::filesystem;

namespace {

struct BufferView {
    uint32_t byteOffset = 0;
    uint32_t byteLength = 0;
    uint32_t target = 0;
};

void appendBytes(std::vector<uint8_t>& bin, const void* data, size_t size) {
    const auto* p = static_cast<const uint8_t*>(data);
    bin.insert(bin.end(), p, p + size);
}

void pad4(std::vector<uint8_t>& bin) {
    while (bin.size() % 4 != 0) bin.push_back(0);
}

std::string jsonEscape(const std::string& s) {
    std::ostringstream o;
    for (char c : s) {
        if (c == '"') o << "\\\"";
        else if (c == '\\') o << "\\\\";
        else o << c;
    }
    return o.str();
}

} // namespace

bool exportSceneToGltf(const std::vector<MeshData>& meshes, const SceneStats& /*stats*/,
                       const std::string& outputGltfPath, std::string& error) {
    if (meshes.empty()) {
        error = "No meshes to export";
        return false;
    }

    std::vector<uint8_t> bin;
    std::vector<BufferView> views;

    for (const auto& m : meshes) {
        pad4(bin);
        const uint32_t posOffset = static_cast<uint32_t>(bin.size());
        appendBytes(bin, m.positions.data(), m.positions.size() * sizeof(float));
        pad4(bin);
        views.push_back({posOffset, static_cast<uint32_t>(m.positions.size() * sizeof(float)), 34962});

        pad4(bin);
        const uint32_t idxOffset = static_cast<uint32_t>(bin.size());
        appendBytes(bin, m.indices.data(), m.indices.size() * sizeof(uint32_t));
        pad4(bin);
        views.push_back({idxOffset, static_cast<uint32_t>(m.indices.size() * sizeof(uint32_t)), 34963});
    }

    std::ostringstream full;
    full << std::fixed << std::setprecision(6);
    full << "{\n";
    full << "  \"asset\": {\"version\": \"2.0\", \"generator\": \"physix_convert\", \"extras\": {\"unit\": \"cm\", \"sourceCoordSystem\": \"ue_z_up\", \"viewerCoordSystem\": \"three_y_up\"}},\n";
    full << "  \"scene\": 0,\n";
    full << "  \"scenes\": [{\"nodes\": [0]}],\n";
    full << "  \"nodes\": [{\"name\": \"collision_root\", \"children\": [";
    for (size_t i = 0; i < meshes.size(); ++i) {
        if (i) full << ", ";
        full << (i + 1);
    }
    full << "]}";
    for (size_t mi = 0; mi < meshes.size(); ++mi) {
        full << ", {\"name\": \"" << jsonEscape(meshes[mi].id) << "\", \"mesh\": " << mi << "}";
    }
    full << "],\n";

    full << "  \"meshes\": [\n";
    for (size_t mi = 0; mi < meshes.size(); ++mi) {
        const auto& m = meshes[mi];
        if (mi) full << ",\n";
        full << "    {\"name\": \"" << jsonEscape(m.id) << "\", \"extras\": {";
        full << "\"shapeType\": \"" << jsonEscape(m.shapeType) << "\", ";
        full << "\"isTrigger\": " << (m.isTrigger ? "true" : "false");
        full << "}, \"primitives\": [{\"attributes\": {\"POSITION\": " << (mi * 2)
             << "}, \"indices\": " << (mi * 2 + 1) << ", \"material\": " << mi << ", \"mode\": 4}]}";
    }
    full << "\n  ],\n";

    full << "  \"accessors\": [\n";
    for (size_t mi = 0; mi < meshes.size(); ++mi) {
        const auto& m = meshes[mi];
        if (mi) full << ",\n";
        full << "    {\"bufferView\": " << (mi * 2) << ", \"componentType\": 5126, \"count\": "
             << (m.positions.size() / 3) << ", \"type\": \"VEC3\"}";
        full << ",\n";
        full << "    {\"bufferView\": " << (mi * 2 + 1) << ", \"componentType\": 5125, \"count\": "
             << m.indices.size() << ", \"type\": \"SCALAR\"}";
    }
    full << "\n  ],\n";

    full << "  \"bufferViews\": [\n";
    for (size_t i = 0; i < views.size(); ++i) {
        if (i) full << ",\n";
        full << "    {\"buffer\": 0, \"byteOffset\": " << views[i].byteOffset
             << ", \"byteLength\": " << views[i].byteLength << ", \"target\": " << views[i].target << "}";
    }
    full << "\n  ],\n";

    const std::string binName = fs::path(outputGltfPath).filename().string() + ".bin";
    full << "  \"buffers\": [{\"byteLength\": " << bin.size() << ", \"uri\": \"" << jsonEscape(binName) << "\"}],\n";

    full << "  \"materials\": [\n";
    for (size_t mi = 0; mi < meshes.size(); ++mi) {
        const auto& m = meshes[mi];
        if (mi) full << ",\n";
        full << "    {\"name\": \"" << jsonEscape(m.id) << "\", \"pbrMetallicRoughness\": {";
        full << "\"baseColorFactor\": [" << m.color[0] << ", " << m.color[1] << ", " << m.color[2] << ", " << m.color[3] << "], ";
        full << "\"metallicFactor\": 0.0, \"roughnessFactor\": 0.9}, \"doubleSided\": true, \"alphaMode\": \"BLEND\"}";
    }
    full << "\n  ]\n}\n";

    try {
        fs::create_directories(fs::path(outputGltfPath).parent_path());
    } catch (...) {
    }

    const fs::path binPath = fs::path(outputGltfPath).string() + ".bin";
    {
        std::ofstream bout(binPath, std::ios::binary);
        if (!bout) {
            error = "Cannot write bin: " + binPath.string();
            return false;
        }
        bout.write(reinterpret_cast<const char*>(bin.data()), static_cast<std::streamsize>(bin.size()));
    }

    {
        std::ofstream jout(outputGltfPath);
        if (!jout) {
            error = "Cannot write gltf: " + outputGltfPath;
            return false;
        }
        jout << full.str();
    }

    return true;
}
