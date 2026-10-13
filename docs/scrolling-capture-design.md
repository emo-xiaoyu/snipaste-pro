# Pasty 长截图（Scrolling Capture）设计文档

状态：设计稿 · 2026-09-14 · 仅设计，不含实现改动。目标：在现有截图体系内加入"滚动 + 拼接"长截图，覆盖任意可滚动 Windows 应用（浏览器、Excel、VS Code 等）。

> 本文中的 IPC、文件、坐标约定均以当前代码为准：`electron/main.cjs`（捕获/编辑器/贴图/历史）、`electron/windows-bridge.ps1`（常驻 PowerShell 桥，`Graphics.CopyFromScreen` 原生采集 + `mouse_event` 注入已有先例）、`src/screenshot.jsx`（冻结画面 + 标注编辑器）、`electron/clipboard-core.cjs`（`capturePinBounds`、`defaultCaptureRegion`）。

## 2. 用户侧交互（UX）

**入口（不新增全局快捷键）**：现有截图浮层（`Alt+Shift+S`）的工具条新增「长截图」按钮，键盘用 `Shift+Enter` 触发。全局快捷键注册表属于受保护区域，本期不动；托盘菜单项作为可选后续（新增项、不改变既有结构）。进入长截图模式复用已预热的 `screenshotWindow`，不产生第二条启动路径。

**选区**：沿用光标居中的 520×320 预选，但进入长截图模式时默认把未手动调整过的选区纵向扩成"采集列"：520 × 显示器全高（水平仍以光标居中、贴边钳制）。自定义过的选区原样保留；拖动重选、八向手柄、Alt 拖动、方向键 1px、Shift+方向键缩放全部继续可用。提示建议避开滚动条：默认对检测到的滚动条竖条（内侧 ≤16 逻辑 px）自动内缩，可关闭。

**开始**：光标在选区内时按 `Enter`/空格或点击「开始」。光标不在选区内时，桥接进程把光标移到选区中心一次（有提示）。开始瞬间记录选区下窗口句柄（`windowFromPoint`），用于中途校验目标窗口是否被移动/缩放。

**滚动与方向**：由 Pasty 通过常驻桥注入滚轮（`wheelScroll`，注入前用 `SetCursorPos` 把光标停在选区内，模式已验证于 `scripts/verify-native-screenshot.ps1` 的 `mouse_event(0x0800)`）。方向由第一次成功对齐的 dy 符号自动判定，可用 `↑`/`↓` 翻转。步长自适应：初始约 360 滚轮单位，测得重叠 >80% 时加大（至多 3×），对齐失败或重叠 <15% 时减小。`空格`暂停/继续，`[` `]` 调速。用户手动滚轮也能被跟随（捕获在画面稳定后触发）：开始时浮层切换为鼠标穿透（`setIgnoreMouseEvents(true)`），滚轮直达下方应用。

**滚动中的实时预览**：浮层清空冻结画面，改为"滚动 HUD"：选区外保持原有暗化（形成聚光效果）；选区边框画在选区**外侧** 2px，保证被采集像素永远干净。HUD 面板自动放在选区外（右→左→下的暗区）：实时迷你图（整图按高度适配到 ≤240px 高，刷新 ≤1 次/秒；两次全量刷新之间只更新底部条带）、计数（已捕获 4,120 px · 7 块 · 速度 2×）、状态（滚动中/暂停/已到底）、按键提示（`Space 暂停 · Enter 完成 · Esc 完成/取消 · ↑↓ 方向 · [ ] 速度`）。面板区域短暂关闭穿透以便点击「完成 / 取消 / 暂停」。全部 UI 都在已预热的 `screenshotWindow` 内（`backgroundThrottling: false` 已有），不新增窗口。

**粘性头/尾**：自动识别"屏幕上位置固定"的横条并从拼接中剔除——页头只在长图顶部出现一次，页脚只在底部出现一次；误判时编辑器提供「裁掉顶部/底部 N px」的兜底调整。

