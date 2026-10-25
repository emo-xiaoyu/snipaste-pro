# Pasty Rust 完全重构方案（Electron → Tauri 2）

状态：**P0–P6 全部完成**（2026-10-24 实施，2026-10-25 Phase 6 收口，Electron 版已删除）。

实施结果：src-tauri 全量落地（19 个模块，约 7000 行 Rust）；14 个 Rust 单测（含真实 WinRT OCR 引擎契约）+ 47 个 JS 单测 + Sites 链路全绿；快速贴图像素级 E2E 在 125% DPI 下位级 0 差异（`npm run test:e2e`）。实测：release 单文件 exe 6.92MB（zip 4.26MB，前端嵌入），内存约 176MB（Electron 版 124MB zip / 1021MB）。
前置验证：`spikes/rust-pin-ocr/RESULTS.md` —— 三项关键技术点已实测通过（进程内 WinRT 中文 OCR 18ms、Tauri pin 位级 1:1 还原、GDI 抓屏），轻量化实测 1021MB → 154.5MB、124MB zip → 8.67MB exe。

## 1. 目标与非目标

**目标**
1. 主进程全部改用 Rust（Tauri 2），替换 Electron + 两个 PowerShell 桥（`windows-bridge.ps1`、`win-ocr.ps1`）。
2. 前端五个页面（Vite + React）最大程度原样保留。
3. `AGENTS.md` 中全部行为契约逐条保持，作为验收标准。
4. 分发保持便携 zip 为主，体积目标 ≤ 15MB；运行内存目标 ≤ 300MB（对照 Electron 实测 1021MB）。
5. 数据兼容：老版本 `clipboard-store.json` + `images/` 可一次性导入，条目/设置不丢。

**非目标**
- 不做任何功能性改动（不改交互、不改 UI、不加新特性）。
- 不引入纯原生 Rust GUI（egui/iced）——注释画布与文字选区保留 WebView2 渲染，与现状等价。
- 不动 `worker/`、Sites 交接链路（`npm run build` + `npm run test:sites` 的产物路径必须不变）。
- 不做跨平台。

## 2. 总体架构

```
┌────────────────────────── Pasty.exe (Tauri 2, Rust) ──────────────────────────┐
│                                                                               │
│  core:                        windows:                    native (windows-rs):│
│   state.rs (AppState)         main_window.rs              clipboard.rs        │
│   store.rs (JSON+images,      screenshot.rs  (编辑器)      paste.rs (SendInput)│
│     修订号串行写)              pins.rs        (预热池)      shortcuts.rs        │
│   settings.rs (偏好/快捷键)    history.rs                  hold.rs (按住唤出)   │
│   ipc.rs (命令/事件注册)        capture_toast.rs            capture.rs (BitBlt) │
│   tray.rs                     launcher 随 main_window      ocr.rs (WinRT 进程内)│
│                                                            foreground.rs       │
│  WebView2 (共享一个进程组): 5 个页面, 全部复用现有 dist/client 产物              │
│   index.html 主窗口 | screenshot.html 编辑器 | pin.html 贴图池                  │
│   screenshot-history.html 历史 | capture.html 复制提示 toast                    │
│                                                                               │
│  src/bridge/tauri-adapter.js —— 重新实现 window.clipboardAPI 全部 49 个成员     │
└───────────────────────────────────────────────────────────────────────────────┘
```

关键事实（来自代码盘点）：渲染层只通过 `window.clipboardAPI`（37 个方法 + 12 个事件订阅）访问主进程，无 `document.execCommand`、无 `window.moveTo` 等直接窗口操作。**只要适配层 1:1 实现这 49 个成员，五个页面的 JSX 几乎零改动。**

## 3. 目录结构

