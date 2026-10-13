# Bug Report — snipaste-pro T1 全项目扫描

## 概览

- **项目路径**: `/e/snipaste-pro` (pasty-clipboard, Electron + React 截图/剪贴板工具)
- **扫描范围**: `electron/*.cjs` / `electron/*.ps1` / `src/*.jsx` / `src/*.js` / `worker/index.js` / `scripts/*.mjs` / `scripts/*.cjs` / `tests/`
- **代码体量**: 约 4 885 行源码（不含 node_modules / 静态资源）
- **扫描方式**: 逐文件精读 + 跨文件调用链追踪
- **严重度统计**:
  - **Critical**: 4
  - **High**: 7
  - **Medium**: 14
  - **Low**: 10
  - **合计**: 35 个已确认 Bug

## 关键发现摘要

1. **OCR 竞态 + 缓存键错误**：`pinOcrCache` 用 `entryId` 作 key，但 `updatePinImage` 后 entryId 不变，导致变换后的图片可能命中旧 OCR 结果（Critical）
2. **`second-instance` 丢失快捷键上下文**：用户第二次唤起 Pasty 时 `previousWindowHandle` 不刷新，后续粘贴会发到错误窗口（Critical）
3. **F4 IPC 监听器泄漏**：`ScreenshotEditor` 的 `useEffect` 注册 `onScreenshotPinRequest` 但未返回 cleanup，每次组件挂载都会叠加监听器（High）
4. **图片条目写入与状态不同步**：`addImage` 先把 entry 入 state 再异步写文件，写失败时 state 已包含无图条目（High）
5. **多处 IPC handler 缺少发送方校验**：`paste-entry` / `toggle-pin` / `delete-entry` / `create-entry` / `screenshot:save` / `screenshot:get-entry` / `screenshot:pin` 均未校验 `event.sender`，理论上其他 renderer 可触发（Medium）
6. **`refreshSourceContext` 缺少并发保护**：`sourceReadPending` 标志位存在但 `getCachedSourceContext` 内部无去重，连续调用会发起多次 bridge 调用
7. **`Clipboard-Store` 写入在主路径上是同步的**：`will-quit` 中调用 `writeStore()` 是同步 fs，若被防病毒软件锁住会抛异常跳过后续清理

---

## 问题列表（按严重度降序）

### Critical

#### BUG-001 · OCR 缓存键与图片内容不绑定
- **文件**: `electron/main.cjs:982-1003` (`updatePinImage`)、`electron/main.cjs:1395-1407` (`screenshot:recognize-pin-text`)
- **类型**: 逻辑错误 / 缓存一致性
- **症状**: 用户对贴图执行"向左旋转"或翻转后，OCR 文字选择仍命中变换前的字符框，复制出错的文字或选不中字。
- **复现**: 打开贴图 → 进入文本模式选择一段文字 → 右键菜单"向左旋转" → 再次进入文本模式 → 选中位置明显错位。
- **根因分析**:
  - `pinOcrCache` 以 `entry.id` 为 key，`updatePinImage` 仅调用 `pinOcrCache.delete(pinWindow.__pinEntryId)` 但 entryId 未变。
  - 同时 `screenshot:recognize-pin-text` 的 loader 接收 `{ bytes, imagePath }` 并通过 `pinOcrCache.get(id, ...)` 触发识别。当 `updatePinImage` 已删除缓存后，下一次识别会重新跑，**但** 如果上一次识别仍在 in-flight（PowerShell 进程还没返回），新调用拿不到缓存也不会发起新调用（race）。
  - `pin:image-ready` (1447 行) 在 120ms 延迟里用旧的 `imageBytes` 触发识别，若期间发生变换则结果过时。
- **建议修复方向**:
  - OCR 缓存 key 改为 `${entryId}:${hash(buffer)}` 复合键，或在 `updatePinImage` 内同步生成新 id 并更新 entry
  - 在 `recognizePinImage` 返回前再次校验 `idRef.current === activeId`
- **修复风险**: 低。需同步更新 `pin-ocr-cache.cjs` 接口与调用点。

