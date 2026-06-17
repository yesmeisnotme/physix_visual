#include "physx_app.h"
#include "gltf_export.h"

#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <windows.h>
#include <shellapi.h>
#endif

namespace fs = std::filesystem;

namespace {

struct Options {
    std::string input;
    std::string output = "collision_export.gltf";
    bool statsOnly = false;
    bool openViewer = false;
    bool help = false;
};

void printUsage() {
    std::cout
        << "physix_convert - PhysX collision.bin to glTF converter\n\n"
        << "Usage:\n"
        << "  physix_convert -i <collision.bin> [-o collision_export.gltf] [--stats-only] [--open]\n\n"
        << "Options:\n"
        << "  -i, --input       Input PhysX SEBD binary\n"
        << "  -o, --output      Output glTF path (default: collision_export.gltf; sidecar: <name>.gltf.bin)\n"
        << "  --stats-only      Print stats and exit without exporting glTF\n"
        << "  --open            Launch web viewer for input collision.bin (read-only)\n"
        << "  -h, --help        Show this help\n";
}

bool parseArgs(int argc, char** argv, Options& opt) {
    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        if (arg == "-h" || arg == "--help") {
            opt.help = true;
            return true;
        }
        if (arg == "--stats-only") {
            opt.statsOnly = true;
            continue;
        }
        if (arg == "--open") {
            opt.openViewer = true;
            continue;
        }
        if ((arg == "-i" || arg == "--input") && i + 1 < argc) {
            opt.input = argv[++i];
            continue;
        }
        if ((arg == "-o" || arg == "--output") && i + 1 < argc) {
            opt.output = argv[++i];
            continue;
        }
        std::cerr << "Unknown argument: " << arg << "\n";
        return false;
    }
    if (opt.input.empty()) return false;
    return true;
}

void printStats(const SceneStats& stats, const std::vector<MeshData>& meshes) {
    std::map<std::string, uint32_t> geomCounts;
    for (const auto& m : meshes) geomCounts[m.shapeType]++;

    std::cout << "=== PhysX Collision Stats ===\n";
    std::cout << "Objects:        " << stats.nbObjects << "\n";
    std::cout << "Shapes:         " << stats.nbShapes << "\n";
    std::cout << "ConvexMeshes:   " << stats.nbConvexMeshes << "\n";
    std::cout << "HeightFields:   " << stats.nbHeightFields << "\n";
    std::cout << "TriangleMeshes: " << stats.nbTriangleMeshes << "\n";
    std::cout << "Materials:      " << stats.nbMaterials << "\n";
    std::cout << "RigidActors:    " << stats.nbRigidActors << "\n";
    std::cout << "ExportMeshes:   " << meshes.size() << "\n";
    std::cout << "TotalTriangles: " << stats.totalTriangles << "\n";

    std::cout << "GeometryTypes:\n";
    for (const auto& kv : geomCounts) {
        std::cout << "  " << kv.first << ": " << kv.second << "\n";
    }

    if (stats.bounds.valid) {
        const float cx = (stats.bounds.min.x + stats.bounds.max.x) * 0.5f;
        const float cy = (stats.bounds.min.y + stats.bounds.max.y) * 0.5f;
        const float cz = (stats.bounds.min.z + stats.bounds.max.z) * 0.5f;
        const float ex = stats.bounds.max.x - stats.bounds.min.x;
        const float ey = stats.bounds.max.y - stats.bounds.min.y;
        const float ez = stats.bounds.max.z - stats.bounds.min.z;
        std::cout << "AABB min: (" << stats.bounds.min.x << ", " << stats.bounds.min.y << ", "
                  << stats.bounds.min.z << ")\n";
        std::cout << "AABB max: (" << stats.bounds.max.x << ", " << stats.bounds.max.y << ", "
                  << stats.bounds.max.z << ")\n";
        std::cout << "AABB center: (" << cx << ", " << cy << ", " << cz << ") cm\n";
        std::cout << "AABB extent: (" << ex << ", " << ey << ", " << ez << ") cm\n";
    }
}

#ifdef _WIN32
bool spawnDetached(const std::wstring& commandLine, const fs::path& workDir = {}) {
    std::vector<wchar_t> buf(commandLine.begin(), commandLine.end());
    buf.push_back(L'\0');
    STARTUPINFOW si{};
    PROCESS_INFORMATION pi{};
    si.cb = sizeof(si);
    const wchar_t* wd = workDir.empty() ? nullptr : workDir.wstring().c_str();
    if (!CreateProcessW(nullptr, buf.data(), nullptr, nullptr, FALSE, CREATE_NEW_CONSOLE, nullptr, wd, &si, &pi)) {
        return false;
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return true;
}

bool openViewerWithBin(const std::string& binPath) {
    fs::path root = fs::current_path();
    if (!fs::exists(root / "viewer")) {
        root = root.parent_path();
    }
    const fs::path script = root / "scripts" / "start.ps1";
    if (!fs::exists(script)) {
        std::cerr << "Launcher not found: " << script << "\n";
        return false;
    }

    const fs::path absBin = fs::absolute(binPath);
    const std::wstring cmd =
        L"powershell -NoProfile -ExecutionPolicy Bypass -File \"" + script.wstring() + L"\" -Bin \"" +
        absBin.wstring() + L"\"";
    return spawnDetached(cmd, root);
}
#endif

} // namespace

int main(int argc, char** argv) {
    Options opt;
    if (!parseArgs(argc, argv, opt) || opt.help) {
        printUsage();
        return opt.help ? 0 : 1;
    }

    PhysxApp app;
    std::string error;
    if (!app.loadBinFile(opt.input, error)) {
        std::cerr << "Load failed: " << error << "\n";
        return 2;
    }

    const auto meshes = app.extractMeshes();
    const SceneStats stats = app.collectStats();
    printStats(stats, meshes);

#ifdef _WIN32
    if (opt.openViewer) {
        if (!openViewerWithBin(opt.input)) return 4;
        return 0;
    }
#endif

    if (opt.statsOnly) return 0;

    try {
        const fs::path inputPath = fs::absolute(opt.input);
        const fs::path outputPath = fs::absolute(opt.output);
        const fs::path sidecarPath = fs::path(outputPath.string() + ".bin");
        if (inputPath == outputPath || inputPath == sidecarPath) {
            std::cerr << "Error: output would overwrite input. Use e.g. -o collision_export.gltf\n";
            return 3;
        }
    } catch (...) {
    }

    if (!exportSceneToGltf(meshes, stats, opt.output, error)) {
        std::cerr << "Export failed: " << error << "\n";
        return 3;
    }
    std::cout << "Exported: " << opt.output << "\n";

    return 0;
}