**停止条件**：
- 手动：`Enter` 完成（保留）；`Esc`（≥2 块时完成保留，不足 2 块则取消）；HUD 上的完成/取消按钮；任意时刻按 `F4` = 停止并进入编辑器、同时武装"贴出区域"选择（贴合 F4=复制+贴图的肌肉记忆）。
- 自动：连续 3 次注入后画面稳定且无位移 → 视为到底，自动完成；达到高度上限自动完成；目标窗口移动/缩放（每 5 块校验一次）→ 带警告完成；连续 2 块对齐置信度过低 → 停止并保留已捕获部分；连续 2 块近似纯黑 → 判定受保护内容，中止并报错（不写历史）。

**完成之后**：拼接结果按普通截图持久化（`origin:'screenshot'`，`capture.mode:'scrolling'`），并交给已预热的 `screenshot.jsx` 编辑器——**不先裁选区**：长图本身就是选区列，标注仍在图像坐标系里（与现状一致）。编辑器新增文档视图：默认适宽、滚轮平移、`Ctrl+滚轮` 缩放（10%–400%）、右缘迷你滚动条。按键沿用：`Enter`/`Ctrl+C` 复制整张长图（若超过剪贴板安全体积则默认改为保存到文件并提示，附「仍复制」）；`F4`/`Ctrl+P` 复制并**贴出所选区域**（默认当前视口，见 §5）；`Esc` 保存进历史并关闭；双击切换 适宽/100%。

## 3. 技术方案

**选择 Option B（本机屏幕采集 + 注入滚动 + 拼接），实现上走 Pasty 已有的原生桥而非 `desktopCapturer`。**

- 为什么不是 A（嵌入 `webContents` + `capturePage`）：A 只能截 Pasty 自己拥有的页面；Pasty 要截的是第三方应用（Excel、VS Code、用户自己的 Chrome 会话），没有可用的 webContents，也无法跟随用户实时滚动状态。A 只适合"输入 URL 生成整页图"的另一种产品。
- 为什么不是 C（先试 A 再退 B）：目标应用里 A 全部不可用，"检测 + 回退"只增加分支没有覆盖收益。C 保留为未来 Pasty 自带 webview 时的特化路径。
- 为什么 B 可行：`windows-bridge.ps1` 已经是常驻 pwsh 进程（JSON-lines 协议，无每次启动开销），`Graphics.CopyFromScreen` 热路径全屏采集实测 70–85ms（LRN-20260814-006；`desktopCapturer` 同机约 480ms，故仅作回退）；滚轮注入所用 `mouse_event`/`SetCursorPos` 在本仓库验证脚本中已有可用先例。新增桥接操作只是同一进程上的新 op，不引入新进程、不新增依赖（sharp 已在打包清单中）。

### IPC 契约（新增 `scrolling-capture:*` 通道；handler 校验 `event.sender` 属于 `screenshotWindow`，与现有贴图 handler 的 sender 校验风格一致）

| 通道 | 方向/类型 | 载荷 → 返回 |
|---|---|---|
| `scrolling-capture:begin` | invoke | `{region{x,y,w,h}, displayId, direction:'auto'\|'down'\|'up', step}` → `{sessionId, scale{x,y}, maxHeight}` |
| `scrolling-capture:command` | invoke | `{sessionId, action:'pause'\|'resume'\|'speed'\|'direction'\|'finish'\|'cancel', value?}` → `{ok}` |
| `scrolling-capture:progress` | event 主→浮层 | `{sessionId, state, tileIndex, stitchedHeight, fixed{top,bottom}, atEnd, warning?, previewDataUrl?}` |
| `scrolling-capture:finish` | invoke | `{sessionId, pinIntent?}` → `{entryId, width, height, parts[]}`（主进程编码+落盘后自行打开编辑器） |
| `scrolling-capture:cancel` | invoke | `{sessionId, discardTiles:true}` → `{ok}` |

桥接内部 op（不暴露给渲染层）：`captureRegion`（按物理像素截取选区，**原样 BGRA 写临时文件，不做 PNG 编码**）、`wheelScroll`、`setCursorPos`、`windowFromPoint`。

