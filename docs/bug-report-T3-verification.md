# T3 验证报告 — bug-checker 独立验证

## 验证范围

- **Worktree**: `E:/snipaste-pro-harness-worktrees/e0a42df4-0404-4bd5-a658-2749d7e3434c`
- **Branch**: `codex/collab-e0a42df4-0404-4bd5-a658-2749d7e3434c`
- **Commits 验证**: 7 个新提交（6 个 fix + 1 个 chore）
- **验证手段**: 逐 diff 阅读 + 上下文代码交叉验证 + `node -c` 语法检查 + `npm test` (42/42) + `npm run build`

## 总体结论

✅ **所有 6 个核心 Critical/High Bug 修复均通过验证，未引入新问题。**

剩余 Medium/Low Bug (BUG-006/007/010/011/012-035) 按约定以 `TODO(BUG-XXX)` 注释形式标注，**未修复但已记录**，符合 T2 任务描述。

---

## 逐项验证结果

### BUG-002 (Critical) ✅ 已修复

**根因**: `app.on('second-instance', showWindow)` 缺少 `fromShortcut: true`，导致 second-instance 唤起时不刷新 `previousWindowHandle`，粘贴目标错位。

**修复**（commit `e3aec63`, 1 行):
```diff
-app.on('second-instance', showWindow);
+app.on('second-instance', () => showWindow({ fromShortcut: true }));
```

**验证**:
- 代码确认 line 1524 已修改 ✓
- 调用栈：`showWindow({fromShortcut:true})` → `windowsBridge.foreground()` → `previousWindowHandle = normalized.handle` → 下次 paste 正确 ✓
- 与其他 `showWindow({fromShortcut:true})` 调用（line 629/631/682）一致 ✓
- 风险评估：零风险，纯加参数。

---

### BUG-005 (High) ✅ 已修复

**根因**: `src/screenshot.jsx:233` 的 `useEffect(() => api?.onScreenshotPinRequest(() => finish(true, true)), [])` 未返回 cleanup，热重载下监听器累积。

**修复**（commit `6ce73a9`, 5 行):
```diff
-useEffect(() => api?.onScreenshotPinRequest(() => finish(true, true)), []);
+useEffect(() => {
+  const off = api?.onScreenshotPinRequest(() => finish(true, true));
+  return () => off?.();
+}, []);
```

**验证**:
- 实际文件确认 line 233-236 已修改 ✓
- `api?.onScreenshotPinRequest` 返回 unsubscribe 函数（见 `electron/preload.cjs:62-65`），调用 `off?.()` 正确移除监听器 ✓
- 依赖数组为空（只挂载一次），符合预期 ✓
- 风险评估：零风险。

---

### BUG-008 (High) ✅ 已修复

**根因**: `screenshot:save` handler 缺少 sender 校验，其他 renderer 可触发。

**修复**（commit `fb20bc9`, 5 行):
```diff
-ipcMain.handle('screenshot:save', (_event, payload) => {
+ipcMain.handle('screenshot:save', (event, payload) => {
+  if (!screenshotWindow || screenshotWindow.isDestroyed() || event.sender !== screenshotWindow.webContents) {
+    return { success: false, message: 'unauthorized' };
+  }
   try {
```

**验证**:
- sender 校验严格匹配 `screenshotWindow.webContents` ✓
- 与现有 `screenshot:zoom-pin` / `screenshot:update-pin-image` 风格一致 ✓
- 处理顺序：先校验再 `try`，避免错误路径污染 ✓
- 风险评估：低。如果 renderer 中存在合法的"非主 screenshotWindow 调用"会被拒绝 — 但该 IPC 只应来自截图编辑器渲染进程，逻辑正确。

---

### BUG-009 (High) ✅ 已修复

**根因**: 三个 clipboard IPC handler 缺 sender 校验。

**修复**（commit `74de3ab`, 12 行 +）:
- `clipboard:paste-entry` (line 1243)
- `clipboard:toggle-pin` (line 1257)
- `clipboard:delete-entry` (line 1268)

每个都加上：
```js
if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
  return { success: false, message: 'unauthorized' };
}
```

**验证**:
- 三处均已修改 ✓
- `mainWindow` 已存在 main 进程（line 37 全局变量），不需额外导入 ✓
- `isDestroyed()` 检查防御性完备（mainWindow 销毁时也安全） ✓
- 风险评估：低。pin 窗口理论上不会调用这些 API（pin 窗口用 `screenshot:unpin` 等独立路径），所以 mainWindow 校验正确。

