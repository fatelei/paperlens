# PaperLens

本地桌面 OCR 与文档复核工具。Go + Wails，使用 MiniCPM-OCR 1.0 识别、独立 MiniCPM-OCR-Jev 模型核验，支持 macOS Apple Silicon 和 Windows x64。当前版本：0.5.9（预览版）。

## 使用流程

1. 在「模型与设置」下载 OCR 模型、安装并启动 OCR 引擎；独立核验环境按下方说明安装。
2. 导入 PDF、PNG、JPG 或 WebP，点击「识别全部页面」。自动分栏、分段，逐段识别、核验并尝试校对低分内容。
3. 点击「下一处待复核」进入对应段落的可编辑模式。对照左侧原图修改文字；人工确认后自动跳到下一处，可撤销上一次复核。
4. 查看「校对版」与修改对照，复制或导出 TXT、Markdown、JSON。人工修改优先保留并同步到校对版。

「继续识别未完成内容」只补未完成段落；单页「重新识别」会确认后替换该页自动段落。识别期间可导入其他文件；任务未结束时禁止导出半成品。关闭应用会停止由应用启动的模型进程。

## 校对与限制

- 图片和扫描件：检测遗漏区域，对低分段落有限次重识别，再由 Jev 核验候选；达标才进入校对版，原始结果保留。
- 含可靠可见文字层的 PDF：以文字层及坐标生成独立校对版；隐藏 OCR 层不直接作为可信原文。
- Jev 分数用于筛选区域，不是逐字准确率。较高分也可能漏字；自动分区与重识别不能保证完整或正确。重要内容仍应对照原图。
- 人工编辑会使旧评分失效。人工复核表示使用者已检查，不是模型验证结果。
- 文档与编辑保存在本机 WebView 的 IndexedDB。请及时导出；移动应用包路径可能改变 WebView 存储位置。

## 首次安装模型

OCR 模型和引擎可在设置页下载。独立 Jev 核验、版面检测与渲染环境需要 Python 3.12+、Node.js 和首次联网：

```sh
python3 local_jev/install.py
```

Windows 使用 `py -3 local_jev/install.py`。脚本在应用数据目录创建隔离环境，下载校验过的模型、引擎与 Chromium。安装后识别与核验无需云端 API Key。模型、运行配置及用户文档不包含在本仓库中。

本机数据目录：macOS 为 `~/Library/Application Support/PaperLens`，Windows 为 `%APPDATA%/PaperLens`。OCR 日志为 `engine.log`，核验日志为 `local-jev/jev.log`。服务只监听回环地址，使用临时本地令牌；核验渲染器阻止 HTTP/HTTPS 外部请求。

## 构建与测试

需要 Go 1.23+；macOS 需要 Xcode Command Line Tools，Windows 需要 WebView2 Runtime，生成 Windows 安装包还需 NSIS。前端为仓库内静态资源，无需安装 npm 依赖即可运行单元测试。

```sh
go test ./...
npm test
sh scripts/build-macos.sh
sh scripts/build-windows.sh
```

macOS 输出 `build/bin/PaperLens.app`；Windows 输出 `build/windows/PaperLens.exe`，检测到 NSIS 时同时生成安装包。macOS 构建为 ad-hoc 签名，未公证；Windows 尚未做真实设备验证。

浏览器交互测试使用 Playwright 和 Chrome，例如：

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/workflow-ui.mjs
```

`tests/*-ui.mjs` 和 `tests/ui.mjs` 使用明确的模拟原生桥接，验证交互与故障恢复，不代表真实模型精度。`live_test.go` 等通过环境变量显式开启本地模型测试；日常测试默认跳过真实模型。

## 主要目录

- `app.go`、`engine.go`、`inference.go`：应用设置、模型生命周期与推理。
- `layout.go`、`local_jev/`：版面检测、独立 Jev 安装与运行。
- `frontend/dist/`：主界面、段落状态、校对与人工复核历史。
- `tests/`：状态单元测试、交互回归与合成测试图片。
- `scripts/`、`packaging/`：macOS 与 Windows 构建。

## 第三方来源

OCR/Jev 使用 OpenBMB MiniCPM-OCR 系列；独立核验 SDK 固定于提交 `f5357c72e1605698fa857d74222c0414ca369ae3`，副本与许可证保留于 `local_jev/service/`。Wails、llama.cpp、PDF.js、字体及相关组件的许可分别遵循其上游许可；第三方许可文件随对应目录保留。模型的下载与使用须遵守其模型卡许可。

## 0.5.8 细节校对

对代码、图表和文档词汇支持的可疑断词追加小块复读。断词候选需独立逐行识别支持并通过 Jev；SQL 点号/下划线只从核验通过的小块迁移，部分修正仍标待复核。图表尝试提取孤立数字与文字标签，不按等差规律猜补刻度。整段替换需要原文字覆盖及逐块、整段核验均通过。失败记录与候选可在 JSON 导出中审计；人工编辑仍优先。

GitHub Actions 在 main 推送、PR 和手动触发时运行 Go race、前端与布局单元测试、浏览器交互测试，再构建 macOS Apple Silicon 和 Windows x64，保留下载产物 14 天。构建包不含模型、不做公证或发行签名。配置见 [.github/workflows/ci.yml](.github/workflows/ci.yml)。


## 0.5.9 小字号与换行核验

细节 OCR 与 Jev 使用同一固定等比例放大和白边输入，小字号不再直接用紧贴字形的原始裁剪评分；审计仍保留原始裁剪分数。复核阈值未降低。普通正文的物理行末断词可依据相邻位置、文档词汇及逐行核验作局部修正；SQL 减号和行内连字符不进入此路径。局部修正不代表整段通过，人工修改仍优先。

图表数字行按共同字形高度排除相邻坐标轴碎片，再逐刻度独立识别与核验；全部数字必须与整行候选一致且均通过原阈值。数量不符、低分或字符冲突会作废旧整行高分，不按等差数列补值。