### 状态机

`idle → selecting → scrolling (running | paused) → stitching → annotating → done`；终止态 `cancelled | failed`。`scrolling` 内每块走固定流水线：`inject → settle(稳定检测) → captureRegion → match/append → emit progress`。HUD 只消费 `scrolling-capture:progress`，主进程持有时钟与缓冲，渲染层卡顿不影响采集。

### 粘性去重与对齐（相邻块图像差分）

1. **偏移搜索**：取上一块中部条带（y∈[.35H,.65H]、x∈[.1W,.9W]、每 4px 采样），在当前块上滑动求 SAD，取最优 dy；要求最优得分 < τ 且与次优有明显间隔（唯一性），否则判低置信。
2. **固定横条判定**：dy 已知后逐行分类——`同屏位置几乎相同`（`|tileK[y] − tileK-1[y]| < τsame`）且 `不符合滚动关系`（`|tileK[y] − tileK-1[y−dy]| > τscroll`）的行是屏幕固定元素；顶部连续段 = 粘性页头（不参与追加），底部连续段 = 粘性页脚（不追加，最后一块的页脚在收尾时补一次）。最小段 4px、最大占 H 35%（防误判）。
3. **追加**：只写入 `[H−dy, H−bottom)` 行区间（去重叠、去页脚），丢页头；dy≈0 视为"无新内容"，计入 stop 判定。
4. **动态边缘列**：连续 3 块列残差都不满足滚动关系的窄列（右侧滚动条滑块、VS Code minimap 一类）默认裁掉并提示，可切换为"冻结首块该列"。
5. **置信度**：新增行中残差低于阈值的比例；连续 2 块低置信即停止保留部分结果（宁可少截，不出错图）。

### 高度/内存上限与 DPI

- `scrollMaxHeight` 默认 **20,000 物理 px**（可设 4,000–60,000），另有 6,400 万像素总量上限；拼接缓冲按 2,048 行分块分配（避免整块 realloc 峰值）；每块写入后立刻释放该块缓冲。80% 时提示；达上限自动停止并保存；用户选择"继续分段"时进入下一段（part N+1，独立 PNG，`capture.parts` 记录）。
- 编码：`sharp(raw,{raw:{width,height,channels:4}}).png()`（0.33.5 已随 OCR 依赖存在于 node_modules，且打包配置已 `asarUnpack`；libuv 线程池执行、不阻塞主线程，实测 1600×4000 约 33ms）→ 失败时回退 `nativeImage.createFromBitmap().toPNG()`。软保护：主进程 RSS > 1.2GB 强制停止保存。
- **DPI**：块采集一律物理像素；缩放系数沿用现有约定 `scale = sourceSize / display.bounds`（见 `captureDisplayImage`），拼接结果保持物理像素。贴图换算 `逻辑尺寸 = 物理尺寸 / scale`，与 `capturePinBounds` 同一公式，1:1 契约不破。多显示器：选区必须落在单一显示器内，跨界时钳制到占比更大者并警告；采集期间该显示器缩放变化则中止。

## 4. 数据模型与持久化

**会话文件** `%APPDATA%/pasty-clipboard/scrolling-capture-session.json`（begin 时创建；沿 `writeStoreAsync` 的原子写模式；finish/cancel 删除）：

```json
{
  "version": 1, "sessionId": "uuid",
  "state": "scrolling|stitching|finished|aborted",
  "startedAt": 0, "updatedAt": 0,
  "displayId": 0, "scale": 1.5,
  "region": { "x": 0, "y": 0, "width": 640, "height": 900 },
  "physical": { "x": 0, "y": 0, "width": 960, "height": 1350 },
  "direction": "down", "step": 360, "maxHeight": 20000,
  "stitchedHeight": 0, "fixed": { "top": 0, "bottom": 0 },
  "tiles": [{ "i": 0, "screenY": 0, "dy": 0, "rawFile": "scroll-tiles/<id>/0000.raw" }],
  "output": { "entryId": null, "parts": [] }
}
```

