# 马赛克 / 模糊涂抹标注 实现方案

> **设计**：方案设计（功能开发小队）
> **日期**：2026-09-25
> **状态**：待 lead 确认后交由功能实现
> **基准调研**：`docs/feature-research-report.md` 方案一（P0 之首）

---

## 1. 选定方向与理由

**确认落地「马赛克 / 模糊涂抹标注」（Mosaic & Blur Redaction），不另选方向。**

- 调研报告将其列为 P0 之首：截图分享时遮挡密码、手机号、Token、头像等隐私信息，目前只能用纯色矩形硬盖，观感差。
- 技术上完全满足轻量化铁律（零运行时 npm 依赖、禁止引入图像库）：马赛克 = Canvas 降采样 + 最近邻放大，模糊 = Canvas 原生 `ctx.filter = blur()`，均为 Chromium 内建能力。
- 改动面小且完全封闭在渲染进程：`renderStrokes` 全仓库仅 `src/screenshot.jsx` 的 `draw()` 与 `finish()` 两处调用，主进程（`electron/`）零改动。

## 2. 需求与约束拆解

| 约束 | 来源 | 对设计的影响 |
|:---|:---|:---|
| 零运行时 npm 依赖、禁止图像库 | AGENTS.md 轻量化铁律 | 纯 Canvas 2D API 实现，不引入 sharp/pica 等 |
| 与现有 stroke 模型兼容、可撤销/重做 | 任务描述 | 新笔画复用 `points[]` 自由轨迹模型，进既有 strokes 栈，undo/redo 零改动 |
| Enter / Ctrl+C / 保存 / F4 贴图链路生效 | 任务描述 | `finish()` 与 `draw()` 走同一 `renderStrokes`，把底图作为 source 传入即可光栅化进最终 PNG |
| 单元测试跑在 Node（无 DOM/Canvas） | `tests/screenshot-annotations.test.cjs` 现状 | 渲染所需的 canvas 工厂必须可注入；`renderStrokes` 旧签名两参数行为不变 |
| 隐藏预热窗口的握手依赖渲染帧 | AGENTS.md 截图启动性能 | 不改窗口/时序逻辑；逐帧重绘路径复用现有 `scheduleCanvasRefresh` |
| 宽度三档 / 颜色七色为全局共享状态 | `screenshot.jsx` WIDTHS/COLORS | 复用同一 `lineWidth` 状态，映射函数按工具解释；颜色对 redaction 无意义需禁用控件 |

## 3. 现状梳理与改动面

```
src/screenshot-annotations.js   核心改动：新增映射纯函数、redactionBounds、renderStrokes 两个分支、效果缓存
src/screenshot.jsx              接线改动：beginStroke/onPointerMove 纳入新工具、工具栏两按钮、
                                宽度控件文案与预览、颜色控件禁用态、draw()/finish() 传 source
src/screenshot.css              小改：颜色控件禁用态样式（图标直接用 Fluent，无需自绘）
tests/screenshot-annotations.test.cjs  新增用例：映射、bounds、渲染调用序列、缓存、降级跳过
electron/**                     零改动（保存/贴图/历史走 renderer 产出的 PNG 字节）
```

关键接入点（当前行号，以函数名为准）：
- `beginStroke`（screenshot.jsx:376）：pen/highlighter 为 `points` 型笔画，其余 `start/end` 型。
- `onPointerMove` 绘制分支（screenshot.jsx:461-464）：pen/highlighter push 点后 `scheduleCanvasRefresh()`。
- `draw()`（screenshot.jsx:357-374）：整画布重绘 = `drawImage(image)` + `renderStrokes(context, strokes)`。
- `finish()`（screenshot.jsx:546-576）：裁剪变换下 `drawImage(image)` + `renderStrokes(context, strokes)` → toBlob → `saveScreenshot`。
- `renderStrokes`（screenshot-annotations.js:142）。

## 4. 工具交互设计