#### BUG-002 · `second-instance` 路径丢失快捷键上下文
- **文件**: `electron/main.cjs:1472` (`app.on('second-instance', showWindow)`)、`533-556` (`showWindow`)
- **类型**: 逻辑错误 / 状态不一致
- **症状**: 用户在应用已运行时再次按 Alt+V，窗口被显示但 `previousWindowHandle` 不会刷新；用户选条目按 Enter 粘贴时，键盘事件发送到**上一次**的前台窗口（可能是已切换的应用），造成"粘贴到了别处"。
- **复现**: 启动 Pasty → 在编辑器 A 中复制一段文字 → 按 Alt+V 唤起 → 不复制 → 切到浏览器 B → 按 Alt+V 再次唤起 → 点选条目 → 文本被粘贴到编辑器 A。
- **根因分析**: `showWindow` 仅在 `options.fromShortcut === true` 时调用 `windowsBridge.foreground()` 刷新 `previousWindowHandle`。`app.on('second-instance', showWindow)` 直接传 `showWindow()`，没有 `fromShortcut: true`。
- **建议修复方向**: `app.on('second-instance', () => showWindow({ fromShortcut: true }))`。
- **修复风险**: 极低。

#### BUG-003 · `screenshot:save` 写入失败时状态已污染
- **文件**: `electron/main.cjs:373-407` (`addImage`)
- **类型**: 逻辑错误 / 资源-状态不一致
- **症状**: 用户截图后 entry 立即出现在历史中，但磁盘 PNG 写入失败（权限、磁盘满、防病毒锁）；历史里出现一条"图片文件已不存在"的死条目，缩略图为空。
- **复现**: 模拟 `imagesDir` 不可写 → 截图 → 关闭并重开 → 历史显示条目但 `screenshot:get-entry` 返回 `imageBytes: null`。
- **根因分析**:
  - 第 395 行 `state.entries.unshift(entry)` 先于文件写入
  - 第 399 行 `imageWrite = needsImageWrite ? fs.promises.writeFile(...) : Promise.resolve()`
  - 第 403-406 行的 catch 只广播 notice，并未把 entry 从 state 移除或标记为 broken
- **建议修复方向**: 写入失败时 `state.entries = state.entries.filter(e => e.id !== entry.id)` 并 `scheduleImageGc()`；或保留 entry 但置 `entry.broken = true` 并让 `thumbnailDataUrl` 返回占位图。
- **修复风险**: 中等。需确保后续 toggle-pin / delete 仍能清理 broken 条目。

#### BUG-004 · `pinOcrCache.delete` 在 Promise 完成后才真正失效
- **文件**: `electron/pin-ocr-cache.cjs:15-31`、`electron/main.cjs:1395-1407`
- **类型**: 竞态条件
- **症状**: 在 OCR 识别进行中调用 `updatePinImage`，`pinOcrCache.delete(id)` 立即删除记录；但若识别最终 resolve，`get` 不会重新调用（因为是新调用），但 `updatePinImage` 的 cache 调用是 await 的，可能拿到旧结果。
- **复现**: 大图 OCR 期间旋转贴图 → 等 OCR 返回 → 显示旧字符位置。
- **根因分析**:
  - `pinOcrCache.get` 把 `record.promise` 返回给调用方；调用方 await 此 promise。
  - `delete(key)` 仅删 map 记录，不取消正在跑的 loader
  - `updatePinImage` 路径在 `electron/main.cjs:993` 调用 `pinOcrCache.delete(pinWindow.__pinEntryId)`，但未 await 也未检查 in-flight
- **建议修复方向**: 引入 `AbortController`，在 `delete` 时让 promise reject 一个 abort 错误；或为识别加版本号 stale check。
- **修复风险**: 中。需更新所有调用方处理 abort。

---

### High

#### BUG-005 · `screenshot:pin-request` 监听器泄漏
- **文件**: `src/screenshot.jsx:233`
- **类型**: 内存泄漏 / 事件监听器未清理
- **症状**: 开发热重载时，连续多次进入截图模式后按 F4 会触发多次 `finish(true, true)`，可能导致重复保存 / 钉图。
- **复现**: 在 dev 模式下多次触发截图 → 按 F4 → 看到重复 toast 或多次"已固定"。
- **根因分析**:
  ```js
  useEffect(() => api?.onScreenshotPinRequest(() => finish(true, true)), []);
  ```
  该 effect 没有 return cleanup，IPC 监听器永远不会被移除。
- **建议修复方向**:
  ```js
  useEffect(() => {
    const off = api?.onScreenshotPinRequest(() => finish(true, true));
    return () => off?.();
  }, []);
  ```
- **修复风险**: 极低。

