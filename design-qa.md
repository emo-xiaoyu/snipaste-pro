# Design QA

## 2026-08-14 · 鼠标预选、F4 延迟与贴图滚轮缩放

- 初始选区固定为鼠标光标居中的 `520 × 320` 小框，不再查询或自动采用前台窗口边界；仍保留全屏冻结画面，用户可随时重新框选和拖动八向手柄。
- 截图呼出在主窗口、复制提示和截图历史均已隐藏时不再固定等待；确实需要隐藏 Pasty 自身窗口时只等待一个约 16ms 的合成帧。
- F4 的原生全局监听在截图任务排队时提前注册；最终图片直接由冻结原图和标注层渲染，不再先清除选区并等待两个动画帧。
- 桌面贴图支持鼠标滚轮等比例缩放，缩放时维持鼠标所指图像点的桌面位置，并限制在至少 `80 × 60`、至多 `4096 × 4096` 的实用范围内。
- 自动化覆盖缩放放大、缩小、鼠标锚点、宽高比及最小/最大尺寸，12 项核心测试与 4 项 Sites 测试通过，Vite 生产构建通过。
- 原生 Electron 回归使用当前已保存的 `Alt+X`：截图编辑器成功出现，F4 新增 1 条历史并原位生成 `520 × 320` 贴图；鼠标放在贴图中央向上滚轮后，客户区变为 `582 × 358`，中心桌面坐标保持不变。
- 首次原生滚轮探针发现全窗 `-webkit-app-region: drag` 会吞掉 DOM 滚轮事件；现已改为显式指针拖动，因此整图拖动与滚轮缩放可以在同一图面共存。
- F4 贴图窗口改为启动时预热一份隐藏渲染器，图片解码完成即显示；使用后立即在后台补充下一份，不再等到 F4 后才新建并加载首个贴图页面。
- 性能探针发现原实现的主要 F4 阻塞来自同步图片/历史处理与每次广播重建全部缩略图，而非窗口创建；现改为复用渲染器传入的 PNG、异步原子落盘和缩略图缓存。
- 最终原生计时：`Alt+X` 到冻结截图窗口可见约 `676ms`（其中 Windows/Electron 整屏采集约 `508ms`）；F4 到原位贴图可见约 `186ms`，历史在贴图出现后约 `52ms` 完成持久化。贴图从 `520 × 320` 以鼠标为中心滚轮放大到 `652 × 401`，中心坐标保持不变。

## 2026-08-13 · 截图唤出与 F4 原位贴图回归修复

- 修复预热窗口的 IPC 时序：React 注册 `screenshot:begin` 监听后主动向主进程报到，主进程在此之前保留最新截图任务，不再丢失首次唤出。
- 修复隐藏窗口动画帧被节流：截图编辑器启用 `backgroundThrottling: false`，并使用 48ms 幂等兜底，冻结画面绘制完成后可靠显示。
- 显式截图保存绕过剪贴板轮询的重复内容抑制，因此连续截取同一区域仍可按 `F4` 创建贴图。
- F4 贴图使用 `setContentBounds` 将网页客户区直接放到选区映射坐标，不再以透明 CSS 阴影边距补偿位置。
- 原生回归证据：当前保存的截图快捷键为 `Alt+X`；触发后发现唯一可见的 `Pasty 截图` 窗口；按 `F4` 后截图历史新增 1 条，并创建 `Pasty 贴图`。
- 测试贴图的窗口边界和客户区边界均为 `x=1076, y=573, 896×641`，两者完全一致，不再存在不可见窗口边框造成的偏移。
- 验证用贴图已关闭；验证用单条截图历史已从本地数据中清理。

### F4 原生按键接管

- 截图窗口显示期间由 Electron 主进程注册全局 `F4`，不再依赖网页是否获得键盘焦点。
- 主进程收到 `F4` 后向当前编辑器发送 `screenshot:pin-request`，编辑器统一执行现有“复制 + 保存 + 原位贴图”路径。
- 截图窗口隐藏时立即注销 `F4`，不会占用其他应用中的 F4 操作；网页键盘监听仅保留为兼容回退。

### F4 贴图可见性修复

- 保存顺序改为“写入剪贴板 → 隐藏全屏截图层 → 创建贴图”，避免贴图在截图遮罩仍位于最上层时被生成到后方。
- 新贴图不再使用 `showInactive`，而是主动 `show + moveTop + focus`，并在 80ms 后再次确认最高置顶层级。
- 贴图创建结果会返回截图保存链路；创建失败不再只留下已复制的图片却静默报告成功。


## 2026-08-13 · Snipaste 风格截图核心交互

- 截图触发后优先自动框选当前前台窗口，鼠标附近区域仅作为无法获取窗口边界时的回退。
- 保留全屏冻结画面与自由重框；方向键以 1 像素移动选区，`Shift + 方向键` 调整右/下边界。
- 增加实时 HEX / RGB 像素信息、椭圆、颜色、线宽、撤销和重做。
- `Enter` 或双击选区复制并完成，`F4` 固定到桌面；右键按“取消当前动作 → 撤销标注 → 恢复智能预选 → 清空选区 → 退出”逐级返回。
- 参考 Snipaste 的操作模型，但沿用 Pasty 的暖白与鼠尾草绿界面，不复制其品牌和图形资产。

