# Snipaste-Pro (Pasty) 架构调研与高价值扩展新功能方案报告

> **调研执行人**：Agent Team - researcher  
> **调研日期**：2026-09-23  
> **代码库目标**：`E:\snipaste-pro`  
> **团队目标**：调研当前 snipaste-pro 项目现有架构、功能边界与潜在扩展点，提出高价值新功能并给出技术可行性与具体实现设计，指导后续代码开发与验证。

---

## 目录
1. [项目定位与核心设计原则回顾](#1-项目定位与核心设计原则回顾)
2. [代码组织与系统架构全景分析](#2-代码组织与系统架构全景分析)
3. [现有核心功能及工作链路详述](#3-现有核心功能及工作链路详述)
   - 3.1 截图全流程与预选框交互
   - 3.2 离线 WinRT OCR 与文本复制
   - 3.3 F4 原位贴图与右键多维变换
   - 3.4 标注系统与撤销重做
   - 3.5 剪贴板管理、历史快照与安全过滤
   - 3.6 轻量化工程架构与便携分发策略
4. [行业对标与场景分析（Snipaste / PixPin / CleanShot X / ShareX）](#4-行业对标与场景分析)
5. [高价值扩展新功能候选清单与技术评估](#5-高价值扩展新功能候选清单与技术评估)
6. [落地优先级推荐与推荐实施方案](#6-落地优先级推荐与推荐实施方案)
   - 方案一：马赛克 / 模糊涂抹标注（Mosaic & Blur Redaction）
   - 方案二：荧光笔 / 半透明高亮画笔（Highlighter Pen）
   - 方案三：步骤序号标注（Step Counter Badges）
   - 方案四：取色器多格式切换与快捷键复制（Color Picker Enhancements）
   - 方案五：桌面贴图批量管理与全局显示/隐藏（Pin Manager & Visibility Toggle）
7. [对 Developer 角色的开发实施路线建议](#7-对-developer-角色的开发实施路线建议)

---

## 1. 项目定位与核心设计原则回顾

本项目（代码工程名为 `pasty-clipboard` / 简称 `Pasty`）是一款专为 Windows 平台打造的**高响应度、键盘优先（Keyboard-first）的剪贴板管理与 Snipaste 风格截图/贴图桌面效率工具**。

经过多次架构迭代与实践，项目在 `AGENTS.md` 中确立了若干条**刚性架构铁律**：
1. **极致轻量化（Lightweight Direction）**：
   - 生产环境实现零 npm 运行时依赖（`"dependencies": {}`）。
   - 严禁引入体积庞大的 ML 模型库或二进制依赖（已彻底剔除旧版 sharp、paddleocr、tesseract、onnxruntime 等庞然大物）。
   - 充分利用 Windows 原生系统内置能力：例如通过 PowerShell 桥接调用 `System.Drawing.Graphics.CopyFromScreen` 完成高速屏幕捕捉，调用 Windows 10/11 内置的 WinRT OCR 引擎（`Windows.Media.Ocr.OcrEngine`）实现高精度中英文离线文字识别。
2. **极速交互与预热机制（Zero Cold-Start Latency）**：
   - 截图编辑器窗口（`screenshotWindow`）在应用启动时即创建并处于预热隐藏状态（`backgroundThrottling: false`），截图唤出约百毫秒内即可呈现。
   - 贴图窗口（`pinWindow`）常驻一份热备隐藏 Shell，按 `F4` 时毫秒级分配显示并立即后台补充下一份热备。
   - 本地自动回贴（Paste keystroke）通过预热常驻的 PowerShell 桥接进程注入，本地延迟仅 ~35ms。
3. **高保真 1:1 原位贴图（Exact Pin Fidelity）**：
   - 截取的物理像素按屏幕缩放比（DPI）精确反算为 Windows 逻辑桌面坐标与逻辑宽高，贴图内容无内外边距、无拉伸变形，可像素级完美覆盖原屏幕区域。
   - 贴图窗口边缘透明外扩，承载区分背景的柔和虚影与 1px 微边框。
4. **会话级生命周期（Session-only Pins）**：
   - 贴图窗口仅在当前应用运行期有效，重启应用时不自动铺满桌面，防止历史贴图泛滥；历史截图数据完整异步持久化在本地 JSON 与图片文件中。

---

## 2. 代码组织与系统架构全景分析

项目采用清晰的 Electron + Vite + React 架构，代码组织规范且职责边界分明：

```
E:\snipaste-pro\
├── electron\                     # Electron 主进程与系统桥接层 (CommonJS)
│   ├── main.cjs                  # 主进程核心：窗口管理、快捷键、系统托盘、IPC路由、文件存储
│   ├── clipboard-core.cjs        # 剪贴板核心逻辑：条目分类、去重指纹、敏感保护过滤、坐标反算
│   ├── windows-bridge.cjs        # 原生常驻桥接管理：管理长期存活的 pwsh/powershell 进程
│   ├── windows-bridge.ps1        # C# P/Invoke + GDI+ 桥：前台窗口、屏幕拷贝、自动回贴按键注入
│   ├── win-ocr-core.cjs          # WinRT OCR 服务驱动：调度 PowerShell 5.1 单次进程执行与排队
│   ├── win-ocr.ps1               # WinRT Windows.Media.Ocr 原生离线识别脚本
│   ├── pin-ocr-cache.cjs         # 贴图 OCR LRU 缓存（上限 64 项，合并重复并发请求）
│   └── preload.cjs               # 上下文隔离的安全 IPC 桥（window.clipboardAPI）
├── src\                          # 渲染进程前端（React 19 + Fluent UI Icons + CSS）
│   ├── App.jsx                   # 主剪贴板浮窗：搜索、常用、图片分类、偏好设置、快捷键录制
│   ├── styles.css                # 主界面样式（暖白 + 鼠尾草绿 Spotlight 风格）
│   ├── screenshot.jsx            # 全屏截图与标注主编辑器
│   ├── screenshot.css            # 截图编辑器样式（遮罩、八向手柄、悬浮工具条、放大镜色值）
│   ├── screenshot-annotations.js # 标注核心纯函数：笔画绘制 (renderStrokes)、文字折行、选区钳制
│   ├── screenshot-selection.js   # 智能选区跟随光标与居中算法
│   ├── screenshot-editor-layout.js # 工具条动态避让与视口计算
│   ├── pin.jsx                   # 独立桌面贴图浮层：拖拽移动、滚轮缩放、右键菜单、文字交互
│   ├── pin.css                   # 贴图浮层样式（半透明文字选择框、操作提示、通知）
│   ├── pin-image-transform.js    # 贴图无损变换矩阵运算：顺逆旋转90度、水平/垂直翻转
│   ├── pin-text-selection.js     # 贴图 OCR 文字选择算法：字符碰撞检测、词边界、中文标点间隙清理
│   ├── screenshot-history.jsx    # 历史截图查看器：画廊轮播切换、Enter一键贴图
│   ├── capture.jsx               # 右下角复制捕获通知浮窗（无焦点、穿透鼠标）
│   └── shortcut-utils.js         # 快捷键事件解析与 Accelerator 匹配
├── scripts\                      # 构建与验证工具
│   ├── build-portable.mjs        # 绿色免安装单文件便携包构建脚本（解压即用）
│   ├── generate-app-icons.mjs    # 应用图标生成
│   └── prepare-sites-build.mjs   # Web 静态部署转换
└── tests\                        # 单元与集成测试（原生 Node test runner）
    ├── clipboard-core.test.cjs
    ├── pin-image-transform.test.cjs
    ├── pin-ocr-cache.test.cjs
    ├── pin-text-selection.test.cjs
    ├── screenshot-annotations.test.cjs
    ├── screenshot-editor-layout.test.cjs
    ├── screenshot-selection.test.cjs
    ├── shortcut-utils.test.cjs
    ├── state-merge.test.cjs
    └── win-ocr-core.test.cjs
```

所有 10 组 39 项单元测试均在 250ms 内飞速完成，代码质量与函数隔离度极高。

---

## 3. 现有核心功能及工作链路详述

### 3.1 截图全流程与预选框交互
- **触发入口**：全局快捷键 `Alt+Shift+S`（支持用户在设置中自定义）。
- **极速画面冻结**：主进程优先通过常驻的 `windows-bridge.ps1` 执行 GDI+ `CopyFromScreen`（平均耗时仅 70~85ms），无需拉起庞大的桌面流采集；若失败回退至 Electron `desktopCapturer`。
- **预热渲染呈现**：采集生成的 PNG 图像字节通过 IPC 传入预热的 `screenshotWindow`。渲染器加载完毕后触发 `screenshot:ready`，主进程将透明隐藏的全屏窗口显示并置顶。
- **智能预选框**：初始呈现光标居中的 `520 × 320` 建议框，在用户首次点击前**跟随鼠标实时游走**并贴边钳制；左键按下后停止游走；从任意处拖拽即可画出新选区；支持 8 向手柄拉伸、`Alt+拖拽`平移整框、方向键 1px 微调及 `Shift+方向键` 扩缩。
- **放大镜与色值检测**：光标移动时复用全局单例 1×1 Canvas 提取像素 RGBA，毫秒级在鼠标旁展示 HEX 与 RGB 色值，彻底避免 GC 抖动。

### 3.2 离线 WinRT OCR 与文本复制
- **零依赖原生引擎**：利用 `win-ocr.ps1` 调起 Windows 10/11 系统的 `Windows.Media.Ocr.OcrEngine`（zh-Hans 首选），返回精确的行、词级坐标。
- **单字级碰撞切割**：`win-ocr-core.cjs` 中的 `flattenWinOcrLines` 将词级包围盒平分推导为字符级 Hitbox，反向映射原始图片 DPI 坐标。
- **自然交互体验**：贴图上长按左键约 180ms 自动触发文字识别并进入文本模式；用户如拖动网页文字一般高亮选中，按 `Ctrl+C` 复制。
- **CJK 字符间隙优化**：`textFromSelection` 自动清理中文字符与标点符号之间因 OCR 误引入的额外空格，同时保留英文/数字词间正常空格。
- **并发与缓存管理**：`pin-ocr-cache.cjs` 实现 64 条 LRU 缓存，并发请求自动合并，避免重复解析。

### 3.3 F4 原位贴图与右键多维变换
- **快速贴图**：截图中按下 `F4` 或 `Ctrl+P`，直接取当前底图与已绘制的 Annotation 笔画合并导出 PNG Buffer，绕过剪贴板去重拦截，送入预热贴图窗口。
- **原位对齐**：使用 `setContentBounds` 精准还原在桌面物理坐标系下的位置，缩放比例为 1:1，与被截取区域无缝贴合。
- **滚轮等比缩放**：贴图支持滚轮缩放，以光标当前所指像素点为物理锚点进行等比放大或缩小（尺寸限制 80×60 至 4096×4096）。
- **右键丰富菜单**：
  - 保存到本地 PNG 文件；
  - 顺时针/逆时针旋转 90°、水平翻转、垂直翻转（保持中心点与长宽比，矩阵无损重绘并清理旧 OCR 缓存）；
  - 重新打开二次标注（以贴图当前桌面位置为基准打开标注编辑器，完成后就地替换贴图内容）。

### 3.4 标注系统与撤销重做
- **工具链**：目前支持 `select`（选区微调）、`pen`（自由画笔）、`arrow`（直线带箭头）、`rect`（空心矩形）、`ellipse`（空心椭圆）、`text`（带自动排版折行、回车换行、Ctrl+Enter 提交的文本框）。
- **属性配置**：提供 7 种精选对比色与 3 档线宽/字号调节。
- **撤销/重做**：完整的 `strokes` / `redoStrokes` 栈管理，快捷键 `Ctrl+Z` / `Ctrl+Y` / `Ctrl+Shift+Z` 支持。

### 3.5 剪贴板管理、历史快照与安全过滤
- **多数据格式**：支持文本、命令、网址、PNG 图片、本地文件路径及 HTML 富文本。
- **智能脱敏**：默认过滤密码、API 令牌、银行卡号等高危剪贴板数据。
- **历史画廊**：独立窗口（`Alt+Shift+V`）浏览截图历史，上下键翻页，一键重新贴图。

### 3.6 轻量化工程架构与便携分发策略
- **构建方式**：`npm run build:portable` 直接打包装配纯绿色 Portable Zip，包含主可执行文件 `Pasty.exe` 与极小的静态资源，无任何多余体积膨胀。

---

## 4. 行业对标与场景分析

我们深入对标主流标杆截图与贴图工具：
- **Snipaste**（Windows 截图贴图领域无可争议的经典基准）：
  - 核心强项：像素级精准选区、F3 贴图、马赛克/高斯模糊、荧光笔、取色器（C 复制、Shift 切换格式）、贴图组管理（Shift+F3 批量隐藏）。
  - Pasty 差距：缺少马赛克/模糊涂抹；缺少取色器格式切换和一键复制色值快捷键；贴图无全局一键隐藏；缺少荧光笔。
- **PixPin**（近年 Windows 平台黑马，结合 Snipaste + 离线 OCR + 长截图）：
  - 核心强项：内置离线文字识别、滚动长截图、步骤序号标注、贴图管理。
  - Pasty 差距：已实现优秀的 WinRT OCR，但缺少步骤序号标注、长截图与马赛克。
- **CleanShot X**（macOS 平台公认天花板体验）：
  - 核心强项：精美的半透明高亮笔（Highlighter）、自动步骤标注（1-2-3 气泡）、背景美化与长截图。
  - Pasty 启发：步骤标记（Step tool）极大提升写文档、提 Issue 和工单的效率；半透明荧光笔能让文档标注非常高级。
- **ShareX**（开源全能王，功能极度丰富但界面繁重）：
  - 核心启示：工具过多会导致界面混乱。Pasty 应当坚持 Snipaste/CleanShot 的简洁克制哲学，只集成高频、高审美、高实用的标注工具。

---

## 5. 高价值扩展新功能候选清单与技术评估

结合实际用户痛点，整理出 8 项高价值候选功能，并从**用户价值**、**技术可行性**、**轻量化契合度（零依赖）**三维度进行严格评估：

| 序号 | 候选新功能 | 用户场景与痛点 | 技术可行性 | 轻量化原则契合度 | 推荐优先级 |
|:---:|:---|:---|:---:|:---:|:---:|
| **1** | **马赛克 / 模糊涂抹标注 (Mosaic/Blur)** | 截图分享时遮挡密码、手机号、Token、头像等隐私信息（目前只能用纯色矩形盖住，极度不美观且不专业） | **极高**（Canvas 2D 离线像素采样与块绘制） | **100% 契合**（零外部依赖，十几行 Canvas 算法） | **P0（最高）** |
| **2** | **荧光笔 / 半透明画笔 (Highlighter)** | 对截图中特定段落、代码行做强调，底层文字必须透出清晰可见（目前普通画笔不透明会盖住文字） | **极高**（Canvas `globalAlpha` 或混合模式 `multiply`） | **100% 契合**（零依赖，复用现有 Pen 路径） | **P0（最高）** |
| **3** | **步骤序号标注 (Step Counter)** | 软件使用教程、Bug 复现步骤、SOP 指引标注，点击依次自动递增 ① ② ③ | **极高**（Canvas 圆形徽章 + 数字排版，内置递增计数） | **100% 契合**（纯前端组件状态） | **P0（最高）** |
| **4** | **取色器色值快捷复制与格式切换** | 前端开发、UI 设计师在截图界面按 `C` 复制当前光标处色值，按 `Shift` 切换 HEX/RGB/HSL 格式 | **极高**（已有 `samplePixel` 与放大镜 HUD，仅需增加键盘监听与剪贴板写入） | **100% 契合**（纯前端与现有剪贴板接口） | **P0（最高）** |
| **5** | **贴图全局隐藏/唤醒与贴图管理** | 桌面常驻多张贴图时，临时需要展示桌面或录屏，需一键隐藏/恢复全部贴图 | **高**（主进程维护 `pinWindows` Map，增加快捷键/IPC） | **100% 契合**（已有窗口 Map，仅需窗口状态切换） | **P1（高）** |
| **6** | **特殊粘贴扩展菜单 (Special Paste)** | 粘贴前快速处理大小写、去除换行、路径斜杠转换、JSON 格式化（参考已有的设计草案） | **高**（纯字符串变换函数与子菜单） | **100% 契合**（纯 JS 逻辑） | **P1（中高）** |
| **7** | **滚动长截图 (Scrolling Capture)** | 截取长网页、长代码文件或长聊天记录（已有设计文档） | **中**（需注入滚轮 + 屏幕采集 + 相邻图像差分对齐，不使用 sharp 时纯 Canvas 需分块处理巨图） | **中**（需精细控制内存与原生注入） | **P2（中低）** |
| **8** | **矢量标注元素二次选择与编辑** | 允许用户在绘制矩形、箭头后重新选中该元素并调整大小、移动位置 | **中**（当前架构为 Canvas 顺序光栅化绘制，需重构成完整的对象图元模型与 Hit-test） | **高**（前端重构量大，但无需新依赖） | **P2（低）** |

---

## 6. 落地优先级推荐与推荐实施方案

经过综合权衡用户呼声、ROI（投入产出比）及与现有代码的无缝融合度，强烈推荐**优先落地前四大核心功能**（P0 级），并在后续推进贴图管理（P1 级）。

以下给出前四个推荐功能的详细技术实现方案，供 `developer` 角色直接用于编码落地：

### 方案一：马赛克 / 模糊涂抹标注（Mosaic Tool）
#### 1. 交互与体验设计
- **工具入口**：在标注工具栏的画笔、箭头、矩形、椭圆、文字后新增马赛克按钮（使用 Fluent UI 图标，例如 `GridDots20Regular` 或方块像素图标）。
- **绘制交互**：
  - 支持拖拽画笔轨迹（类似自由涂抹笔刷）：鼠标扫过的区域被打上像素马赛克。
  - 线条粗细控制对应马赛克颗粒大小（例如：3px 细颗粒、6px 中颗粒、10px 粗颗粒，或对应块大小 8px、14px、22px）。
- **撤销/重做**：完美融入现有的 `strokesRef` 撤销/重做调用栈。

#### 2. Canvas 2D 极简轻量级实现算法（零依赖）
无需任何第三方图像库，在 `src/screenshot-annotations.js` 中扩展渲染能力：
```javascript
// 在绘制马赛克笔画时，基于底图 imageRef 进行局部像素块化：
// 1. 获取笔画经过的区域（或线段半径内的区域）
// 2. 将选区坐标离散化为 blockSize 网格
// 3. 取网格中心像素颜色，填充为纯色小方块 ctx.fillRect(bx, by, blockSize, blockSize)
```
或者利用 Canvas 高速降采样技术：
创建微型离线 Canvas，将待打码区域以 `1 / blockSize` 缩放绘制到微型 Canvas 上，再将微型 Canvas 以 `imageSmoothingEnabled = false` 放大绘制回原位置，执行效率为数微秒级，完美避免卡顿。

---

### 方案二：荧光笔 / 半透明高亮画笔（Highlighter Pen）
#### 1. 交互与体验设计
- **工具入口**：工具栏新增荧光笔按钮（图标使用 `Highlight20Regular`）。
- **视觉风格**：
  - 区别于普通画笔，荧光笔笔迹呈平头（或圆头扁平）半透明状态，透明度约为 `0.35` ~ `0.4`。
  - 使用 Canvas `globalCompositeOperation = 'multiply'` 或精确的透明 RGBA 颜色，确保无论涂抹多少次，底层的黑色文字或代码依然锐利可辨，绝不发灰泛白。
- **调色板兼容**：复用现有的颜色选取（黄、绿、蓝、粉等常用高亮色）和笔宽调节。

#### 2. 代码实现方案
在 `renderStrokes` 中补充 `stroke.tool === 'highlighter'`：
```javascript
else if (stroke.tool === 'highlighter') {
  context.save();
  context.lineCap = 'square';
  context.lineJoin = 'bevel';
  // 使用正片叠底或固定半透明度
  context.globalAlpha = 0.38;
  context.strokeStyle = stroke.color;
  context.lineWidth = stroke.lineWidth * 2.2; // 荧光笔稍宽
  context.beginPath();
  stroke.points.forEach((pt, idx) => idx ? context.lineTo(pt.x, pt.y) : context.moveTo(pt.x, pt.y));
  context.stroke();
  context.restore();
}
```

---

### 方案三：步骤序号标注（Step Counter Badges）
#### 1. 交互与体验设计
- **工具入口**：工具栏新增序号标注按钮（图标使用 `NumberSymbol20Regular` 或 `CircleSmall20Regular`）。
- **用户行为**：
  - 点击截图中某个目标位置，立刻放置一个带数字编号的圆形徽章（①、②、③...）。
  - 编辑器内部维护当前步骤序号 `stepIndex`（初始为 1，每次放置后自动递增）。
  - 按 `Ctrl+Z` 撤销最后一步时，计数器自动同步回退。
  - 切换工具或右键清空标注时重置计数。
- **视觉呈现**：
  - 圆形底色采用当前选中的主题色（如醒目的红、橙、蓝），内部居中绘制加粗白色数字；或带微小投影，保证在任何复杂背景下均清晰可见。

#### 2. 代码实现方案
在 `src/screenshot-annotations.js` 中：
```javascript
else if (stroke.tool === 'step') {
  const { x, y } = stroke.point;
  const radius = Math.max(12, stroke.fontSize * 0.7);
  context.save();
  // 绘制圆形背景
  context.fillStyle = stroke.color;
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fill();
  // 绘制数字文本
  context.fillStyle = '#ffffff';
  context.font = `bold ${Math.round(radius * 1.1)}px ${TEXT_FONT_FAMILY}`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(String(stroke.number), x, y + 1);
  context.restore();
}
```

---

### 方案四：取色器多格式切换与快捷键复制（Color Picker Enhancements）
#### 1. 交互与体验设计
- **现有现状**：目前在未确定选区或移动光标时，光标右下方已显示放大镜气泡，呈现 `#HEX`、`RGB r,g,b` 以及色块。但用户**无法直接把颜色复制出来**，必须手动框选截取。
- **增强特性**：
  - **快捷键 `C` 复制**：在截图预览状态下，按下键盘 `C` 键，立即将当前悬停像素的颜色值写入系统剪贴板，并在屏幕中央/气泡处弹出轻提示（如：“已复制颜色 #2F80ED”）。
  - **快捷键 `Shift` 切换格式**：按下 `Shift` 键，在当前支持的格式间循环切换：
    1. HEX（`#2F80ED`）
    2. RGB（`rgb(47, 128, 237)`）
    3. HSL（`hsl(214, 82%, 56%)`）
  - 气泡中高亮显示当前激活的首选格式。

#### 2. 代码实现方案
- 在 `src/screenshot.jsx` 的全局键盘监听中加入：
  ```javascript
  if (key === 'c' && pointerInfo && !textDraftRef.current) {
    event.preventDefault();
    const formattedColor = formatColorValue(pointerInfo, colorFormat);
    api?.writeClipboardText(formattedColor);
    // 显示复制成功短暂浮层提示
  } else if (event.key === 'Shift') {
    // 切换下一个颜色显示格式 (hex -> rgb -> hsl)
  }
  ```
- 纯逻辑无任何环境侵入，几分钟即可为前端与设计师用户带来质的飞跃。

---

### 方案五：桌面贴图全局显示/隐藏与贴图管理（Pin Visibility Toggle）
#### 1. 交互与体验设计
- **快捷键入口**：注册一个快捷键（如 `Shift+F4`）或在 Windows 系统托盘（Tray）菜单中增加：“隐藏全部贴图 / 显示全部贴图”。
- **状态维护**：主进程中的 `pinWindows = new Map()` 已经完整保存了所有活动贴图的 `BrowserWindow` 实例。主进程维护一个布尔标志 `pinsHidden`：
  - 触发隐藏时，遍历 `pinWindows`，记录当前处于可见状态的窗口并调用 `win.hide()`；
  - 再次触发时，调用 `win.show()` 批量恢复。
- **托盘菜单增强**：在托盘菜单的右键列表中动态显示“贴图数量 (N)”，并提供“关闭所有贴图”动作。

---

## 7. 对 Developer 角色的开发实施路线建议

为了保证开发节奏稳健、测试全绿、产物随时可验证，建议后续开发任务按如下工序进行：

1. **第一阶段（P0 标注工具集落地）**：
   - 在 `src/screenshot-annotations.js` 中新增 `mosaic`、`highlighter`、`step` 渲染器分支及相关辅助计算函数；
   - 在 `tests/screenshot-annotations.test.cjs` 中为新工具补充单元测试，验证参数运算、边界坐标与笔画生成；
   - 在 `src/screenshot.jsx` 工具条中引入相应 Fluent UI 图标与状态管理，打通鼠标交互与 `Ctrl+Z` / `Ctrl+Y` 栈。
2. **第二阶段（P0 取色器按键闭环）**：
   - 在 `src/screenshot.jsx` 中增加 `C` 键直接复制色值、`Shift` 键切换 HEX / RGB / HSL；
   - 补充格式转换单元测试并验证。
3. **第三阶段（P1 贴图全局切换与托盘支持）**：
   - 在 `electron/main.cjs` 中实现 `toggleAllPinsVisibility` 与 `closeAllPins`；
   - 增加托盘菜单项及对应 IPC 通道。
4. **第四阶段（完整回归与便携构建打包）**：
   - 运行全部自动化测试（`npm test`）；
   - 执行生产构建（`npm run build`）与便携版打包（`npm run build:portable`）；
   - 原生运行验证并交付最终验收。