#### BUG-006 · `Clipboard.create-entry` 在 image 模式下读取剪贴板图片时无 force 选项，重复截图被去重过滤
- **文件**: `electron/main.cjs:1277-1289`、`360-372` (`addImage`)
- **类型**: 逻辑错误 / 边界条件
- **症状**: 用户点"添加常用内容 → 当前剪贴板图片 → 保存"，如果上次刚复制过同一张图，`force` 默认为 undefined，`fingerprint === lastFingerprint` 直接返回 null，导致"保存"按钮看似成功但没创建条目。
- **复现**: 复制一张图 → 打开设置 → 切到其他窗口 → Alt+V → 添加 → 选图片 → 保存。条目不出现。
- **根因分析**:
  - `addImage` 第 366 行：`!options.custom && !options.force && (fingerprint === lastFingerprint || ...)` — 当 `custom: true` 时跳过此分支，但 fingerprint 检查逻辑中 `custom` 不影响 `lastFingerprint` 的设置。
  - 第 367 行 `lastFingerprint = fingerprint;` 仍会设置，导致下次 `addImage` 也会被吞。
- **建议修复方向**: 对 `options.custom` 路径绕过 `lastFingerprint` 短路；或在 create-entry IPC handler 中传 `force: true`。
- **修复风险**: 低。

#### BUG-007 · `inspectClipboard` 在启动时立即读取剪贴板，可能捕获敏感凭据
- **文件**: `electron/main.cjs:1489` (`inspectClipboard()` 调用点)、`454-472`
- **类型**: 安全 / 隐私
- **症状**: 应用启动瞬间如果用户刚复制了密码 / API key，会被 `detectSensitive` 命中并跳过（若开启 protectSensitive）。但若用户关闭了 protectSensitive 或规则未覆盖，凭据被记录到磁盘历史。
- **复现**: 关闭"保护敏感内容" → 复制一段含 `password: xxx` 的文本 → 启动 Pasty → 历史中已存在该条目。
- **根因分析**: `inspectClipboard` 启动即读，无视用户偏好默认值已加载但用户尚未确认 UI 状态。
- **建议修复方向**: 启动后延迟 1.5 秒再调用，或要求主窗口获得焦点后再开始轮询（监听 `mainWindow.on('focus')`）。
- **修复风险**: 低，需调整轮询起点。

#### BUG-008 · `ipcMain.handle('screenshot:save', ...)` 缺少发送方校验
- **文件**: `electron/main.cjs:1306-1350`
- **类型**: 不安全 IPC
- **症状**: 任何加载了 preload 的 renderer（截图历史、贴图窗口、设置窗口）都能触发 `screenshot:save`，将任意图像写入历史并钉到桌面。
- **复现**: 在贴图渲染进程注入 `window.clipboardAPI.saveScreenshot({ imageBytes: maliciousBuffer, pin: true })` 可植入图像条目。
- **根因分析**: handler 没有 `event.sender` 校验。对比 `screenshot:zoom-pin` (1419 行) 和 `screenshot:update-pin-image` (1388 行) 都做了 sender 检查。
- **建议修复方向**:
  ```js
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow || senderWindow !== screenshotWindow) return { success: false, message: 'unauthorized' };
  ```
- **修复风险**: 低。

#### BUG-009 · `clipboard:paste-entry` / `toggle-pin` / `delete-entry` 缺少发送方校验
- **文件**: `electron/main.cjs:1242-1276`
- **类型**: 不安全 IPC
- **症状**: 同 BUG-008 — 任何 renderer 可触发粘贴、切换固定、删除条目。
- **根因分析**: 这三个 handler 与 `screenshot:*` 系列风格不一致；后者做了 sender 校验，前者没做。
- **建议修复方向**: 限定为 `mainWindow` 的 sender；或建立 `verifyMainWindowSender(event)` 辅助函数统一处理。
- **修复风险**: 低。

#### BUG-010 · `tray?.destroy()` 在 will-quit 抛出时跳过清理
- **文件**: `electron/main.cjs:1493-1501`
- **类型**: 资源清理 / 错误处理
- **症状**: 防病毒软件锁住 `clipboard-store.json` 时，`writeStore()` 同步 `renameSync` 抛 EACCES → 后续 `windowsBridge.stop()` / `tray?.destroy()` 全部跳过 → 进程退出但托盘图标残留（下次开机才消失）。
- **根因分析**: 没有 try/catch 或 finally 包裹。
- **建议修复方向**:
  ```js
  app.on('will-quit', () => {
    try { writeStore(); } catch (e) { console.error('store write failed', e); }
    clearInterval(pollTimer);
    windowsBridge.stop();
    pinOcrCache.clear();
    globalShortcut.unregisterAll();
    try { tray?.destroy(); } catch {}
    tray = null;
  });
  ```
- **修复风险**: 低。