```
src-tauri/            # 新增：Rust 主进程（crate 名 pasty）
  src/
    main.rs           # 入口：单实例、托盘、窗口池、快捷键装配
    state.rs          # AppState（entries/shortcuts/preferences/pinnedScreenshots + 会话态）
    store.rs          # 持久化：修订号串行异步写 + 退出同步冲刷（等价 writeStoreAsync/writeStore）
    settings.rs       # mergePreferences/migrateEntry 移植（clipboard-core.cjs 中纯函数部分）
    ipc.rs            # 全部 Tauri command/event 注册（对照 preload.cjs 49 个成员）
    tray.rs
    shortcuts.rs      # RegisterHotKey 管理器 + F4 临时注册 + 录制挂起
    hold.rs           # shortcut-hold.cjs 状态机 1:1 移植（start/check/commit/release/keyUp）
    clipboard.rs      # 剪贴板监听/读取/写入/去重/敏感/合并/裁剪/图片 GC/缩略图
    paste.rs          # 写格式 + SetForegroundWindow + SendInput(Ctrl+V)，进程内
    capture.rs        # BitBlt 多显示器抓屏 + 光标定位显示器 + workArea
    ocr.rs            # Windows.Media.Ocr 进程内（spike 已验证）+ LRU(64) 缓存
    imaging.rs        # WIC：PNG 编解码、缩略图缩放（nativeImage 替代）
    foreground.rs     # GetForegroundWindow + 标题/进程名/HWND（PS 'foreground' 替代）
    windows/
      main_window.rs  # launcher/clipboard 双模式、blur 隐藏、先画后改尺寸
      screenshot.rs   # 预载握手队列、F4 归属、显示时序
      pins.rs         # 预热池、精确落位、zoom/opacity/transform、右键菜单、OCR 预热
      history.rs
      capture_toast.rs
  icons/              # 复用 build/icon.ico
  tauri.conf.json     # withGlobalTauri: true, frontendDist: ../dist/client
src/bridge/           # 新增：tauri-adapter.js（替代 preload.cjs）
electron/             # 迁移期保留，Phase 6 删除
scripts/build-portable.mjs  # Phase 5 改写（Tauri 版便携包）
其余（src/ 五页面、vite.config.mjs、worker/、tests/）不变
```

## 4. 核心设计决策

| # | 决策 | 理由 |
|---|------|------|
| D1 | **保留 `window.clipboardAPI` 契约**：适配层用 `window.__TAURI__.core.invoke` + `event.listen` 重新实现同名 API，HTML 里先加载适配器再加载页面脚本 | 五个页面 JSX 零改动；Electron 版的 demo 降级分支天然保留；无新增 npm 依赖（用 `withGlobalTauri`） |
| D2 | **剪贴板用 `AddClipboardFormatListener` 事件监听**（隐藏消息窗口），替换 650ms 轮询 + PS 桥序列号快查 | 系统原生事件，比轮询更即时更省电；`GetClipboardSequenceNumber` 仍用于自写抑制（对应 suppressFingerprint 语义） |
| D3 | **粘贴在进程内完成**：记录唤起面板前的 `GetForegroundWindow` HWND，粘贴时 `SetForegroundWindow` + 可配置延迟 + `SendInput(Ctrl+V)` | 消除每次粘贴的 PS 进程启动；35ms 预算只含延迟本身，比现状更稳 |
| D4 | **快捷键用 `RegisterHotKey`**（WM_HOTKEY），按住唤出在进程内每 16ms `GetAsyncKeyState` 轮询；`hold.rs` 逐行移植 `shortcut-hold.cjs` 状态机（含 session/commit/pending/keyUp 语义与"OS key repeat 不重触发"规则） | 语义与现状完全一致，只是把 PS 桥的 keysDown 换成进程内调用；渲染层 keyup 兜底改走 `invoke('shortcut_key_up')`（对应 today 的 before-input-event） |
| D5 | **图像编解码全部走 WIC/WinRT**（BitmapDecoder/BitmapEncoder/Scale），不引入 `image` crate | 符合 AGENTS.md 轻量化方向：优先 Windows 内置能力；spike 已验证 WIC 解码路径 |
| D6 | **加速器字符串格式不变**（`Ctrl+Alt+V` 这类 Electron 风格串）作为存储与 IPC 格式，Rust 侧移植 `shortcutKeyGroups`（含 VK 码表、双修饰、F1-F24、Num0-9） | store 兼容 + `src/shortcut-utils.js`（录制/匹配）原样保留 |

## 5. 窗口清单与生命周期映射