### 鼠标重框校准

- 自动预选不再占用选区内部的普通拖动；左键从冻结画面任意点拖动都会以该点为起点建立新选区。
- 边角与边线仍用于调整当前选区，移动整个选区改为 `Alt + 拖动`，避免和重新框选冲突。
- `F4` 使用同一张最终裁剪结果完成“写入剪贴板 + 固定到桌面”。

### 原尺寸原位置贴图校准

- 将截图的物理像素坐标按当前显示器的逻辑边界反算为桌面坐标，兼容 Windows 125%、150% 等 DPI 缩放。
- 新建贴图窗口使用最终选区的原 x/y、宽度和高度，不再统一压缩到 520 × 420。
- 贴图内容移除 4px 内边距、边框、圆角、阴影与 `object-fit: contain` 留白，未缩放时可与原页面区域像拼图一样对齐。
- 历史截图重新贴图因没有原始选区坐标，仍采用居中适配尺寸；只有当前截图的 `F4` 路径保证原位 1:1。

### 截图呼出性能与贴图区分

- 截图编辑器改为应用启动时预热并在每次截图后隐藏复用，不再为每次快捷键重新创建和加载页面。
- 前台窗口信息与边界合并为一次常驻原生桥接请求，并与 24ms 的窗口隐藏等待并行执行；原 80ms 固定等待已移除。
- 编辑器在冻结图解码并首次绘制前保持完全透明隐藏，避免先出现黑色全屏窗口再跳成截图画面的闪烁。
- 贴图增加 1px 半透明内沿和克制的暗色虚影；窗口向四周扩展等量透明边缘承载阴影，因此图片内容仍保持原位置、原尺寸对齐。

## 2026-08-13 · 重启后贴图泛滥修复

- 桌面贴图改为仅当前运行会话有效，不再记录位置或在应用启动时自动恢复。
- 启动迁移会清空旧版 `pinnedScreenshots` 恢复标记，但保留截图历史、图片文件和剪贴板条目。
- 实际迁移验证：重启前存在 8 条恢复记录；重启后 `pinnedRecords = 0`，5 条截图历史和共 161 条剪贴板记录仍保留。
- 重启后的进程窗口列表只有主窗口，没有自动恢复的 `Pasty 贴图` 窗口。
- 验证：9 项核心测试、4 项 Sites 产物测试与 Vite 生产构建全部通过。

## 2026-08-13 · 快捷键录制与保存修复

- 将普通文本输入改为只读快捷键录制器：聚焦后显示“请按组合键”，按下组合键直接生成 Electron accelerator，Backspace/Delete 可清空。
- 录制期间暂时注销四组可配置全局快捷键，避免旧快捷键先触发而隐藏或切换设置窗口；失焦、关闭和提交时恢复。
- 四组快捷键改为单次原子注册，遇到重复、空值或系统占用时全部回滚并在保存按钮旁显示错误。
- 设置弹窗采用固定标题、可滚动正文、固定底部操作栏，确保小窗口下“保存设置”始终可见。
- 验证：9 项核心测试、4 项 Sites 产物测试与 Vite 生产构建全部通过，生产版 Electron 已重启。

## 2026-08-13 · 鼠标附近快截与可配置快捷键

- 截图默认区域改为以鼠标为中心的 `520 × 320` 小窗，不再先显示整屏遮罩要求从零框选。
- 小窗直接进入标注状态，提供画笔、箭头、矩形、撤销，以及显式的“扩大范围后重新选择”。
- 编辑器键盘操作：`Ctrl+C` 复制并保存截图，`Ctrl+P` 复制并固定到桌面，`Enter` 仅保存，`Esc` 取消。
- 新增全局“快速截图并贴桌面”动作；截图、快速截图贴桌面、截图历史三个快捷键均可在设置中修改，并检查空值、重复和系统占用。
- 默认快捷键：`Alt+Shift+S` 鼠标附近截图、`Alt+Shift+P` 快速截图贴桌面、`Alt+Shift+V` 截图历史。
- 自动验证：9 项剪贴板/截图核心测试、4 项 Sites 产物测试、Vite 生产构建全部通过；屏幕边缘和负坐标显示器的默认区域钳制已由单元测试覆盖。
- 原生运行验证：生产版 Electron 已重启；持久化状态确认三个快捷键全部注册为默认值。桌面控制注入快捷键未返回截图窗口，故没有将该自动化结果作为原生视觉通过证据。

### 用户校准后的最终交互

- 鼠标附近区域是全屏冻结画面上的“预选框”，并非提前裁出的截图窗口。
- 预选框在执行动作前始终可重新框选、拖动，以及通过八个边角/边线手柄调整尺寸，并实时显示像素尺寸。
- 选择画笔、箭头或矩形后进入标注状态；切回裁剪按钮可继续调整选区。
- 快捷键设置被移到设置页顶部，主界面右下角入口由无文字齿轮改为“快捷键”文字按钮。

