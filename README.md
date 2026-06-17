# PhysX Collision Visualizer

将游戏导出的 PhysX `collision.bin`（SEBD 格式）在浏览器中三维可视化。**原始文件只读，绝不会被修改**；转换结果写入 `viewer/.cache/`。

## 环境要求

- Windows x64
- Visual Studio 2017+（含 C++ 桌面开发）
- CMake 3.16+
- Node.js 18+

## 一键打开（推荐）

**双击项目根目录的 `打开碰撞可视化.bat`**（或英文名 `Open-Viewer.bat`）

或在 PowerShell 中：

```powershell
.\scripts\start.ps1
```

行为：

1. 直接打开 Viewer（无需事先选文件或填坐标）
2. 在浏览器中点击「打开 collision.bin」加载地图
3. 加载后可在侧栏输入坐标，或点「场景中拾取」在 3D 里点选
4. 命令行窗口保持打开；关闭即停止服务

可选参数：

```powershell
.\scripts\start.ps1 -Pick              # 启动时可选文件（可取消）
.\scripts\start.ps1 -Bin "path\to\collision.bin"  # 启动后自动加载该文件
```

## 首次使用：编译转换器

```powershell
cd converter
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

PhysX SDK 编译说明见下方「编译 PhysX SDK」。

## 工作流程

```
collision.bin（只读）
       ↓
  physix_convert（内存读取 + 导出到 viewer/.cache/）
       ↓
  Three.js Viewer（浏览器三维展示）
```

Viewer 侧边栏可：

- 点击「打开 collision.bin」或拖放 `.bin` 文件切换地图
- 显示模式：半透明面 / 虚线框；按碰撞类型着色与过滤
- 辅助线：给定 UE X/Y 的竖直线，支持场景拾取
- 两点连线：UE 坐标或拾取 A/B，显示线段与碰撞交点（小十字高亮）
- 视角中心：自定义 orbit 旋转/缩放中心（红色十字），支持场景拾取
- Trigger 开关、点击 mesh 高亮
- `F` 聚焦全场景，`R` 重置相机，`Esc` 取消拾取

## CLI（高级 / 批处理）

```
physix_convert -i <collision.bin> [-o out/scene.gltf] [--stats-only] [--open]
```

| 参数 | 说明 |
|------|------|
| `-i, --input` | 输入 PhysX SEBD 二进制（只读） |
| `-o, --output` | 输出 glTF 路径（默认 `collision_export.gltf`，sidecar 为 `<name>.gltf.bin`） |
| `--stats-only` | 仅打印统计，不导出 glTF |
| `--open` | 启动 Web Viewer 查看该 `collision.bin`（不修改原文件） |
| `-h, --help` | 帮助 |

导出时请避免 `-o` 指向与输入相同的路径；工具会拒绝可能覆盖输入的输出。

## 编译 PhysX SDK

PhysX 3.4.2-bsd 位于 `third_party/PhysX-3.4`（已在 `.gitignore` 中）。

```powershell
$msbuild = "C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Current\Bin\MSBuild.exe"
$sln = "third_party\PhysX-3.4\PhysX_3.4\Source\compiler\vc15win64\PhysX.sln"

cmd /c "call `"C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat`" && `"$msbuild`" `"$sln`" /p:Configuration=profile /p:Platform=x64 /p:PlatformToolset=v145 /m"
```

## 运行时 DLL

运行 `physix_convert.exe` 需与以下 DLL 同目录（CMake POST_BUILD 会自动复制）：

- `PhysX3PROFILE_x64.dll`
- `PhysX3CommonPROFILE_x64.dll`
- `PhysX3CookingPROFILE_x64.dll`
- `PhysXDevice64.dll`
- `PxFoundationPROFILE_x64.dll`
- `PxPvdSDKPROFILE_x64.dll`

## 样本数据统计（开发时参考）

| 类型 | 数量 |
|------|------|
| RigidStatic | 423 |
| Shape | 1223 |
| ConvexMesh | 189 |
| HeightField | 1 |
| Material | 1（集合内） |

坐标单位：**1 unit = 1 cm**（游戏客户端 UE Z-up）。请自备 `collision.bin` 放项目根或通过 Viewer 打开。

## 项目结构

```
physix_visual/
├── 打开碰撞可视化.bat      # 双击启动（中文名）
├── Open-Viewer.bat          # 双击启动（英文名，等价）
├── collision.bin          # 本地放置（gitignore，不提交仓库）
├── converter/             # C++ 转换器 physix_convert
├── viewer/                # Three.js Web Viewer + 转换 API
│   └── .cache/            # 转换缓存（gitignore）
├── scripts/start.ps1      # 启动脚本
└── docs/方案设计.md
```

## 许可证

样本与工具代码见仓库；PhysX SDK 遵循 NVIDIA BSD 3-Clause。

## 发布到 GitHub

仓库未包含 PhysX SDK 源码与本地编译产物（见 `.gitignore`）。克隆后需自行编译 PhysX 与 `physix_convert`，并在 `viewer/` 下执行 `npm install`。

```powershell
git clone https://github.com/yesmeisnotme/physix_visual.git
cd physix_visual
# 编译 converter（见上文）后
.\scripts\start.ps1
```