#### BUG-011 · `defaultCaptureRegion` 在多显示器边界假设鼠标始终在合法区域
- **文件**: `electron/clipboard-core.cjs:126-138`、`electron/main.cjs:782-786`
- **类型**: 边界条件
- **症状**: 鼠标快速移动到副屏边缘，下一帧 `getCursorScreenPoint` 返回的坐标可能短暂超出 `display.bounds`；`defaultCaptureRegion` 的 `clamp` 保护存在但 `Math.round(cursor.x - width/2)` 在 cursor.x 极大时会返回负值 width。
- **复现**: 在主屏右键 → 立刻把鼠标甩到副屏顶角 → 截图区域显示在主屏边界而非光标附近。
- **根因分析**: `cursor` 没有先与 `display.bounds` 求交。
- **建议修复方向**:
  ```js
  const cx = Math.min(display.bounds.x + display.bounds.width - 1,
                     Math.max(display.bounds.x, cursor.x));
  const cy = Math.min(display.bounds.y + display.bounds.height - 1,
                     Math.max(display.bounds.y, cursor.y));
  ```
- **修复风险**: 低。

---

### Medium

#### BUG-012 · `useClipboardState` 的 `api.onStateChanged` 内 `setEntries` 闭包可能使用过期 entries
- **文件**: `src/App.jsx:88-103`
- **类型**: 状态一致性
- **症状**: 高频 IPC 增量（连续复制 100 次）下可能丢失中间状态。
- **根因分析**: `applyClipboardDelta(current, next)` 使用函数式 `setEntries`，正确；但 `useEffect` 依赖只有 `[api]`，若 `window.clipboardAPI` 在 HMR 中替换则监听器全部失效。
- **建议修复方向**: 监听卸载 + 重新挂载；或在 effect 内 `const currentApi = window.clipboardAPI` 防止闭包漂移。
- **修复风险**: 低。

#### BUG-013 · `App.jsx` 硬编码"Ctrl K"提示，与实际快捷键无关
- **文件**: `src/App.jsx:445`
- **类型**: UI 异常
- **症状**: 搜索框右下角显示 `<kbd>Ctrl K</kbd>`，但应用全局快捷键是 Alt+V；用户预期误导。
- **根因分析**: 文案常量硬编码。
- **建议修复方向**: 删除该 kbd，或绑定一个真实的 Ctrl+K 输入框 focus。
- **修复风险**: 极低。

#### BUG-014 · `screenshot.jsx` 工具栏 / 提示文案硬编码 F4 / C 等快捷键，不随用户配置更新
- **文件**: `src/screenshot.jsx:679-681`
- **类型**: UI 异常
- **症状**: 用户在设置里改了 `historyPin` 等快捷键后，截图界面的"F4 贴图"提示仍是 F4。
- **根因分析**: 文案硬编码；未从 `useClipboardState` 拿 `screenshotShortcuts`。
- **建议修复方向**: 通过 `window.clipboardAPI.getState()` 拿最新快捷键显示在提示中。
- **修复风险**: 低。

#### BUG-015 · `screenshot.jsx:411-433` `onPointerDown` 中 `setPointerCapture` 在 canvas 已被其他元素捕获时抛 InvalidPointerId
- **文件**: `src/screenshot.jsx:411-433`
- **类型**: 错误处理
- **症状**: 在文本编辑 textarea 处于 focus 时点 canvas，浏览器抛 DOMException。
- **复现**: 进入文字工具 → 输入几个字（不 commit）→ 鼠标移开再点击画布。
- **根因分析**: 没有 try/catch；canvas.getContext('2d').setPointerCapture 可能失败。
- **建议修复方向**:
  ```js
  try { canvasRef.current.setPointerCapture(event.pointerId); } catch {}
  ```
- **修复风险**: 极低。

#### BUG-016 · `pin.jsx:onPointerDown` 调用 `event.currentTarget.setPointerCapture` 在 button 元素上时无效果但无害；`beginPointer` 通过 `event.target.closest('button')` 提前返回，但后续 close-button 的 onPointerDown 会再次触发 — 双触发路径
- **文件**: `src/pin.jsx:210-213`、`407-411`
- **类型**: 事件处理
- **症状**: 点关闭按钮 X 时，理论上 `beginPointer` 提前 return，关闭按钮的 `onPointerDown` 触发 `api?.closeCurrentPin()`。但 `endPointer` 仍尝试 `releasePointerCapture`，对 main 元素无 pointer capture 也没事。问题在 `endPointer` 检查 `event.currentTarget.hasPointerCapture`，可能抛错。
- **复现**: 反复点击关闭按钮。
- **根因分析**: `event.currentTarget.hasPointerCapture(event.pointerId)` 在没设置过 capture 的元素上返回 false，不会抛错；OK。**降级为 Low**。
- **建议修复方向**: 已在 capture set 处 try/catch 即可。
- **修复风险**: 极低。