| Electron 现状 | Tauri 方案 | 必须保持的契约（AGENTS.md 来源） |
|---|---|---|
| mainWindow：520×520 launcher ↔ 540×720 clipboard，frameless+transparent+alwaysOnTop+skipTaskbar，blur→hide，close→hide | label `main`，同参数；`on_window_event` 处理 blur/close；`hide()` 后 `hold.commit()` | 只在新唤起时采样鼠标；模式切换保持窗口中心、先画后改尺寸（见风险 R6）；顶部关闭钮=隐藏不退出 |
| captureWindow：360×96 toast，focusable=false，ignoreMouseEvents | label `toast`，`set_ignore_cursor_events(true)` + 不获取焦点 | 复制提示可开关，2.2s 自动隐藏 |
| screenshotWindow：全屏 frameless transparent alwaysOnTop，backgroundThrottling=false，预载隐藏 | label `editor`，常驻预载；Tauri/WebView2 无 backgroundThrottling 概念，隐藏窗口渲染在 WebView2 下同样要验证（见风险 R5） | `screenshot:begin` 注册后才派发、payload 队列；`screenshot:ready` 前不显示；F4 编辑器可见期原生注册、隐藏即注销 |
| pinWindows Map + warm 预热壳 + 替换壳 | label 池 `pin-0..N`，预热池同构（acquire→立即补壳）；窗口状态（bytes/size/baseArea/baseWidth/opacity）存 Rust 侧 PinSession | F4 精确落位（capturePinBounds 物理换算，spike 已验证）；显示次序 hide 编辑器→建 pin→show+置顶+moveTop+80ms 重申；`pin:image-ready` 才 reveal；hover 关闭按 pointer-down 且不依赖 pin id（`close_current` 用发送方 label 定位） |
| screenshotHistoryWindow 820×650 | label `history` | historyPin 单键仅本地匹配，永不全局注册 |
| Tray 五项菜单 | tauri tray + menu，click/double-click 打开 | 关闭/失焦只隐藏不退出；Exit 才终止 |

**pin 的 `?id=` 参数**：pin.jsx 目前从 `location.search` 读 id。Tauri 下改为：窗口 label 即 `pin-<id>`，页面加载后 `invoke('pin_get_init')`，Rust 按发送方 label 返回 payload——渲染层 pin.jsx 只需改一行取值来源。

## 6. IPC 契约映射（preload.cjs → Tauri）

invoke（37 个，全部同名转 Tauri command，kebab→snake）：

| 组 | 命令 |
|----|------|
| 剪贴板 | get_state / paste_entry / toggle_pin / delete_entry / create_entry / write_text |
| 设置 | update_shortcut / update_preferences / set_shortcut_recording / update_all_shortcuts |
| 截图 | update_screenshot_shortcuts / open_screenshot_history / save_screenshot / reselect_screenshot / get_screenshot_history / get_screenshot_entry / pin_screenshot / unpin_screenshot / update_pin_image / recognize_pin_text / copy_pin_text / zoom_pin / set_pin_opacity / show_pin_menu(send) / move_pin(send) / editor_close(send) / history_close(send) |
| 窗口 | set_window_mode / hide_window / quit_app |
| 启动器 | activate_launcher / release_launcher_shortcut(send) |
| pin 握手 | pin_renderer_ready(send) / pin_image_ready(send) / close_current_pin(send) / screenshot_renderer_ready(send) / screenshot_ready(send) |

事件（12 个，main→renderer 用 `emit_to`）：state_changed / focus_search / open_launcher / shortcut_released / capture_show / screenshot_begin / screenshot_pin_request / history_refresh / pin_show / pin_menu_command / pin_operation_result / window:hidden（按需）。

二进制负载：`screenshot:save`、`update_pin_image` 的 PNG 字节用 Tauri 2 的 `ipc::Response`（ArrayBuffer）返回、请求侧走 `tauri::ipc::Request` 原始字节，避免 base64 膨胀；缩略图仍走 dataURL（现状一致）。

`send` 类（不回包）保留 one-way 语义：Tauri command 也返回 `()` 即可，但**发送方校验必须保留**——现状多处用 `event.sender === pinWindow.webContents` 防止跨窗口伪造；Tauri 下用 `Window::label()` 同样可判。

## 7. 原生能力映射总表