原始块文件放 `scroll-tiles/<sessionId>/`（配额 256MB，完成即删；仅保留最近一次会话用于崩溃恢复/排查，下次启动清理）。

**成品长图**：与现有截图完全同路径——`images/<sha1>.png`，经 `addImage(image,{pngBuffer, origin:'screenshot', asyncWrite:true, force:true})` 落盘；条目附带 `capture:{mode:'scrolling', region, scale, direction, tiles, stitchedHeight, parts, fixed}`。`isScreenshotEntry`（按 origin）不变；`migrateEntry` 原样透传新字段，无 store 版本迁移。

**OCR 交互**：**只对拼接结果做一次**（块级 OCR 会重复识别粘性头、还会在接缝处切断行）。实现上按高度 ≤4096px、重叠 64px 分带送入现有识别器（Paddle 主、Tesseract 备），把条目坐标映射回整图坐标、按行 IoU 去重合并，结果进现有 `pin-ocr-cache` LRU（键为 entry id）。触发默认按需（长图动辄几秒，不做后台常驻预热）；贴图小节的 OCR 保持现有"贴图可见后后台识别"路径不变。

## 5. 与现有功能集成

- **标注编辑器复用**：不走"先裁选区"，直接以现有 `screenshot:begin` 载荷（`imageBytes`）把拼接 PNG 交给已预热的 `screenshotWindow`，`task.captureMode:'scrolling'` 进入文档视图；标注、撤销/重做、导出逻辑不变（笔画仍在图像坐标）。高度 ≤16,384px 用整图解码渲染；超过则切换**分段渲染**（每次向主进程取 4,096 行区段，`scrolling-capture:view-section`），任何路径都不需要 >16k 的巨型 canvas/解码。带笔画导出整图时按 ≤2048 行分带合成后交主进程拼装；无笔画时直接复用主进程侧的 PNG 字节（快路径）。
- **从长图贴图**：整图 1:1 贴只有在能放下时提供（≤ 工作区高度 80%）；否则 `F4`/`Ctrl+P` 贴出选框区域（默认当前视口）。贴图逻辑尺寸 = 区域物理 px / scale，位置放在采集显示器（x 对齐原列，y 钳制在屏内）；预热贴图窗口、贴图 OCR、二次标注全部原样复用。同一长图可连续贴多个小节，编辑器不自动关闭。
- **历史列表**：`screenshot:get-history` 对长图不再回传整图 data URL，改为顶部裁切的封面缩略图（300×220）+ 角标（`长图 1,240×18,420`）；`thumbnailDataUrl` 的 300px 宽路径对长图同样走顶裁分支（避免生成 300×5000 的缩略图）。历史里对长图按 `Enter` 打开长图查看器（选节贴图），短图保持现状。

## 6. 性能预算