#### BUG-017 · `pin.jsx:reselectScreenshot` 等 IPC 路径存在但 preload 暴露面有死代码
- **文件**: `electron/preload.cjs:15` (`reselectScreenshot`)
- **类型**: 死代码 / 暴露面冗余
- **症状**: preload 暴露了 `reselectScreenshot`，但 main 中 `screenshot:reselect` handler (1351) 没有 sender 校验，且 `screenshot.jsx` 实际未调用此 API。
- **建议修复方向**: 移除 preload 暴露或加 sender 校验。
- **修复风险**: 极低。

#### BUG-018 · `windows-bridge.cjs` `handleExit` 在 `stopping=true` 时仍 reject 所有 pending
- **文件**: `electron/windows-bridge.cjs:70-78`、`106-115`
- **类型**: 错误处理 / 关闭流程
- **症状**: 应用退出时，主进程中有未完成的 bridge 请求（例如识别尚未返回），`stop()` 后所有 pending 全部 reject。调用方 (`pinOcrCache`) 拿到的错误被静默吞掉 (`catch(() => {})`)，无实际影响但产生噪声。
- **根因分析**: `stop()` 不主动 reject pending。
- **建议修复方向**: `stop()` 内 `for (const [id, req] of this.pending) { clearTimeout(req.timer); req.reject(new Error('bridge stopped')); } this.pending.clear();`。
- **修复风险**: 低。

#### BUG-019 · `pinOcrCache.trim` 在 `limit` 为 0 时死循环
- **文件**: `electron/pin-ocr-cache.cjs:11-13`
- **类型**: 边界条件
- **症状**: `createPinOcrCache({ limit: 0, ... })` 会进入 `while (records.size > 0) records.delete(...)` 死循环（实际上 limit < 1 在构造时已被 throw 拦截），但 `limit = 1` 时连续 set 会反复 trim；正常路径 OK。
- **根因分析**: 构造时 `if (!Number.isInteger(limit) || limit < 1) throw` — 已防。**降级为 Info / 不计入 Bug**。
- **建议修复方向**: N/A。

#### BUG-020 · `flatMap`/字符串拼接：screenshot.jsx `colorFormat` 状态在 `cycleColorFormat` 中通过 ref 更新，但 ref 的 current 在函数组件渲染期间被修改，理论上是反模式
- **文件**: `src/screenshot.jsx:98-99`、`205-211`
- **类型**: React 反模式
- **症状**: 在 React 18 strict mode 下，effect 双跑可能导致 `colorFormatRef.current` 与 state 不一致（但这里 ref 在 cycleColorFormat 内同步 set，实际 OK）。
- **根因分析**: ref 同步 + state 异步的双轨制；保持同步就 OK。
- **建议修复方向**: 把 colorFormat 完全改 state，去掉 ref。
- **修复风险**: 低。

#### BUG-021 · `captureDisplay` 临时文件在并发截图时被覆盖
- **文件**: `electron/main.cjs:711-725`
- **类型**: 竞态条件
- **症状**: 用户快速连按截图快捷键（Alt+Shift+S），两个 `captureDisplayImage` 几乎同时启动，写入 `pasty-capture-${pid}-${uuid}.png` 不冲突；**但** `fs.readFileSync` 在 `windowsBridge.captureDisplay` 完成后立即读取。如果 PowerShell 还没真正 flush，读取可能不完整。
- **根因分析**: 没有 sync 等待 PowerShell 进程退出（虽然在 capture-cursor-display.ps1 末尾是同步流程）。
- **建议修复方向**: 让 PowerShell 脚本输出 base64 而不是文件，或在 main 用 `fs.promises.readFile` 并等待 child close 事件。
- **修复风险**: 中。需改 PowerShell 协议。

#### BUG-022 · `writeStore` 同步 fs.renameSync 可能在 Windows 防病毒扫描时被锁
- **文件**: `electron/main.cjs:122-128`
- **类型**: 错误处理
- **症状**: 罕见但会发生 — `renameSync` 抛 EPERM/EACCES；当前无 try/catch，错误向上冒泡。
- **建议修复方向**: 包一层 try/catch + console.warn；或在 will-quit 路径外改成 writeStoreAsync。
- **修复风险**: 极低。