| 现状 | Rust 替代 | 备注 |
|---|---|---|
| windows-bridge.ps1 `foreground` | `foreground.rs`：GetForegroundWindow + GetWindowTextW + QueryFullProcessImageNameW | trackSource 开关 |
| `keysDown` | `GetAsyncKeyState`（hold.rs 内 16ms 轮询） | PS 桥退役 |
| `clipboardSequence` | `GetClipboardSequenceNumber` | 自写抑制 |
| `readFiles`/`writeFiles` | CF_HDROP（DragQueryFile / GlobalAlloc+DROPFILES） | FileNameW 分支由 CF_HDROP 覆盖 |
| `paste` | `paste.rs` SendInput | 见 D3 |
| `captureDisplay` | `capture.rs` BitBlt（spike 验证），PER_MONITOR_AWARE_V2 | 每显示器独立 DC；无光标（与现状一致） |
| win-ocr.ps1（每次起 PS 5.1） | `ocr.rs` 进程内 `Windows.Media.Ocr` | 18ms 实测；词框→字符框细分逻辑在渲染层（pin-text-selection.js），契约不变；上/降采样限 10000px |
| desktopCapturer 兜底 | 不需要（BitBlt 即主路径） | 删除 prewarm 分支 |
| nativeImage resize/thumbnail | WIC Scale | LRU 缓存照搬 |
| `capturePage()` 先画后改尺寸 | 见风险 R6 | 开放点 |
| dialog.showSaveDialog | tauri dialog plugin（官方插件，仅构建期依赖） | 保存 pin 到文件 |
| Menu.popup（pin 右键） | tauri muda 原生菜单 | 可在内容裁剪区外弹出，契约保持 |

## 8. 分阶段实施计划

每阶段结束：`npm run build` + `npm run test:sites` 必须绿（Sites 交接链路不被破坏）；Electron 版保持可构建直到 Phase 6。

### Phase 0 —— 脚手架与数据兼容（2~3 天）
src-tauri 骨架、tauri.conf（5 页面多入口）、单实例（second-instance → 立即采样鼠标并唤起）、托盘、store 读写 + migrateEntry/mergePreferences 移植 + 老数据一次性导入、main 窗口跑通 index.html（launcher+clipboard UI）+ 适配层 get_state/state_changed。
**验收**：双版本并跑，新框架显示完整剪贴板历史（读自导入的旧 store）；托盘五项可用；退出同步冲刷。

### Phase 1 —— 剪贴板核心（3~4 天）
剪贴板监听 + 分类/指纹/敏感/合并/裁剪/图片 GC/缩略图（全链路走 Rust）；paste_entry（写格式 + HWND + SendInput + 延迟偏好）；toggle_pin/delete/create_entry/update_preferences；录制挂起（unregister/re-register）。
**验收**：clipboardAPI 剪贴板组逐项与 Electron 版行为对照通过；点击→目标应用出字全链路 ≤35ms+延迟偏好（进程内打点）；自写抑制生效（粘贴不产生新条目）。

### Phase 2 —— 截图链路（5~7 天）
三个全局快捷键；BitBlt 抓屏 + 光标显示器 + workArea；光标居中 520×320 预选；编辑器窗口 + 预载握手 + payload 队列 + `screenshot:ready` 显示时序；F4 原生注册/注销与归属；save（渲染层直传 PNG 字节、异步入库、force 绕过去重、capturePinBounds 精确换算）；quick-pin；reselect；历史窗口 + historyPin；capture toast。
**验收**：AGENTS.md「Screenshot launch performance」「F4 reliability」「F4 input ownership」「Pin visibility ordering」逐条对照；`PASTY_QA_TIMING` 打点保留并在 Rust 侧输出同格式；spike 的像素对比脚本接入 F4 真实链路（100% DPI 位级一致）。

### Phase 3 —— pin 全量（5~7 天）
预热池 + 替换壳；wheel 缩放（指针为锚、面积基准 reset）；move；Ctrl+wheel 透明度；旋转/翻转（渲染层 canvas 变换不变，回写走 update_pin_image）；原生右键菜单全套；二次涂鸦（+30px 阴影边距、pen 默认、取消还原、完成替换）；OCR 文字选区（进程内引擎 + LRU(64) + reveal 后 120ms 预热）。
**验收**：125%/150% DPI + 多显示器下 F4 精确落位复测通过；连开 10 个 pin 内存实测 ≤ 目标；AGENTS.md「Pinned screenshot text selection」「gesture and copy fidelity」「OCR cache and quality」逐条对照（含"滑动/质量"代表性文本核验）。

### Phase 4 —— 启动器与按住唤出（3~4 天）
hold.rs 状态机移植 + RegisterHotKey + 16ms GetAsyncKeyState；renderer keyup 兜底（invoke）；launcher:activate 会话校验/commit；set_window_mode 先画后改尺寸；second-instance 鼠标采样时序；托盘 click。
**验收**：AGENTS.md「Hold-to-open launcher」逐条：松开取消不选中、OS key repeat 不重触发、native key ownership 复核、选中后短键不再唤起；「Stable launcher navigation」不重定位。

