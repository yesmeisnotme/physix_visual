# PhysxVisual — Perforce Depot 说明

本目录为 **PhysX Collision Visualizer 便携版**，供策划 / QA / 第三方在 Windows 10+ 上**双击即用**，无需安装 Node、无需编译 PhysX。

Depot 路径示例：`//GameProject/Tools/PhysxVisual/...`  
本地 workspace：`E:\qsp4\TSGame_Depot\GameProject\Tools\PhysxVisual`

---

## 使用（终端用户）

1. 同步本目录到本地  
2. 双击 `Open-Viewer.bat`（或 `打开碰撞可视化.bat`）  
3. 浏览器中打开 `collision.bin`（**不要**把 bin 提交到 depot）  
4. 关闭命令行窗口即停止服务  

详见 `USAGE.txt`。

---

## 维护者：更新 depot 内容

在开发机 `physix_visual` 仓库中执行：

```powershell
.\scripts\deploy-to-tools.ps1
# 默认目标：E:\qsp4\TSGame_Depot\GameProject\Tools\PhysxVisual
```

然后用 Perforce 提交变更。部署会镜像同步（robocopy `/MIR`），删除开发机已移除的文件。

**开发源码仓库（Git）：** https://github.com/yesmeisnotme/physix_visual  

---

## 应提交的内容

| 路径 | 说明 |
|------|------|
| `Open-Viewer.bat` / `打开碰撞可视化.bat` | 启动入口 |
| `USAGE.txt` / `P4DEPOT.md` / `.p4ignore` | 说明与忽略规则 |
| `scripts/` | bootstrap、start |
| `runtime/node/` | 便携 Node.js（约 50MB，保证离线双击） |
| `runtime/README.txt` | runtime 目录说明 |
| `converter/build/` | `physix_convert.exe` + PhysX DLL |
| `viewer/`（含 `node_modules/`） | Viewer + 依赖（约 250MB） |

合计约 **300MB**，为刻意打包的第三方可用体积。若团队 policy 禁止大二进制，需另议方案（仅提交脚本、目标机首次联网下载）。

---

## 禁止提交（已被 `.p4ignore` 排除）

| 路径 / 模式 | 原因 |
|-------------|------|
| `collision.bin` | 游戏地图数据，体积大且可能涉密 |
| `viewer/.cache/` | 转换缓存，本地自动生成 |
| `viewer/dist/` | 构建产物，本工具用 dev server |
| `runtime/downloads/` | Node 下载临时目录 |
| `*.gltf` / `*.gltf.bin` | 转换导出，属缓存 |
| `navmesh.bin` 等 | 本地调试文件 |

提交前建议：

```bat
p4 reconcile -n ...
p4 status
```

确认没有 `collision.bin` 或 `.cache` 被 add。

---

## Perforce 常用命令

在 `Tools\PhysxVisual` 目录下：

```bat
:: 首次加入 depot（路径按实际 depot 调整）
p4 add -f Open-Viewer.bat USAGE.txt P4DEPOT.md .p4ignore ...
p4 add -f scripts\...
p4 add -f runtime\...
p4 add -f converter\build\...
p4 add -f viewer\...

:: 日常更新（deploy 之后）
p4 reconcile -a -d -e ...
p4 submit -d "Tools: update PhysxVisual portable bundle"

:: 检查 ignore 是否生效
p4 ignore -v -i collision.bin
p4 ignore -v -i viewer\.cache\foo
```

`-f`：若目录含只读/本地生成文件，按团队规范使用。大目录首次 add 可能较慢。

---

## 目录结构

```
PhysxVisual/
├── Open-Viewer.bat
├── 打开碰撞可视化.bat
├── USAGE.txt
├── P4DEPOT.md          ← 本文件
├── .p4ignore
├── scripts/
├── runtime/node/       ← 便携 Node
├── converter/build/    ← 转换器 + DLL
└── viewer/             ← Web Viewer（勿提交 .cache）
```

---

## 目标机环境

- Windows 10+ x64  
- Edge / Chrome  
- 首次可能安装 **VC++ 2015–2022 x64**（bootstrap 可自动下载安装）  
- **不需要** Visual Studio、CMake、PhysX SDK、系统 Node  

---

## 联系人 / 问题

- 显示异常、碰撞类型疑问：联系工具维护者（physix_visual 仓库 issue）  
- P4 权限、体积 quota：联系项目 IT / build 团队  