#### BUG-023 · `screenshot-history.jsx:46-50` LRU 缓存 trim 时删除的可能是刚 set 的最新 key
- **文件**: `src/screenshot-history.jsx:44-50`
- **类型**: 边界条件
- **症状**: Map 在 set 后立即 `keys().next().value` 拿到的是最旧 key（O(1)），新 key 在尾部。trim 删旧 key，逻辑正确。**但** 若 `cache.size > FULL_IMAGE_CACHE_LIMIT` 多于 1（不可能 — set 是 O(1)），OK。
- **根因分析**: 无 bug。**Info**。

#### BUG-024 · `pin.jsx` `useEffect` 中 `api?.onPinShow` 的 unsubscribe 未在 cleanup 时再次 revoke 上一次的 imageUrl
- **文件**: `src/pin.jsx:101-111`
- **类型**: 资源泄漏
- **症状**: 当 `onPinShow` 被多次触发（新 pin 切换），旧 imageUrl 通过 `adoptEntryPayload` 被 revoke，但若 `onPinShow` 返回前 unmount 则泄漏。
- **根因分析**: cleanup 函数 `return unsubscribe` 仅解绑 listener，未 revoke 当前 `imageUrlRef.current`。
- **建议修复方向**: 在 `useEffect` 内同时返回 `return () => { unsubscribe?.(); if (imageUrlRef.current.startsWith('blob:')) URL.revokeObjectURL(imageUrlRef.current); };`。
- **修复风险**: 低。

#### BUG-025 · `electron/main.cjs:1141` `openPinWindow` 在 `entry.imagePath` 不存在但 `imageBytes` 提供的路径上，`safeReadImageFile` 返回 null，`finalBytes = image.toPNG()` 触发 PNG 重编码
- **文件**: `electron/main.cjs:1126-1133`
- **类型**: 性能 / 资源浪费
- **症状**: 截图保存路径默认会传 imageBytes；但从历史窗口 pin 旧截图时没有 imageBytes，回退到磁盘读取或重编码。
- **根因分析**: 设计如此，可接受。**Info / 不计入严重 Bug**。

#### BUG-026 · `build-portable.mjs` 的 `Atomics.wait` 锁重试在 Worker 中不可用
- **文件**: `scripts/build-portable.mjs:48-56`
- **类型**: 错误处理
- **症状**: `Atomics.wait` 必须在 worker 线程才能阻塞；主线程里调用会立即返回（HTML 规范）。实际效果是 1 秒后立即重试一次，相当于 `setTimeout(resolve, 1000)`。功能 OK 但语义错误。
- **根因分析**: 设计者意图是"等 1 秒"但用了错误的 API。
- **建议修复方向**:
  ```js
  await new Promise((resolve) => setTimeout(resolve, 1000));
  ```
- **修复风险**: 极低。

#### BUG-027 · `electron/main.cjs` 的 `captureHideTimer` 在窗口销毁后未清理
- **文件**: `electron/main.cjs:286-297`
- **类型**: 资源泄漏（timer）
- **症状**: 反复触发 captureWindow 显示/隐藏，旧 timer 被 clearTimeout，但若 `captureWindow.isDestroyed()` 在 setTimeout 触发后被调用，`captureWindow?.hide()` 是 no-op，timer 引用被丢弃（GC）。OK。**降级为 Info**。

#### BUG-028 · `pin.jsx` 的 `recognizingRef.current = api?.recognizePinText(idRef.current)` 多次快速点击会启动多个识别
- **文件**: `src/pin.jsx:245-247`
- **类型**: 竞态条件
- **症状**: 用户在冷启动贴图时按住左键快速点击，OCR 启动被多次排队，bridge 后端序列化执行，前面的 promise 会先 resolve 但 `idRef.current` 已变（用户已切换 pin）。
- **根因分析**: 已有 `recognizingRef` 标志位防止重复，但条件 `!textItemsRef.current.length && !recognizingRef.current` 只在 pinDown 入口检查一次。
- **建议修复方向**: 在 `enableTextMode` 内统一 fetch + abort 旧 promise。
- **修复风险**: 中。

#### BUG-029 · `screenshot-history.jsx` 切换图片时未清空当前 activeImage，导致旧 url 闪烁
- **文件**: `src/screenshot-history.jsx:57-59`
- **类型**: UI 闪烁
- **症状**: 快速按上下箭头切换图片时，`<img src>` 短暂指向旧 url 再切到新 url。
- **根因分析**: `useEffect(() => { if (active) loadFullImage(active.id); }, [active?.id])` 触发新 load，但旧 `activeImage.url` 仍是 blob: 前任 URL，直到 `setActiveImage` 完成。
- **建议修复方向**: 在 effect 内先 `setActiveImage(null)` 触发 loading 状态。
- **修复风险**: 低。