| 指标 | 目标（p95） | 依据/手段 |
|---|---|---|
| 热键 → 浮层可交互 | 维持现状 ~110ms | 既有原生桥热路径实测（99–110ms）；本功能在模式进入前不加任何工作 |
| 锁定选区 → 第一块入袋 | < 200ms | 常见路径直接裁冻结原图 ~10–20ms；若已滚动则一次区域采集 ~30–60ms + 匹配 ~5ms（热键→首块合计 ~140ms） |
| 每块拼接 | < 120ms | 注入 3–8ms + 稳定等待 20–60ms + 区域采集 25–60ms + 降采样/匹配/追加 6–15ms；进度事件节流 ≤4/s |
| 整图编码（一次） | ~0.2–1s（1600×20000，实现期实测） | sharp 线程池，不阻塞 UI；1600×4000 实测 33ms |
| F4 → 贴出可见 | 沿用预热贴图路径（实测 ~186ms + 区域裁切 ~30ms） | `acquirePinWindow` 预热壳不变 |
| `desktopCapturer` 冷启动 | 无关 | win32 路径不调用 desktopCapturer；桥进程随应用就绪常驻，掉线自动重启（250ms）；桥不可用时禁用「长截图」入口并提示 |

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 粘性头/尾重复出现 | §3 的"同屏位置固定"行分类 + 段长上下限；页脚只在收尾补一次；编辑器兜底手动裁切 |
| 动态内容变化（计时器、光标闪烁、视频、懒加载、虚拟化 feed） | 稳定检测门槛（连续两帧一致才采集）；低置信停止保留部分结果；动态边缘列裁除；虚拟化列表宁停不出错图 |
| 多显示器 DPI 不一致 | 选区限定单显示器、逐显示器取 scale、跨界钳制警告、缩放变化即中止 |
| 超长内容内存膨胀 | 高度 + 像素双上限、2,048 行分块分配、块即用即弃、RSS 软阈值、分段保存、可选降采样 |
| GPU/画布阻塞主线程 | 拼接全程 Buffer 数学（主进程，无 canvas）；预览只缩放小代理图（≤1 次/秒）；编码走 sharp 线程池；分带合成 ≤2048 行；绝不逐块 `toDataURL` |
| DRM/受保护内容、全屏独占游戏返回黑块 | 连续黑块（近纯黑：均值 <8 且方差 <4）即中止并给出可操作提示（改窗口化/关闭硬件保护）；不写历史 |
| 注入滚动打偏（光标离开选区、嵌套滚动容器、目标窗口移动/缩放、滚动条被选进区域） | 开始时记录 `windowFromPoint`，每 5 块校验窗口矩形；稳定检测 + 步长自适应（无位移先加大步长再判到底）；滚动条内缩；HUD 显示目标窗口标题便于即时发现 |
| 自动滚动改变应用状态（视频自动播放、信息流、Excel 选区移动） | 显式「开始」同意 + 全程可见 HUD + 暂停/Esc；文档说明这是任何滚动截图的固有属性 |

## 8. 分步实施计划（每步 ≤1 天）

| # | 任务 | 文件 | IPC/桥接变更 | 验证 |
|---|---|---|---|---|
| 1 | 桥接新 op：`captureRegion`(原始 BGRA)、`wheelScroll`、`setCursorPos`、`windowFromPoint` | `electron/windows-bridge.ps1`、`electron/windows-bridge.cjs`、`scripts/verify-scroll-bridge.cjs` | 新增桥 op（不新增进程） | 50 次 1200×800@150% 区域采集 p95 ≤60ms；注入一次滚轮 Chrome 位移可测；raw 文件可按 BGRA 读出 |
| 2 | 拼接核心（纯函数） | 新 `electron/scroll-stitch.cjs`、`tests/scroll-stitch.test.cjs` | 无 | 合成块对（已知 dy）、粘性头/尾样本、动态列、dy≈0 四类单测断言追加行数与固定带 |
| 3 | 会话 + IPC 骨架 | 新 `electron/scrolling-capture.cjs`、`electron/main.cjs`（仅 add require+handler）、`electron/preload.cjs` | `scrolling-capture:begin/command/progress/finish/cancel` | 调试入口跑 3 块机械流程；session 文件生成/清理；非 screenshotWindow sender 被拒 |
| 4 | 浮层模式 + 采集列 UI | `src/screenshot.jsx`、`src/screenshot.css`、新 `src/scrolling-capture-ui.jsx` | 用 begin/command/progress | `Shift+Enter` 进入；列预设 520×屏高；选区外描边；悬停面板时短暂恢复可点击 |
| 5 | 采集循环（注入→稳定→采集→追加） | `electron/scrolling-capture.cjs` | progress 事件 | 长页面 5 块实采，接缝残差 ≤τ；运行中暂停/继续；F4 中途完成 |
| 6 | 停止条件与上限 | 同上 + `electron/clipboard-core.cjs`（偏好默认值） | 无新增 | 到页底自动停；调低测试上限触发自动停；动态页低置信停止；DRM 视频黑块中止 |
| 7 | 实时预览 HUD | `src/scrolling-capture-ui.jsx`、新 `src/scrolling-capture-view.js`(+test) | progress 携带节流 `previewDataUrl` | 迷你图 ≤1 次/秒刷新、不丢块；浮层 CPU <5% |
| 8 | 完成：编码 + 落盘 + 进编辑器 | `electron/scrolling-capture.cjs`、`electron/main.cjs`(finish handler) | `scrolling-capture:finish` | 历史出现 `capture.mode:'scrolling'` 条目；PNG 可打开；会话与临时块清理；RSS 回落 |
| 9 | 文档视图（适宽/缩放/平移/迷你滚动条，>16k 分段渲染） | `src/screenshot.jsx`、`src/scrolling-capture-view.js`、`src/screenshot.css` | `scrolling-capture:view-section` | 1600×20000 可用；分段路径无巨型 canvas；100% 缩放下标注落点像素级正确 |
| 10 | 贴出区域 + 整图复制策略 | `src/screenshot.jsx`、`electron/main.cjs`(`screenshot:save` 分支)、`electron/clipboard-core.cjs`(`longPinBounds`)+tests | 扩展现有 `screenshot:save` 载荷（不加新通道） | F4 小节贴图实测 1:1（内容 bounds == 区域物理/scale ±1px）；超阈整图复制走保存提示；贴图 OCR 正常 |
| 11 | 历史与缩略图 | `electron/main.cjs`(缩略图/整图助手)、`src/screenshot-history.jsx`、`.css` | `screenshot:get-history` 返回封面字段 | 5 条长图列表渲染 <100ms；Enter 打开长图查看器；角标尺寸正确 |
| 12 | 加固、性能、文档 | 全部 + `scripts/verify-scrolling-capture.ps1` | 无 | `PASTY_QA_TIMING` 打出各项 p95；`npm test`、`npm run build`、`npm run test:sites` 全过；`dist/` 三件套在、受保护文件零 diff |