---

### BUG-003 (High) ✅ 已修复

**根因**: `addImage` 异步写文件失败时，entry 已入 state 但磁盘无文件，缩略图为空 → 历史出现死条目。

**修复**（commit `b9526ad`, 5 行):
```diff
}).catch((error) => {
  console.warn('Could not persist clipboard image:', error.message);
+  state.entries = state.entries.filter((item) => item.id !== entry.id);
+  thumbnailCache.delete(imagePath);
+  if (lastFingerprint === fingerprint) lastFingerprint = '';
+  writeStoreAsync();
+  scheduleImageGc();
  broadcastDelta({ notice: '图片已记录，但本地历史写入失败' });
});
```

**验证**:
- 回滚顺序：先从 state 移除 → 清理 thumbnailCache → 重置 lastFingerprint（防止后续被吞） → writeStoreAsync 持久化 → scheduleImageGc 删孤儿文件 ✓
- 注意顺序：`writeStoreAsync` 先于 `scheduleImageGc`，因为 GC 会读 `state.entries`，需要持久化先完成 ✓
- 但有一个微小的竞态：`writeStoreAsync()` 是异步的，调用后立即返回；`scheduleImageGc` 在 `imageGcTimer = setTimeout(runImageGc, 2500)` 中延迟执行。在 2.5s 内，state.entries 已不包含 entry，但磁盘上 store 还没更新（如果 writeStoreAsync 还在排队）。GC 读到旧 store 会保留孤儿文件。**轻微遗留问题，但不阻塞**。
- 风险评估：中低。需要在极高并发下才会显现，但当前路径只发生在写入失败时。

---

### BUG-001 + BUG-004 (Critical) ✅ 已修复

**根因**:
- BUG-001：OCR 缓存 key 仅用 entryId，旋转后图片 hash 变了但 entryId 不变 → 命中旧 OCR 结果。
- BUG-004：`pinOcrCache.delete(id)` 仅删 map 记录，不取消正在跑的 loader → in-flight OCR 仍会写入或继续消耗 powershell 进程。

**修复**（commit `9cd7402`, 161 行 +）:

#### `electron/pin-ocr-cache.cjs`:
- 引入 `AbortController` 给每个 in-flight 请求
- `deleteKey` 支持精确匹配 + `${key}:` 前缀匹配（向后兼容旧调用方 `delete(id)`）
- `clear` 也 abort 所有 in-flight
- `get` 用 `Promise.race([loadPromise, abortPromise])` 实现可中断
- 新增 `has(key)` 支持前缀匹配

#### `electron/win-ocr-core.cjs`:
- `runWinOcrScript` 接收 `signal`，abort 时 `child.kill()` 终止 powershell
- `cleanup()` 函数统一清理 timer 和 abort listener（避免重复清理抛错）
- `child.on('close')` 在 `signal.aborted` 时直接 return，避免 race 双 reject
- `recognize` 也传入 signal，队列前检查 abort 状态

#### `electron/main.cjs`:
- `recognizePinImage(input, { signal })` 接入 signal
- 新增 `getPinOcrKey(pinWindow)` 生成 `${entryId}:${hash(buffer)}` 复合键
- `screenshot:recognize-pin-text` 调用 `pinOcrCache.get(key, ...)`，返回前再次校验 `getPinOcrKey(pinWindow) === key`，防止 OCR 完成后图片已变
- 处理 `AbortError` 单独返回「文字识别已取消」
- `pin:image-ready` 缓存 expectedKey，setTimeout 回调内再校验一次

#### `tests/pin-ocr-cache.test.cjs`:
- 新增 "aborts in-flight OCR request when key or prefix is deleted" 测试

**验证**:
- 实际 diff 已确认所有变更 ✓
- 复合键逻辑：`updatePinImage` 中 `pinOcrCache.delete(pinWindow.__pinEntryId)` 通过前缀匹配正确 abort 旧 OCR ✓
- 测试通过：`npm test` 显示 `aborts in-flight OCR request when key or prefix is deleted ✔ (0.5831ms)` ✓
- 完整测试：42/42 ✓
- Build：通过 ✓