- **两个独立工具**：`mosaic`（马赛克）与 `blur`（模糊），各一个工具栏按钮，与 Snipaste 一致的分立交互；不引入模式切换 UI。
- **绘制交互**：自由涂抹笔刷，与画笔/荧光笔完全一致——按下开始、移动涂过、抬起提交；扫过区域基于**冻结底图**被打码/模糊。单击（无拖动）产生一个圆形涂抹点。
- **工具栏顺序**：`调整选区 | 画笔 | 荧光笔 | 马赛克 | 模糊 | 箭头 | 矩形 | 椭圆 | 文字 | …`，插在荧光笔之后。
- **图标**：`GridDots20Regular`（马赛克）、`Blur20Regular`（模糊）——已在当前安装的 `@fluentui/react-icons`（^2.0.316）中验证存在 20Regular 导出，与现有图标引入方式一致，无需 CSS 自绘兜底。
- **光标**：沿用 `.shot-stage` 默认 crosshair，无需新增。
- **键盘**：不新增快捷键；右键步退（goBack → undo）、Ctrl+Z/Ctrl+Y 撤销重做自动适用。
- 一旦落下任何笔画（含 redaction），选区工具照旧锁定（现有 `disabled={strokes.length > 0}` 逻辑，无需改动）。

## 5. 笔画数据结构

与现有 stroke 模型同构，直接进 undo/redo 栈：

```js
{
  tool: 'mosaic',          // 或 'blur'
  color: '#ef493f',        // 来自 beginStroke 的 base，渲染时忽略（保持结构统一）
  lineWidth: 3 | 6 | 10,   // 复用三档宽度状态，渲染时映射为笔宽/颗粒/强度
  points: [{ x, y }, ...], // 自由轨迹，图像物理像素坐标，与 pen/highlighter 相同
}
```

- 落笔创建于 `beginStroke`，移动中持续 push，抬起后对象不再变异（这是效果缓存成立的前提）。
- 无新增序列化/持久化格式：编辑器笔画本就仅会话内存在，保存时全部光栅化进 PNG。

## 6. 参数映射（新增导出纯函数，风格对齐 `highlighterLineWidth`）

```js
export function redactBrushWidth(lineWidth) {
  // 涂抹带宽度（图像物理 px），mosaic 与 blur 共用
  // 3 → 26, 6 → 46, 10 → 74
}
export function mosaicBlockSize(lineWidth) {
  // 马赛克颗粒边长（px）：3 → 8, 6 → 14, 10 → 22（与调研报告建议一致）
}
export function blurRadius(lineWidth) {
  // 高斯模糊半径（px）：3 → 6, 6 → 10, 10 → 16
}
```

均为分段映射（≤3 / ≥10 / 中间），区间外钳制到端点，实现方式照抄 `highlighterLineWidth`/`textFontSizeFromLineWidth`。

```js
export function redactionBounds(stroke, size, options = {})
// size = { width, height }（底图尺寸）
// 返回 { x, y, width, height }：
//   1) points 包围盒四向外扩 redactBrushWidth/2；
//   2) 钳制到 [0, size.width/height]；
//   3) tool === 'mosaic' 时对齐全局颗粒网格：x = floor(x/k)*k, y 同理（k = mosaicBlockSize），
//      保证相邻/重叠笔画与图像绝对网格对齐、块缝无缝拼接；
//   4) 单点笔画 → 以该点为中心、边长为笔宽的正方形再走 2)/3)。
```

## 7. 渲染算法

### 7.1 renderStrokes 签名扩展（向后兼容）

```js
renderStrokes(context, strokes, options = {})
// options = { source, createCanvas }
//   source: 冻结底图（HTMLImageElement），redaction 采样的唯一来源
//   createCanvas(width, height): 效果画布工厂，缺省用 document.createElement('canvas')；
//                                无 document 且未注入时 redaction 分支跳过（防御，不抛错）
// 旧调用 renderStrokes(context, strokes) 行为完全不变；source 缺失时 mosaic/blur 笔画跳过渲染。
```

### 7.2 单个 redaction 笔画的渲染管线（统一四步）

以 `bounds = redactionBounds(stroke, source 尺寸)` 为准：

1. **查缓存**：模块级 `WeakMap<stroke, { canvas, x, y }>`，命中则 `context.drawImage(entry.canvas, entry.x, entry.y)` 返回。
2. **生成效果位图**（离屏 effect canvas）：
   - **mosaic**：先建 small canvas（`ceil(w/k) × ceil(h/k)`），`imageSmoothingEnabled = true` 把 `source` 的 bounds 区域降采样进去（平滑取平均）；再在 effect canvas 上 `imageSmoothingEnabled = false` 最近邻放大回 bounds 尺寸——硬边像素块。两步 drawImage，微秒级。
   - **blur**：effect canvas 尺寸取采样区 `sample = bounds 四周外扩 pad = 2×radius（钳制到图像内）`；`ectx.filter = 'blur(${radius}px)'` 后整幅 drawImage source 对应区域，`filter = 'none'` 复位。pad 防止高斯核在区域边缘取样发黑/发虚；遮罩后多余部分本就透明，最终整幅回贴无副作用。