## 9. 测试计划

- **Chrome 长文章**（本地 30,000px fixture + 真实长文）：≥2 块、到底自动停、拼接高度 ≈ 各块新增行之和；每条接缝残差 <τ；无重复行；每块 p95 ≤120ms。
- **粘性头/尾页**（`position:fixed` 头 + 底部页脚）：顶部 100px 内恰好 1 个页头、底部 1 个页脚、中段 0 个。
- **Excel 滚动**（500 行数据；含冻结窗格变体）：逐行吸附不重复；冻结窗格按粘性带剔除；表尾/空白区触发"无变化"停止且不产出错图。
- **VS Code 长文件**：右侧动态区域按动态列策略裁除/冻结；光标闪烁允许 ≤2 行级差异；不崩溃。
- **动态信息流（Twitter/X）**：虚拟化导致一致性差时低置信停止 + 警告，保留已捕获部分，图片不撕裂。
- **DRM（Netflix 浏览器播放）**：黑块检测中止并提示；历史零新增；无崩溃。
- **多显示器混合 DPI**（150% + 100%）：150% 屏上每块 scale 正确；跨屏选区被钳制并警告；小节贴图 1:1 实测通过。
- **上限**：把测试上限调到 4,000px 触发自动停；"继续分段"生成 part 2；1600×20000 全程 RSS <700MB。
- **回归**：现有 `Alt+Shift+S` / F4 原位贴图 / 历史 / 剪贴板轮询不受影响（既有单测 + `verify-native-screenshot.ps1` 通过）。

## 10. 代码级骨架

**（a）`electron/main.cjs` — 新增 IPC handler（仅追加，不动窗口/快捷键/托盘注册表）：**