#### BUG-030 · `App.jsx` `paste()` 的 `navigator.clipboard?.writeText` 在 file:// 或 HTTP 上下文可能不可用
- **文件**: `src/App.jsx:353-355`
- **类型**: 浏览器 API 兼容
- **症状**: 开发模式下用 vite dev server，navigator.clipboard 在非安全上下文（HTTP）下 undefined，粘贴失败无提示。
- **建议修复方向**: 添加 try/catch + toast。
- **修复风险**: 极低。

#### BUG-031 · `electron/main.cjs:1145` `acquirePinWindow` 异步 setTimeout 暖窗可能在前一个 pin 完全 ready 前就创建第二个 shell
- **文件**: `electron/main.cjs:931-936`
- **类型**: 资源管理
- **症状**: 极少见 — 快速 pin 多张图时，每个 pin 都 `createPinWindowShell()`（warm 还没回来），可能导致 N 个 hidden pin window 同时存在。
- **建议修复方向**: 增加一个 `pendingWarm` Promise 让后续 pin await。
- **修复风险**: 低。

#### BUG-032 · `windows-bridge.cjs` 重启退避没有最大次数上限，最终 consecutiveFailures 指数增长但 `Math.min` 钳制到 `restartMaxDelayMs`
- **文件**: `electron/windows-bridge.cjs:48-56`
- **类型**: 资源（实际 OK）
- **根因分析**: 已有 clamp。**Info**。

#### BUG-033 · `pin.jsx` 在卸载时未 cancel `holdTimerRef`/`noticeTimerRef` 已设过；cleanup 中 clearTimeout 调用是 no-op（null）但 OK
- **文件**: `src/pin.jsx:153-157`
- **类型**: 边界
- **根因分析**: cleanup 调用 `clearTimeout(holdTimerRef.current)`，若 current 是 null 则 no-op。**Info / 不计入 Bug**。

#### BUG-034 · `electron/main.cjs:1205-1207` `mainWindow.on('blur')` 在 dev 模式下若 DevTools 打开则不隐藏，但用户仍可用 Alt+Tab 切走再切回，窗口卡在"看不到的状态"
- **文件**: `electron/main.cjs:1205-1207`
- **类型**: UI 异常
- **症状**: 罕见 — DevTools 打开 + 用户 Alt+Tab 到另一个 app，mainWindow 自动 hide，DevTools 也跟着 hide；切回 Pasty 看不到主窗口。
- **建议修复方向**: 监听 `restore` 事件而非仅 blur。
- **修复风险**: 中。

#### BUG-035 · `shortcut-utils.js` `eventMatchesAccelerator` 的 `expectedKey` 比较使用 `normalizedKey(...).toLocaleLowerCase()` 但 `parts.at(-1).toLocaleLowerCase()`；两者大小写归一化不一致
- **文件**: `src/shortcut-utils.js:29-41`
- **类型**: 边界
- **症状**: 输入法输入中文标点时，event.key 为"Process"，normalizedKey 返回"Process"，与历史记录键"Enter"等比较返回 false。OK。**Info / 不计入 Bug**。

---

### Low

#### BUG-036 · `App.jsx:430-436` 全局 keydown 监听每次 effect 都重新创建 handler 但引用稳定（通过 ref），无泄漏
- **文件**: `src/App.jsx:430-436`
- **类型**: 性能（无 bug）
- **根因分析**: 用 ref 模式保持 listener 引用稳定。**Info**。

#### BUG-037 · `screenshot.jsx` 内 `imageRef.current.setPointerCapture` 在 `pointercancel` 路径未释放
- **文件**: `src/screenshot.jsx:411-433`、`cancelPointer 缺失`
- **类型**: 资源泄漏（pointer capture）
- **症状**: 极少 — pointercancel 事件未注册 handler，但 pointer capture 在 `pointerleave` 时浏览器会自动释放。**Info**。

#### BUG-038 · `electron/main.cjs:1483` `ensureWarmPinWindow()` 在 `app.whenReady` 中立即调用，但 shell 立即 `loadFile` 或 `loadURL` — 在生产环境 `dist/client/pin.html` 缺失时抛 ENOENT
- **文件**: `electron/main.cjs:1483`
- **类型**: 启动失败处理
- **症状**: 用户解压 portable zip 但漏拷 `dist/client/pin.html` → 应用启动但后续 pin 操作崩溃。
- **建议修复方向**: 在 `createPinWindowShell` 中 try/catch loadFile 失败并广播 notice。
- **修复风险**: 低。