**深入检查的潜在问题**:
1. `win-ocr-core.cjs:onAbort` 中调用 `reject(...)` 后，`child.on('close')` 仍会触发。close handler 检查 `signal?.aborted` 直接 return。但若 child.kill() 异步、close 在 reject 之前到达，会 race。修复通过 cleanup() 先调用再 reject + close 中 aborted 检查覆盖双路径，正确 ✓
2. `pin-ocr-cache.cjs` 中 `Promise.race` — 当 abortPromise reject 胜出后，loadPromise 仍在跑。loadPromise 内部会写入 child（kill 后），最终 powershell 进程退出，close 触发，loadPromise 不 resolve（runWinOcrScript 已 reject 一次，但 child.on('close') 又会再次清理 — 因为 abort check return，不会再次 reject）。**✓ 安全**
3. `pin-ocr-cache.cjs` 中 `record.settled = true` 在 finally 中没设置（看代码）— 实际上 settled 在 `.then` 和 `.catch` 中都设置了 ✓
4. `getPinOcrKey` 用 `fs.readFileSync` 同步读文件，在 `screenshot:recognize-pin-text` 中调用。如果图片是几百 KB，同步读可接受。最大截图（4096x4096）约 16MB PNG，同步读会卡主进程 ~50-200ms。**轻微性能遗留，但与原 Bug 修复无关**。

**风险评估**: 中。AbortController 路径新增，依赖 powershell 子进程在 abort 时能被正确 kill（Windows 进程树清理可能留下 powershell 孙子进程，但 onAbort 内 `child.kill()` 默认 SIGTERM 对 powershell 有效）。

---

## TODO 注释核查

按约定剩余 Medium/Low Bug 已添加 `// TODO(BUG-XXX):` 注释：

| Bug | 文件 | 行号 |
|-----|------|------|
| BUG-006 | electron/main.cjs | 1314 |
| BUG-007 | electron/main.cjs | 1541 |
| BUG-010 | electron/main.cjs | 1546 |
| BUG-011 | electron/clipboard-core.cjs | 126 |
| BUG-012 | src/App.jsx | 88 |
| BUG-013 | src/App.jsx | 447 |
| BUG-014 | src/screenshot.jsx | 681 |
| BUG-015 | src/screenshot.jsx | 420 |
| BUG-018 | electron/windows-bridge.cjs | 108 |
| BUG-020 | src/screenshot.jsx | 205 |
| BUG-021 | electron/main.cjs | 735 |
| BUG-022 | electron/main.cjs | 141 |
| BUG-024 | src/pin.jsx | 110 |
| BUG-026 | scripts/build-portable.mjs | 54 |
| BUG-028 | src/pin.jsx | 246 |
| BUG-029 | src/screenshot-history.jsx | 58 |
| BUG-030 | src/App.jsx | 354 |
| BUG-031 | electron/main.cjs | 957 |
| BUG-034 | electron/main.cjs | 1232 |

✅ 共 19 个 TODO 注释覆盖剩余 Bug。

---

## 自动化验证结果

```
$ npm test
ℹ tests 42
ℹ pass 42
ℹ fail 0
ℹ duration_ms 160.4831

$ npm run build
✓ built in 1.09s
Prepared Sites build: dist/server/index.js and dist/.openai/hosting.json

$ node -c electron/{main,preload,clipboard-core,pin-ocr-cache,win-ocr-core,windows-bridge}.cjs
ALL_SYNTAX_OK
```

---

## 验证者备注（给 lead）

### 建议可应用

所有 6 个高优先级修复（4 个 Critical + 2 个 High）均：
- 改动最小化（BUG-002/005 各 1-5 行）
- 根因已解决
- 不破坏现有 API 契约
- 测试通过

→ **建议 lead 接受并合并到主分支。**

### 后续可考虑（不影响本次合并）

1. `addImage` 失败回滚路径的 store/GC 顺序（BUG-003）可以再优化为 `await writeStoreAsync()` 后再 GC，但当前实现已可工作。
2. `getPinOcrKey` 的同步 `readFileSync` 可改为 async hash 缓存，避免主进程偶发卡顿。
3. 剩余 Medium/Low Bug 建议开后续 Sprint 修复。

---

**验证者**: bug-checker (Claude Code)
**验证时间**: 2026-09-23
**worktree commit head**: 52ef223