```js
const { createScrollingCapture } = require('./scrolling-capture.cjs');
const scrollingCapture = createScrollingCapture({
  bridge: windowsBridge,
  trace: traceScreenshotTiming,            // 复用 PASTY_QA_TIMING 打点
  addImage, writeStoreAsync,
  sessionPath: () => path.join(app.getPath('userData'), 'scrolling-capture-session.json'),
  openEditor: (display, payload, task) => openScreenshotEditor(display, payload, display.bounds, null, task),
  isEditorSender: (event) => BrowserWindow.fromWebContents(event.sender) === screenshotWindow,
  emit: (channel, payload) => screenshotWindow?.webContents.send(channel, payload),
});

ipcMain.handle('scrolling-capture:begin', (event, payload) => {
  if (!scrollingCapture.isEditorSender(event)) return { success: false, message: '无效的调用来源' };
  return scrollingCapture.begin(payload);   // -> { success, sessionId, scale, maxHeight }
});
ipcMain.handle('scrolling-capture:command', (event, payload) => {
  if (!scrollingCapture.isEditorSender(event)) return { success: false, message: '无效的调用来源' };
  return scrollingCapture.command(payload); // pause | resume | speed | direction | finish | cancel
});
ipcMain.handle('scrolling-capture:finish', (event, payload) => {
  if (!scrollingCapture.isEditorSender(event)) return { success: false, message: '无效的调用来源' };
  return scrollingCapture.finish(payload);  // 编码 -> addImage -> openScreenshotEditor({ captureMode:'scrolling', pinIntent })
});
```

**（b）`src/screenshot.jsx` — 状态形状（在现有组件内新增，不改既有 state 语义）：**

```jsx
// captureMode: 'frozen'（现状）| 'scrolling'（滚动 HUD）| 'long'（文档编辑器）
const [captureMode, setCaptureMode] = useState('frozen');
const [scroll, setScroll] = useState(null);
// scroll = {
//   sessionId, state: 'idle' | 'running' | 'paused',
//   region: { x, y, width, height },          // 冻结帧内坐标（物理 px）
//   tileCount, stitchedHeight, atEnd,
//   fixed: { top: 0, bottom: 0 }, direction: 'down',
//   speed: 1, warning: null, previewUrl: null, // preview 节流 ≤1/s
//   panel: { left, top }, hitTestPanel: false,
// }
const [longView, setLongView] = useState(null);
// longView = {
//   imageSize: { width, height },
//   zoom: 'fit' | 0.1..4,
//   viewport: { x, y, width, height },        // 当前可见的图像区域
//   sectioned: false, section: { y, height }, // 高度 > 16384 时启用分段
//   pinSection: null,                         // F4/Ctrl+P 的选区框（默认视口）
//   exporting: null,                          // 'copy' | 'pin' | 'save' 进度
// }
```

**（c）`electron/scroll-stitch.cjs` — 拼接核心（伪码，纯函数，便于单测）：**

```js
// 块 = 物理像素 BGRA Buffer（宽 W、高 H）。所有阈值都是常量，便于 fixture 单测。
function matchOffset(prev, curr, W, H) {
  // 1) 从 prev 取中部条带 rows[.35H,.65H) × cols[.1W,.9W)，每 4px 采样
  // 2) 在 curr 的候选 dy ∈ [2, .85H] 上滑动条带，逐采样点求 SAD
  // 3) 返回 { dy, score, margin }（margin = 次优 − 最优，用于唯一性判定）
}
function classifyRows(prev, curr, W, H, dy, tauSame, tauScroll) {
  // 行 y：sameOnScreen = |curr[y] − prev[y]|      < tauSame
  //        scrolled    = |curr[y] − prev[y − dy]| < tauScroll
  // fixed = sameOnScreen && !scrolled → 连续段经最小 4px / 最大 35%H 过滤
  // 返回 { top, bottom }（粘性页头/页脚高度）
}
function appendTile(session, prevTile, tile, meta) {
  const m = matchOffset(prevTile, tile, session.W, session.H);
  if (m.score > MAX_SCORE || m.margin < MIN_MARGIN) return { ok: false, confidence: 0 };
  const { top, bottom } = classifyRows(prevTile, tile, session.W, session.H, m.dy, TAU_SAME, TAU_SCROLL);
  const from = session.H - m.dy;          // 当前块中第一行新内容
  const to = session.H - bottom;          // 去掉粘性页脚
  if (to - from < 4) return { ok: false, confidence: 0, reason: 'no-movement' };
  blitRows(session.buffer, tile, from, to, session.height, { skipColumns: session.dynamicColumns });
  session.height += to - from;
  return { ok: true, dy: m.dy, fixed: { top, bottom }, confidence: 1 - m.score / MAX_SCORE };
}
```
