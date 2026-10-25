# Rust 重构可行性验证结果（2026-10-24）

验证目标：Tauri 2 路线（保留 Vite/React 前端，Rust 主进程）能否支撑 Pasty 的两条最难技术链路。

环境：Windows 11 26200，2560×1440 @ 100% 缩放（AppliedDPI=96），WebView2 155.0.4283.62。

## 结论：三项验证全部 PASS

| # | 验证项 | 结果 | 关键数据 |
|---|--------|------|----------|
| 1 | 进程内 WinRT 中文 OCR（`Windows.Media.Ocr` via windows-rs） | PASS | zh-Hans 引擎显式创建成功；"滑动质量 Paste123 摘要测试" 全部正确识别；逐字包围框坐标精确；识别耗时 18ms（进程内，无 PS 进程启动） |
| 2 | Tauri 2 精确 1:1 pin | PASS | 无边框窗口落位物理 (300,200) 600×400；全屏 BitBlt 截图后与源 PNG 内缩 6px（跳过 DWM 描边/圆角）逐像素对比：**0 差异，max diff 0（位级一致）** |
| 3 | GDI BitBlt 冻结屏幕抓取 | PASS | 2560×1440 全屏位图一次抓取成功 |

## 轻量化实测对比

| 指标 | 现状 Electron | Tauri 2（本 spike 实测） |
|------|---------------|--------------------------|
| 分发包 | 124MB zip（约 300MB 安装后） | pin-spike release 单 exe 8.67MB |
| 运行内存 | 7 进程 / 1021MB 工作集（含预载编辑器） | 3 进程 / 154.5MB（主进程 30.4MB + WebView2 子进程 124.1MB） |
| OCR 调用 | 每次识别起一个 PowerShell 5.1 进程 | 进程内直调，18ms |

工作集口径说明：两侧都用 WorkingSet，共享 DLL 会重复计入，对比口径一致；Tauri 侧页面是极简单页而 Pasty 是完整 React 应用，但结构性结论（每窗口一个渲染进程、主进程重量级差异）成立。

## 环境事实（迁移前须知）

- 本机 Rust 默认工具链是 `x86_64-pc-windows-gnu`，`windows` crate 的 raw-dylib 在 GNU 下需要 binutils（dlltool/as），本机没有 → **Tauri 路线必须用 MSVC 工具链**。
- 已通过 winget 安装 VS Build Tools 2022（VC++ 工作集）+ rustup 的 `stable-x86_64-pc-windows-msvc`；spike 目录内用 `rustup override set stable-x86_64-pc-windows-msvc` 限定。
- Tauri Windows 构建强制要求 `icons/icon.ico`。
- 坑：Windows PowerShell 5.1 对无 BOM 的 UTF-8 脚本按 ANSI(GBK) 解析——写含中文的 .ps1 必须带 BOM（assets/make-assets.ps1 已加）。

## 尚未覆盖（下一步风险面）

- DPI ≠ 100% 的多显示器缩放换算（本机恰为 100%，spike 已把 CSS 尺寸注入逻辑写好，需在 125%/150% 屏上复测）
- 透明窗口、点击穿透、always-on-top 层级管理
- 全局快捷键（含 hold-to-open 键态钩子）、剪贴板监听（AddClipboardFormatListener）、托盘
- 注释画布/文字选区：前端本就保留 WebView2，与现状等价，风险低
- WebView2 运行时依赖：Win10/11 一般预装，但离线旧系统需捆绑或引导（对比 Electron 全内置是真实取舍）

## 复跑方式

```powershell
cd spikes/rust-pin-ocr
powershell -File assets/make-assets.ps1
cargo build --release
./target/release/native-spike.exe ocr assets/ocr-text.png
powershell -File run-pin-test.ps1   # 会短暂弹出 600x400 测试窗并截屏对比
```