3. **路径遮罩**：`ectx.globalCompositeOperation = 'destination-in'`，坐标平移 `-x/-y`（mosaic 用 bounds 原点，blur 用 sample 原点），以 `lineWidth = redactBrushWidth`、`lineCap/lineJoin = 'round'` 描一遍 points 路径（单点时 moveTo+lineTo 同点画出圆点），只保留笔刷覆盖区。
4. **缓存并回贴**：写回 WeakMap，`context.drawImage(effect, x, y)`。超大保护：effect 面积 > 16,777,216 px（4096²）时跳过缓存直接渲染，防内存膨胀。

**关键语义决策——效果永远从原始底图取样，绝不采样当前画布**：
- 重叠涂抹不会「马赛克上的马赛克 / 二次模糊」不可预期加深；
- 撤销后重画完全确定、幂等；
- redaction 会一并盖住此前画在其上的普通标注（隐私遮挡语义正确，与 Snipaste 行为一致）。
- 推论：redaction 笔画按数组顺序渲染在其之前笔画之上；缓存仅在「同 stroke 对象 + 同一 source 对象」下有效，同一次编辑会话内 `imageRef.current` 身份稳定，天然满足。

### 7.3 缓存失效

```js
export function invalidateRedactionCache(stroke) // WeakMap.delete，未命中为 no-op
```

进行中的笔画在 `onPointerMove` 每次 push 点后调用（`screenshot.jsx` 绘制分支内，一行）；提交后的 stroke 永不变异，缓存随 WeakMap 自动回收。这样每帧 `draw()` 只有进行中的那一条 redaction 需要重建位图，已提交的全部走缓存 drawImage，保证大图连续涂抹依然 60fps。

## 8. 工具栏与颜色/宽度联动（screenshot.jsx）

- **工具按钮**：荧光笔按钮后插入两个按钮，引入 `GridDots20Regular`、`Blur20Regular`，`chooseTool('mosaic')` / `chooseTool('blur')`。
- **beginStroke / onPointerMove**：pen/highlighter 的判断改为集合判断 `['pen', 'highlighter', 'mosaic', 'blur']`（如 `FREEHAND_TOOLS`），新工具走同一 `points` 分支；move 分支内在 push 后调用 `invalidateRedactionCache(action.stroke)`（对非 redaction 笔画是廉价 no-op，可无条件调用）。
- **颜色控件**：tool 为 mosaic/blur 时禁用——trigger 按钮加 `disabled`、容器加 `color-control--disabled` 类，title 提示「马赛克/模糊不使用颜色」；CSS 复用现有禁用观感（opacity .32、not-allowed），popover 不再展开。
- **宽度控件**：三档 `WIDTHS` 复用；文案按工具切换——text「文字大小」/ mosaic「马赛克颗粒」/ blur「模糊强度」/ highlighter「荧光笔粗细」/ 其余「线条粗细」；触发条与档位预览 `<i>` 高度：mosaic 与 blur 用 `Math.max(3, redactBrushWidth(item) / 4)`（照抄 highlighter 的预览模式）。
- **draw()/finish()**：`renderStrokes(context, strokesRef.current, { source: image })`。
- **工具栏初始尺寸**：默认 `toolbarSize { width: 580 }` 上调约 +78（≈656），减小首帧避让偏差（ResizeObserver 随后自动纠正，低风险）。

## 9. 保存 / 复制 / F4 / 贴图链路（确认无需额外改动）

- `finish()` 在裁剪平移/缩放变换下调用 `renderStrokes(context, strokes, { source: image })`，redaction 以图像绝对坐标回贴，被变换正确映射 → 输出 PNG 即含打码效果。
- 主进程 `saveScreenshot` 收到的是 renderer 产出的 PNG 字节 → 保存文件、剪贴板复制、F4 原位贴图、历史缩略图全部自动生效。
- 贴图右键「重新标注」（editPinId 流程）以贴图当前光栅为底图打开编辑器 → mosaic/blur 天然可用，完成后照常替换会话贴图；不触碰 pin 变换矩阵与 OCR 缓存模块。

## 10. 分步实现计划