### Phase 5 —— 设置与分发（2~3 天）
设置对话框全流程（录制控件走适配层原样）；便携包构建改造：Tauri release 单 exe（改名 Pasty.exe）+ 资源 → zip ≤15MB；NSIS 可选（tauri bundler）；AppUserModelId、开机自启不做（现状也没有）。
**验收**：便携 zip 在干净机器（仅系统 WebView2）解压即用；AGENTS.md「Shortcut settings」逐条（录制期间全局键挂起、原子保存、冲突内联提示、底部保存钮可见）。

### Phase 6 —— 切换与清理（1~2 天）
删除 electron/ 与相关依赖、package.json 收口（electron/electron-builder/concurrently 出 devDeps）、AGENTS.md/README 更新、回归全量脚本化（见 §9）。
**验收**：`npm run build` 产物路径不变（dist/client/index.html 等）；test:sites 绿；git 历史保留 Electron 实现可回溯。

**总量估算：3~4 周**（单人专注）。

## 9. 测试与回归策略

1. **Rust 单测**：移植现有纯逻辑及其测试——store 迁移/合并、capturePinBounds/resetPinBounds/zoomPinBounds/cursorWindowPosition、textFingerprint/fileFingerprint/detectSensitive/classifyText、shortcutKeyGroups、hold 状态机。这些是 Electron 行为的"数学内核"，必须逐函数对拍（用 Electron 版生成 golden 样例）。
2. **渲染层纯函数测试不动**：state-merge、pin-text-selection 等的 node --test 继续跑。
3. **像素回归**：spike 的 `native-spike compare` 工具收编为 `scripts/` 下的回归工具，对 F4 真实链路做位级对比。
4. **时序回归**：`PASTY_QA_TIMING` 环境变量协议保留，Rust 打点同格式输出。
5. **行为清单走查**：AGENTS.md 每条 durable decision 在 §8 各 Phase 验收里具名指派（上文已标注），Phase 6 全量重走一遍。
6. **Sites 链路**：每 Phase 结束跑 build+test:sites。

## 10. 风险登记

| # | 风险 | 等级 | 对策 |
|---|------|------|------|
| R1 | WebView2 运行时在离线/旧系统缺失 | 中 | 启动检测并给出官方 bootstrapper 引导；确需绝对兼容时再评估 fixed-version 捆绑（体积代价） |
| R2 | DPI≠100% 的位级还原未在本机验证过 | 中 | 本机恰为 100%；Phase 3 验收强制 125/150% 多屏复测；窗口用 PhysicalPosition、CSS 尺寸按 scale 注入（spike 代码已有此逻辑） |
| R3 | 隐藏窗口的渲染节流（编辑器握手依赖渲染帧） | 中 | WebView2 无 backgroundThrottling 开关；Phase 2 第一件事就是验证隐藏窗口 rAF/渲染行为，保留"idempotent 定时器兜底"（现状已有，照搬） |
| R4 | 多 pin 内存（WebView2 渲染进程模型与 Electron 不同） | 低 | Phase 3 实测；必要时共享 user-data 文件夹已默认，逐 pin 内存应优于 Electron |
| R5 | Tauri 窗口级键盘事件（before-input-event 等价物） | 低 | 主路径本就是 16ms 轮询；渲染层 keyup 兜底走 invoke，语义不变 |
| R6 | **先画后改尺寸**：现状靠 `webContents.capturePage()` 强制冲帧，Tauri 无等价 API | 中 | 首选：渲染层双 rAF + 显式 `mode_painted` 事件后才提交 native bounds（现有渲染层已双 rAF，加一个事件即可）；Phase 4 首项实测，若仍闪帧再评估 webview 内部截图冲帧 |
| R7 | 事件监听的自写回环（paste 写剪贴板触发监听） | 低 | 序列号+指纹双重抑制（现状语义移植），Phase 1 验收项 |
| R8 | windows-rs 版本 API 漂移 | 低 | 锁定 0.61.x（spike 已编译通过版本），Cargo.lock 提交 |

## 11. 切换与回滚

- 迁移期两个版本共存于仓库（electron/ 与 src-tauri/ 并行），Vite 产物共用。
- 每个 Phase 结束打 tag，Electron 便携 zip 保留为 fallback 发布物，直到 Phase 6 全量回归通过才从构建脚本移除。
- 老数据导入是单向复制（读旧 userData → 写新 userData），Electron 版随时可再启动使用原数据，零风险。