## 2026-08-13 · 截图、标注与桌面贴图

- `Alt+Shift+S` 在鼠标所在屏幕打开全屏选区，遮罩只突出选中区域，工具条延续暖白与鼠尾草绿设计。
- 标注工具保持克制：红色画笔、箭头、矩形、撤销、重新选择、保存与钉住；`Esc` 随时退出。
- 桌面贴图使用无边框、始终置顶窗口，整张图可拖动，窗口边缘可缩放，悬停后显示关闭按钮。
- `Alt+Shift+V` 打开独立截图历史；大图为主，日期和序号为次级信息，`↑/↓` 或左右键切换，`Enter` 钉住。
- 截图历史只收录截图功能产生的图片，不与普通剪贴板图片混杂。
- 真实 Windows 验收：两个快捷键均成功注册；截图编辑器、桌面贴图、历史窗口均实际创建；历史由 `1 / 57` 通过 `↓` 切换为 `2 / 57`。随后按新的来源标记收紧历史范围。

## 2026-08-12 · 复制端完善

- 复制捕获支持文本、网址、命令、图片、文件路径与 HTML 富文本。
- 历史行增加来源应用和重复复制次数，保持为次级信息。
- 右下角捕获提示使用独立、不可聚焦、鼠标穿透的透明窗口，不会打断当前工作。
- 设置对话框延续暖白与鼠尾草绿视觉，用紧凑开关行集中管理捕获策略。
- 可访问性：开关保留原生 checkbox，支持键盘焦点；动效遵循 `prefers-reduced-motion`。
- 验证：5 项剪贴板核心单元测试、4 项 Sites 产物测试、Vite 生产构建全部通过。

## Evidence

- Source visual truth: `C:\Users\laofeng\.codex\generated_images\019ff045-3ebe-79f3-8370-20a0a3b03ad1\exec-dd7651c5-2899-478a-a199-f19e3e7c4fd6.png`
- Implementation screenshot: `E:\snipast-pro\implementation-final.png`
- Source pixels: 1098 × 1432.
- Implementation pixels: 540 × 720 at CSS viewport 540 × 720, device scale factor 1.
- Density normalization: source compared at proportional 540 px width (approximately 540 × 704); implementation kept at native CSS density.
- State: light theme, Recent tab, first text command selected, six mixed text/image rows.
- Full-view comparison: source and implementation were opened together in one comparison input after the final screenshot.
- Focused-region comparison: header/search, segmented tabs, selected row, image row, pin affordances, and keyboard footer were all readable in the full-resolution pair; separate crops were not required.

## Findings

- No actionable P0, P1, or P2 visual differences remain.
- Fonts and typography: Segoe UI Variable / Microsoft YaHei UI closely matches the Windows-native Chinese reference. The implementation uses slightly smaller operational text to preserve six rows at 540 × 720 without clipping.
- Spacing and layout rhythm: search, tabs, chronological rows, image thumbnail, and footer follow the source hierarchy. The implementation adds a small list label and Add action for required product functionality.
- Colors and visual tokens: warm off-white surfaces, charcoal text, muted sage selection, subtle separators, and restrained elevation match the selected direction. No decorative gradients remain.
- Image quality and asset fidelity: the alpine thumbnail is a real generated raster asset with correct small-scale crop and sharpness; Fluent UI System Icons provide native-looking UI symbols.
- Copy and content: Chinese search, tabs, timestamps, image metadata, commands, and keyboard guidance are complete and untruncated.

## Interaction Verification

- Browser-rendered implementation opened at `http://127.0.0.1:4173/`.
- Search filtering returned the expected single result.
- Recent/Common/Image navigation, pinning, custom-content creation, shortcut settings, arrow-key selection, and Ctrl+P pinning were tested.
- Compact 440 × 560 viewport had no horizontal overflow and kept the footer visible.
- Fresh final browser tab reported no console errors or warnings.
- Native Electron window loaded, persisted the live clipboard state, enforced a single instance, and registered Alt+V successfully.
- Automated cross-application paste could not be conclusively asserted because the Windows automation harness re-activates its target window after injected shortcuts; the app now stores and restores the original foreground window handle before sending Ctrl+V. This is a behavioral test gap, not a visual QA blocker.

## Comparison History

1. Initial implementation showed the Delete action permanently on the selected row and used decorative gradients. Both were removed to match the source's restrained row actions and flat surfaces.
2. A keyboard-listener effect was initially inserted in the wrong hook and produced `handleKeys is not defined`. It was moved into App; a new browser tab then rendered six rows with zero console errors, and global Arrow/Ctrl+P handling passed.

## Follow-up Polish

- P3: a future pass could enlarge row typography slightly if the default window height is increased above 720 px.
- Behavioral follow-up: manually verify Enter auto-paste once in the user's preferred target apps (for example Feishu, browser, and VS Code).

final result: passed