| 步骤 | 内容 | 产出/验收 |
|:---:|:---|:---|
| 1 | `screenshot-annotations.js`：三个映射函数 + `redactionBounds` + `invalidateRedactionCache` + `renderStrokes` 的 mosaic/blur 分支与缓存（不动 jsx） | 现有工具渲染行为零变化 |
| 2 | `tests/screenshot-annotations.test.cjs` 新增用例（见 §11），`npm test` 全绿 | 测试先行锁定契约 |
| 3 | `screenshot.jsx` 接线（beginStroke/move/工具栏/宽度/颜色禁用/draw+finish 传 source）+ `screenshot.css` 禁用态 | 功能可用 |
| 4 | `npm test` + `npm run test:sites` + `npm run build` + 手工验收清单（§12） | 全绿 + 验收通过 |
| 5 | （可选，lead 决定）AGENTS.md 增补一条标注工具集持久设计决策 | 文档同步 |

## 11. 测试计划（node --test + mock，对齐现有风格）

1. **映射**：`[3,6,10].map(redactBrushWidth/mosaicBlockSize/blurRadius)` 深比较；越界值（0、99）钳制到端点。
2. **redactionBounds**：多点路径外扩半笔宽；贴图像边缘钳制；单点 → 笔宽正方形；mosaic 结果对齐 k 网格（`x % k === 0`）。
3. **renderStrokes · mosaic**（mock context + mock source + 注入 `createCanvas` 工厂，工厂返回带 mock 2d context 的假 canvas）：
   - 断言调用序列：small canvas 对 source 的降采样 drawImage（源矩形 = bounds）→ effect canvas 最近邻放大（`imageSmoothingEnabled === false`）→ `destination-in` 描路径 → 主 context `drawImage(effect, x, y)`；
   - mock 2d context 记录属性快照（globalCompositeOperation、filter、imageSmoothingEnabled）。
4. **renderStrokes · blur**：采样矩形含 `pad = 2×radius` 且钳制；`filter` 先 `'blur(10px)'` 后复位 `'none'`。
5. **降级**：不传 options（旧签名）或无 `createCanvas` 时，含 mosaic/blur 笔画的调用不抛错、不产生 drawImage。
6. **缓存**：同一 stroke 渲染两次，`createCanvas` 只被调用一次（第二次直接回贴）；`invalidateRedactionCache(stroke)` 后重建。
7. **回归**：现有 6 个用例不变全绿。

## 12. 手工验收清单

- [ ] 涂抹含密码/文字区域后不可辨认；三档颗粒/强度差异肉眼可辨
- [ ] 单击产生圆形打码点；贴屏幕边缘涂抹不越界、不报错
- [ ] 重叠涂抹无「二次打码」加深；撤销 → 原图完全恢复；重做一致
- [ ] Enter / Ctrl+C 复制的 PNG、保存的文件、F4 原位贴图三者内容一致且含打码
- [ ] 贴图右键「重新标注」中可用马赛克，完成后就地替换
- [ ] 4K 截图上快速大面积涂抹流畅（无肉眼可感卡顿）
- [ ] 原有 7 个工具、颜色/宽度联动、文字标注行为回归不变

## 13. 风险点与对策

| # | 风险 | 评估与对策 |
|:---:|:---|:---|
| 1 | `ctx.filter` 兼容性 | Electron 43（Chromium ≥ 100）完整支持；Node 测试仅记录字符串不执行滤镜。低风险 |
| 2 | 大轨迹 / 大图逐帧重绘性能 | WeakMap 缓存 + 仅进行中笔画逐帧重建 + 4096² 缓存上限。中低风险 |
| 3 | Node 测试无 DOM | `createCanvas` 可注入；无工厂时安全跳过而非抛错。已消解 |
| 4 | 画布状态泄漏（smoothing/filter/composite） | effect canvas 上所有状态变更以 save/restore 或显式复位包裹；主 context 只收到等尺寸 drawImage |
| 5 | blur 边缘渗色 | 采样区外扩 2×radius 再遮罩，多余部分透明。已消解 |
| 6 | mosaic 网格不对齐导致笔画接缝 | `redactionBounds` 对齐全局 k 网格。已消解 |
| 7 | 颜色控件禁用态的可发现性 | title 明示「马赛克/模糊不使用颜色」；与 text 工具复用宽度档位的先例一致 |
| 8 | 首帧工具栏避让偏移 | 初始 toolbarSize 默认值上调；ResizeObserver 自动纠正 |
| 9 | redaction 盖住先前标注造成误解 | §7.2 语义决策已明示为预期行为（与 Snipaste 一致），验收清单覆盖 |
| 10 | 轻量化铁律 | 纯 Canvas 2D，零新增依赖；`package.json` dependencies 保持 `{}` |