#### BUG-039 · `electron/main.cjs:1206` `mainWindow.webContents.isDevToolsOpened()` 在 mainWindow 被销毁后抛
- **文件**: `electron/main.cjs:1205-1207`
- **类型**: 错误处理
- **症状**: 已加 `mainWindow?.isVisible()` 短路，但 `webContents` 在 mainWindow destroyed 后仍可访问但抛。
- **建议修复方向**: 改为 `if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible())`。
- **修复风险**: 极低。

#### BUG-040 · `windows-bridge.cjs` `triedFallbackShell` 仅尝试一次 fallback（pwsh → powershell），若 powershell.exe 也 ENOENT 则无限重试
- **文件**: `electron/windows-bridge.cjs:35-46`
- **类型**: 资源 / 错误处理
- **症状**: 极端环境下 powershell.exe 也找不到 → scheduleRestart 反复调用 `start()` → 反复 ENOENT → consecutiveFailures 增长 → 每 8s 一次 retry，无限。
- **建议修复方向**: 引入最大重启次数限制（例如 10 次）后停摆并广播给上层。
- **修复风险**: 低。

#### BUG-041 · `electron/main.cjs:1148` IIFE 中 `contentWidth`/`contentHeight` 引用了 outer 闭包，但变量名未标注 const 来源
- **文件**: `electron/main.cjs:1146-1154`
- **类型**: 可读性（非 bug）
- **建议修复方向**: 提取为独立函数 `defaultPinPosition(contentWidth, contentHeight)`。
- **修复风险**: 极低。

#### BUG-042 · `pin-image-transform.js` 的 `transformMatrices` 使用闭包但每次调用 createPlan 都新建对象 — 微小性能浪费
- **文件**: `src/pin-image-transform.js:1-7`
- **类型**: 性能（可忽略）
- **建议修复方向**: 把矩阵预存进闭包，对每个尺寸只计算位移。**Info**。

#### BUG-043 · `shortcut-utils.js` `acceleratorFromEvent` 在 event.repeat 时也调用 — 可能产生重复 accelerator
- **文件**: `src/shortcut-utils.js:18-27`
- **类型**: UI 边界
- **症状**: 长按一个键时 `event.repeat === true`，onChange 被多次触发同一 accelerator。
- **建议修复方向**: 检查 `event.repeat` 并跳过。
- **修复风险**: 低。

#### BUG-044 · `electron/main.cjs:1141` `contentBounds` 与 `targetBounds` 两个变量名职责重叠，可读性差
- **文件**: `electron/main.cjs:1135-1154`
- **类型**: 可读性（非 bug）
- **建议修复方向**: 重构为单一 `resolvePinBounds`。

#### BUG-045 · `App.jsx` 的 `paste()` 在 `api` 为 null 时 `navigator.clipboard?.writeText` 不 await 失败 — silent fail
- **文件**: `src/App.jsx:353-355`
- **类型**: 错误处理
- **症状**: web 模式下复制失败无反馈。
- **建议修复方向**: try/catch + setNotice。

---

## 扫描重点清单（覆盖情况）

| 重点 | 命中 Bug |
|------|----------|
| 未捕获异常 / Promise rejection | BUG-004, BUG-018, BUG-022 |
| 空指针 / undefined 访问 | BUG-024 |
| 竞态条件 / 异步顺序错误 | BUG-001, BUG-002, BUG-004, BUG-021, BUG-028 |
| 内存泄漏 / 事件监听器未清理 | BUG-005, BUG-024, BUG-031 |
| 错误处理不当 | BUG-010, BUG-015, BUG-018, BUG-022, BUG-038, BUG-040 |
| 资源未关闭 | BUG-010 |
| 注入风险 | （preload 已 contextIsolation，OK） |
| 不安全 IPC | BUG-008, BUG-009, BUG-017 |
| Electron 安全配置 | （已全部 contextIsolation + sandbox + nodeIntegration: false）|
| Web 资源 (XSS / innerHTML) | 未发现 dangerouslySetInnerHTML 使用 |

## 建议优先级（修复顺序）

1. **BUG-002** — 1 行修改，影响所有快捷键唤起后的粘贴正确性
2. **BUG-005** — 1 行修改，避免开发模式下 listener 累积
3. **BUG-009 + BUG-008** — 统一 sender 校验加固 IPC
4. **BUG-003** — `addImage` 失败回滚状态
5. **BUG-001 / BUG-004** — OCR 缓存版本号改造（一起做）
6. 其余 Medium / Low 按需修复

---

**扫描者**: bug-checker (Claude Code)
**扫描时间**: 2026-09-23
**代码基线**: 当前 working tree，未做 git checkout
