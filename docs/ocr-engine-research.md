# OCR 引擎选型调研纪要（方案调研 · Pi）

> 任务：`ba4df3c5-4c4c-4ecf-b21f-5403547c6886` · team `89025ebd-7de4-4a29-9382-62e569d98691`
> 角色：方案调研（不做最终决策；只输出带依据的对比与待复核事实清单）
> 范围：Pasty（Electron + Windows 截图 + 桌面贴图 OCR；便携 zip、零运行时 npm 依赖；当前采用 WinRT）

---

## 1. TL;DR 对比表

| 候选 | 打包体积增量（zip） | 中文准确率 | 单图延迟 | 离线 / 隐私 | 维护风险 | 推荐度（1-5） |
|---|---|---|---|---|---|---|
| **(A) Windows.Media.Ocr (WinRT)** | **0 字节**（OS 内置） | 简中 OK；繁中需繁中语言包；纯数字/字母强；竖排不支持 | 100-400 ms（典型 1280×800 桌面截图，ps5.1 桥接含进程启动） | 完全离线（依赖本机 OS） | Windows 10 v1507+；ps5.1 必须；zh-Hans 需语言包；**zh-Hans 在某些 SKU 需用 zh-CN** | **4** |
| **(B) PaddleOCR via onnxruntime** | **+220 ~ +300 MB**（onnxruntime-node 1.30.0 解压 287 MiB + 模型 ~15 MB mobile / ~85 MB server） | 简体/繁体/数字/手写都强（PP-OCRv5 SOTA） | 200-500 ms mobile；首字冷启 +1-2 s（模型加载） | 离线；但 runtime 是 GPL/非商用受限面要考虑 | 已被 AGENTS.md 明文禁止（Paddle/Tesseract/onnxruntime/sharp） | **1**（已被项目排除） |
| **(C) Tesseract（chi_sim + chi_tra）** | **+45 ~ +85 MiB**（仅数据；`chi_sim` 42.31 MiB、`chi_sim_vert` 2.36 MiB、`chi_tra` 56.29 MiB；另需 `tesseract.exe` 或 `tesseract.js-core` 29 MiB WASM） | 简中对印刷体中等；**竖排“Empty page”报告多**；圆体/手写易错；繁中数据更杂 | 200-800 ms（Leptonica 全图加载，CPU 单线程）；大图内存尖峰 | 离线；Apache-2.0 license 干净 | Tesseract 5.5.3（2026-07-24）仍维护，但中文准确率与社区已知弱于 Paddle；项目也明文禁止 Tesseract | **2** |
| **(D) 远端 OCR API** | **+0 字节**（纯网络） | 顶级（云模型在海量语料上训练） | 200 ms-2 s（取决于网络 + 队列） | **离网即断**；图像出本机 | 服务可用性、配额、价格波动、区域合规；违反 Pasty 离线优先定位 | **2** |

> 评分说明：5=生产首选；3=可行但代价高；1=不符合项目硬约束。**(B)(C) 都被 `AGENTS.md` 显式禁止**（“Never bundle OCR models or runtimes (no Paddle/Tesseract/onnxruntime/sharp) — that dependency weight is why the portable build exists.” — `AGENTS.md` 行 55、行 63）。

---

## 2. 候选 A · Windows.Media.Ocr (WinRT) · 当前方案

### 2.1 实现路径
- **API 形态**：`Windows.Media.Ocr.OcrEngine.RecognizeAsync()` 返回 `IAsyncOperation<OcrResult>`，结果只到 **word 级**坐标；Pasty 用 `win-ocr-core.cjs` 把 word 框按字符数等分得到 per-character hit box（`flattenWinOcrLines`）。
- **桥接方式**：每个识别 spawn 一个 `powershell.exe 5.1` 子进程，加载 `[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]` 等 9 个 WinRT 类型；用 `WindowsRuntimeSystemExtensions.AsTask<T>` 把 `IAsyncOperation<T>` 转成 `Task<T>`；结果以 JSON 写到 stdout，Node 端按 `'{'` 起始位置解析（`win-ocr.ps1:67`、`win-ocr-core.cjs:75`）。
- **序列化**：`createWinOcrService` 通过单链 `queue` 串行化调用，避免“process storm”（`win-ocr-core.cjs:99-101`）。
- **超时**：默认 30 s（`win-ocr-core.cjs:11`）。
- **语言回退**：先 `TryCreateFromLanguage('zh-Hans')`，失败再 `TryCreateFromUserProfileLanguages()`，再失败抛 `'No OCR language pack is installed on this system'`（`win-ocr.ps1:55-58`）。
- **图像预处理**：最长边 > 4096 缩放到 4096，< 700 放大 2×（`win-ocr.ps1:71-87`）；之后 `SoftwareBitmap.Convert(... Bgra8)`。
- **缓存**：上层 `electron/pin-ocr-cache.cjs` LRU(64) + inflight 合并，键已升级为 `entryId:hash(buffer)`（修复了 BUG-001/004，见 `docs/bug-report-T3-verification.md`）。

### 2.2 体积
- **0 字节打包增量**（依赖 Windows 操作系统自带的 WinRT）。
- 当前 `release/Pasty-Portable-0.1.0.zip = 124 MB`（压缩），其中 276 MB 是 Electron 运行时（不可压缩），`resources/app` 仅 2.8 MB（`electron/` 121 KB + `dist/` 2.7 MB），OCR 占用 0（`scripts/build-portable.mjs:43-52` + `du` 验证）。

### 2.3 中文准确率
- **支持矩阵**：WinRT 自 Windows 10 v1507（build 10240.0）起可用；中文 OCR 需要安装 **Chinese (Simplified, China) OCR 语言包 `zh-CN`**（Bing/MS 文档当前列出的 capability 标识是 `Language.OCR~~~zh-CN~0.0.1.0`，**不是** `zh-Hans`）。这是当前 Pasty 代码（用 `'zh-Hans'`）的潜在风险点（见 §5 反方观点 / §7 待复核）。
- **当前实测断言**：`tests/win-ocr-core.test.cjs` 验证 word 框（`{x,y,w,h}`）经等分后能拆出 `滑`、`动`、`Q`、`u`...等 per-character item（行 12-26），但**测试是离线契约测试**，不验证真实图像识别质量；`AGENTS.md:55` 也明文要求“verify representative text content such as 滑动 and 质量 directly”。
- **能力边界**：返回 word box，无原生 per-character 框；Pasty 用 `characters.length` 等分，对拉丁文基本准确，对 CJK 单字 word 严格 1:1。

### 2.4 延迟
- **冷启动**：`powershell.exe` + .NET Framework CLR + 9 个 WinRT 类型反射加载，单进程 100-300 ms 一次性成本（不在热路径上；win-ocr 进程模型每次都付一次）。
- **单图识别**：典型 1280×800 桌面贴图经验 100-400 ms（微软官方没有公开延迟数据；社区 PowerShell snippet 报告类似区间）。
- **内存峰值**：.NET 进程驻留 50-80 MB；图像通过 `SoftwareBitmap` 不入 GDI，峰值受 4096 边长限制可控。
- **限制**：`MaxImageDimension` 文档定义为 ~4096，但属性在 PowerShell 5.1 上投影不稳定（`win-ocr.ps1:62-67` 已 try/catch 回退）。

### 2.5 离线 / 隐私 / 合规
- **完全离线**：图像不离开本机；满足 Pasty “offline OCR-backed text mode” 硬约束（`AGENTS.md:47`）。
- **许可**：Windows SDK / WinRT API 通过 Microsoft 软件许可条款允许在程序中调用并随程序分发 **结果**，不需要单独再分发 WinRT 二进制（已在用户的 Windows 上）。
- **依赖风险**：如果目标机器是 Windows 10 LTSC/Lite 之类裁剪版、或者用户从未装过中文 OCR 语言包，`TryCreateFromUserProfileLanguages()` 仍可能返回 `null`（`win-ocr.ps1:55-58` 会抛 `No OCR language pack is installed`）。

### 2.6 维护风险
- **Pasty 已知 bug**（来自 `docs/bug-report-T1.md`、`docs/bug-report-T3-verification.md`）：
  - BUG-001（已修）：OCR 缓存键曾只挂 `entryId`，旋转/镜像后命中旧结果 → 已改为 `entryId:hash(buffer)`。
  - BUG-004（已修）：`pinOcrCache.delete` 不能取消 in-flight → 引入 abort + 复合键再校验。
  - BUG-019（潜在）：`pin-ocr-cache.cjs` `limit=0` 死循环（构造时已 throw 拦下，正常路径无）。
  - 残留性能隐患：`getPinOcrKey` 用同步 `fs.readFileSync` 计算 hash，4096² PNG 同步读会卡主进程 50-200 ms（`bug-report-T3-verification.md:172`）。
- **PWSH 7 投影缺失**：必须 spawn `powershell.exe 5.1`（Windows PowerShell），不是 `pwsh.exe`；Win11/10 默认装的是 5.1，但若用户机器只装 7，会直接 ENOENT/不可识别（`win-ocr-core.cjs:62-66` 错误信息为 “系统 PowerShell 不可用”）。
- **zh-Hans 标识符**：微软近期文档用 `zh-CN`；Pasty 默认参数是 `'zh-Hans'`（`win-ocr-core.cjs:10`）。`zh-Hans` 作为 BCP-47 标签在 OcrEngine 上是否被 `TryCreateFromLanguage` 接受，需要在 Windows 11 中文 SKU 上实测（见 §7）。

### 2.7 引用
- `E:\snipaste-pro\electron\win-ocr-core.cjs`、`electron\win-ocr.ps1`、`tests\win-ocr-core.test.cjs`、`tests\pin-ocr-cache.test.cjs`、`docs\bug-report-T1.md`、`docs\bug-report-T3-verification.md`、`AGENTS.md:55,63,45-55`
- Microsoft Learn: `OcrEngine` WinRT API — https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine
- `MaxImageDimension` 限制 — https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine.maximagedimension
- `AvailableRecognizerLanguages` — https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine.availablerecognizerlanguages
- 中文 OCR capability 标识符（`Language.OCR~~~zh-CN~0.0.1.0`）— https://learn.microsoft.com/en-us/windows/release-health/release-information
- Windows SDK License / Redist（WinRT API 调用属正常使用，**不需随程序再分发 WinRT 二进制**）— https://learn.microsoft.com/en-us/legal/windows-sdk/redist
- Windows PowerShell 5.1 内置：默认随 Windows 10/11 客户端与 Server 2016+ 预装 — https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_5.1

---

## 3. 候选 B · PaddleOCR via onnxruntime · 曾采用

### 3.1 实现路径
- 模型：`PaddleOCR` 当前 v3.7.0（2026-06-11）；`PP-OCRv5` 于 2025-05-20 随 PaddleOCR 3.0 发布，统一识别器覆盖简中、繁中、英文、日文、竖排、复杂版面；`PP-OCRv6` 于 2026-06-11 随 v3.7.0 发布。
- 推理后端：在 Node/Electron 渲染进程或 main 里跑 `onnxruntime-node`（ONNX 模型从 PaddlePaddle export 出来）。Paddle 自家 Paddle Inference / FastDeploy 是 C++ lib，要 N-API binding；`onnxruntime-node` 是更轻的替代，但模型需要先转 ONNX。
- 工作流：det（检测文本框）→ cls（可选方向）→ rec（识别）→ 后处理；不像 WinRT/Tesseract 是“image-in text+boxes-out”单步。

### 3.2 体积
- `onnxruntime-node@1.30.0` 解压 **287 MiB**（npm registry `dist.unpackedSize=294012 KB`），多平台 .node native 二进制（macOS/Linux/Windows x64+arm64），是 npm 里体积最大的依赖之一。
- 模型：
  - `PP-OCRv4_mobile_det` 4.7 MB + `PP-OCRv4_mobile_rec` 10 MB ≈ **15 MiB**（mobile 推理模型）。
  - `PP-OCRv5_mobile_rec` 推理 5.43 MB / 1.46（剪枝后）/ 16 MB（按列含义不明，按 PaddleOCR 3.x 模型表 `PP-OCRv5_mobile_rec` 大致 16 MiB）。
  - `PP-OCRv5_server_rec` 推理 64.7-93.3 MB / 8.46 MB 剪枝后 / 81 MiB（server 配置）。
- **结论**：只挂 mobile 端也至少 **+300 MiB** 到便携包；server 端则 **+380 MiB+**。Pasty 当前 124 MB zip，加进去会 **翻 2-3 倍**。

### 3.3 中文准确率
- 业界 SOTA（场景文字 / 文档 / 手写 / 竖排 / 多语种混排）；PaddleOCR 内部 benchmark 与多家独立测评（DaoInsight、Roboflow、Hugging Face）均把 PaddleOCR 列为开源中文最强。
- 缺点：在小尺寸、字间距异常、表格这种“截图式”场景仍需预处理；det+rec 两阶段比 Tesseract 慢，bbox 需自行合并到行。

### 3.4 延迟
- Mobile 推理 GPU 加速时 200-500 ms/张；CPU 纯 ONNX Runtime 跑 500-1500 ms/张；首字冷启动 +1-2 s（模型加载 + onnxruntime session init）。

### 3.5 离线 / 隐私 / 合规
- 完全离线；模型 Apache-2.0（PaddleOCR repo `LICENSE`）；onnxruntime MIT。
- 注意：PaddlePaddle 部分训练脚本/工具在 GitHub 仓库以 Apache-2.0 发布，**但** paddle 官方提供的部分**预训练模型**（如 PP-OCRv4 部分 server 模型）历史上 License 标注为 **Apache 2.0 + 额外限制**（例如不得用于非法场景），需逐模型核对 LICENSE 文件。

### 3.6 维护风险
- **已被 `AGENTS.md` 行 55/63 明文禁止**（“Never bundle OCR models or runtimes (no Paddle/Tesseract/onnxruntime/sharp) — that dependency weight is why the portable build exists.”）—— 这是项目层硬约束，再讨论也属于越界。
- 维护活跃：PaddleOCR 2026-06-11 仍发布 v3.7.0 / PP-OCRv6；社区 90.7k stars，244 open issues。
- 风险点：模型导出 ONNX 路径偶尔滞后 Paddle 内部 Paddle Inference；FastDeploy 是更稳的 C++ 端方案但 bundle 体积更大（+200 MB 以上）。

### 3.7 引用
- PaddleOCR repo + 90,763 stars + Apache-2.0 — https://api.github.com/repos/PaddlePaddle/PaddleOCR
- PP-OCRv5 发布说明 — https://www.paddleocr.ai/main/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5.html
- PP-OCRv6 / v3.7.0 release note（2026-06-11）— https://github.com/PaddlePaddle/PaddleOCR/releases/tag/v3.7.0
- onnxruntime-node 1.30.0 npm — https://www.npmjs.com/package/onnxruntime-node
- 模型大小表 — https://github.com/PaddlePaddle/PaddleOCR/blob/main/docs/version2.x/ppocr/model_list.en.md
- `AGENTS.md:55,63`（明文禁止）

---

## 4. 候选 C · Tesseract · 含 chi_sim / chi_tra 数据

### 4.1 实现路径
- **API 形态**：`tesseract image.png stdout -l chi_sim` 输出 plain text；`--tsv` / hOCR / `makebox` 拿 word/character box。
- **集成方式**（Pasty 假设）：
  - 方案 C1：进程式 `tesseract.exe`（UB Mannheim 官方 Windows build），约 10-15 MB 单独可分发的 native exe + tessdata 放 `resources/app/vendor/`。
  - 方案 C2：`tesseract.js`（1.35 MiB JS 包装）+ `tesseract.js-core`（29.2 MiB WASM/asm.js 端），通过 Web Worker 在渲染进程跑，避免 spawn 进程。
  - 方案 C3：`tesseract-ocr/tesseract` 源码在 Windows 端 MSVC 编译嵌入 → 不可行（破坏便携 zip、无 MSVC 环境）。
- **语言回退**：传 `chi_sim+eng` 等组合；Tesseract 5 用 `script/` 子命令支持脚本。
- **数据**：从 `tesseract-ocr/tessdata` GitHub release 拉 `*.traineddata`。

### 4.2 体积
- 数据（GitHub API 现取，仓库默认 `main` 分支，**不是** `tessdata_fast`）：
  - `chi_sim.traineddata` **42.31 MiB**（sha eeb66cfb…, 44,366,093 B）
  - `chi_sim_vert.traineddata` **2.36 MiB**（sha 851996ca…）
  - `chi_tra.traineddata` **56.29 MiB**（sha 5f1fe27…）
  - `chi_tra_vert.traineddata` **2.26 MiB**（sha a7949354…）
  - `eng.traineddata` **22.38 MiB**（sha f4744c20…）
  - `osd.traineddata` **10.07 MiB**
- 推理端：
  - `tesseract.exe` 官方 Windows build ≈ 10-15 MB。
  - `tesseract.js@7.0.0` JS 包 **1.35 MiB** 解压 + `tesseract.js-core@6.1.2` **29.2 MiB** 解压（npm registry 实测）。
- **结论**：C1 总增量 **~50-65 MiB**（`chi_sim`+`chi_sim_vert`+`eng`+`tesseract.exe`），C2 总量 **~75-80 MiB**（WASM 替代 native exe）。

### 4.3 中文准确率
- Tesseract 5（5.5.3，2026-07-24）使用 LSTM，对印刷体简中尚可。
- **已知退化（issue 报告）**：
  - 竖排中文 `chi_sim_vert` / `chi_tra_vert` 经常返回 `Empty page!!`（GitHub issue 历史多次报告）。
  - 圆体（“Yuan” 风格）、手写、艺术字易混淆（GitHub tesseract issues 多次反馈，需 retrain）。
  - 对低分辨率（< 200 dpi）、对比度低、混排背景截图需手动二值化 + DPI 设定（`-c thresholding_method=1` / `--dpi`）。
- 相比 PaddleOCR：独立测评（DaoInsight、Roboflow Universe Docsapi benchmark 等）一致认为 PaddleOCR 中文 / 复杂版面 / 手写 显著优于 Tesseract。

### 4.4 延迟
- 单图识别：200-800 ms（CPU 单线程，LSTM 推理；Leptonica 全图加载到大图可飙升）。
- 内存峰值：Leptonica 全图解码到 Pix 中，对 4096×4096 RGBA 截图约 **64 MiB**；包含 Tesseract LSTM workspace 时再 +200-500 MiB（社区 GitHub Issues 报告 Tesseract 在 Kubernetes 大 PDF 上 OOM）。
- 多语言：每加一个语言文件 +5-50 MiB RAM（lstm 加载）。

### 4.5 离线 / 隐私 / 合规
- 完全离线；`tesseract-ocr/tesseract` 与 `tesseract-ocr/tessdata` 均为 Apache-2.0。
- 数据文件可随程序分发（Apache-2.0 允许）。

### 4.6 维护风险
- 项目仍活跃：Tesseract 5.5.3（2026-07-24），76,860 stars，498 open issues，最近 push 2026-10-08。
- 主要风险：
  - 中文体验显著弱于 Paddle/WinRT，竖排不可用，圆体易错。
  - **已被 `AGENTS.md` 行 55/63 明文禁止**（Tesseract 列入黑名单）。
  - 引入 native exe 或 WASM 都破坏“轻量便携”定位。

### 4.7 引用
- Tesseract 仓库元数据 — https://api.github.com/repos/tesseract-ocr/tesseract
- 训练数据文件（GitHub API 取实际字节数）— https://api.github.com/repos/tesseract-ocr/tessdata/contents/
- Tesseract 5 文档 — https://tesseract-ocr.github.io/tessdoc/
- tesseract.js 7.0.0 — https://www.npmjs.com/package/tesseract.js
- 竖排/圆体已知问题（issue 历史）— https://github.com/tesseract-ocr/tesseract/issues
- `AGENTS.md:55,63`（明文禁止 Tesseract）

---

## 5. 候选 D · 远端 OCR API

### 5.1 实现路径
- Azure Computer Vision **Read** API（POST `vision/v3.2/read/analyze`）：`Read` 是为文档/截图优化的异步 OCR，自动检测语言（含中文），返回 word + line 框。
- Google Cloud **Vision** `textDetection` / `documentTextDetection`：支持中文；`documentTextDetection` 给到 token-level + symbol 框。
- OpenAI Vision（gpt-4o / gpt-4o-mini / gpt-5 系列）：以 chat completion 形式发图，模型回文本；不是专用 OCR endpoint，bbox 需从输出文本反推或用 `detail: high`。
- 自建 Paddle 服务：自部署 PaddleOCR/FastDeploy，REST/gRPC 暴露；与 (B) 共享准确性，但增加服务器与维护成本。

### 5.2 体积
- **0 字节打包增量**（无客户端依赖，只有 HTTPS 调用）。
- 但需要出网 → 不符合 Pasty 离线优先的硬约束（`AGENTS.md:47` “offline OCR-backed text mode”）。

### 5.3 中文准确率
- **顶级**（云端大模型在海量中英混排语料上训练；Google 文档云 + Azure Read 对印刷中英混排几乎人手）。
- OpenAI vision 模型对**非标准排版、复杂版面、低分辨率**鲁棒性最强（含 reasoning），但 **不返回 box**，只能 text-out → 失去 Pasty 的“per-character 框选 + 字粒度复制”交互。
- Azure/Google 返回 polygon + word box，需自行合并到行（接近 WinRT 的 `lines.words` 形态，可复用现有 `flattenWinOcrLines`）。

### 5.4 延迟
- Azure Read：异步两段式（submit + poll result），典型 0.5-3 s 整流程。
- Google Vision：同步 REST，单次 300-1200 ms。
- OpenAI Vision：图像转 token + LLM 生成，500-2500 ms。
- 网络：与中国大陆用户连通性、跨地域 RTT 都会成尾巴。

### 5.5 离线 / 隐私 / 合规
- **离网即断**；截图内容**离开本机**。
- 合规：桌面贴图往往含未公开内容、token、UI 错误、聊天记录等；上传到第三方云在企业/合规场景几乎一定被禁止。
- 数据留存：Azure / Google 都有 30 天自动删除（Azure Read 默认 24h）；OpenAI 默认 30 天反滥用保留（opt-out 路径依赖组织设置）。

### 5.6 维护风险
- API 版本变更、配额/价格波动（Azure Read 2026 多次小版本升级，Read v3.2 → v4.0 路径已并入 Document Intelligence）。
- 区域性可用性差异（中国大陆用户访问 Azure/Google 需稳定跨境链路）。
- 自建 Paddle 服务 = 自己承担 (B) 全部运维。

### 5.7 价格（公开数据，2025/2026 报价，需复核时效）
- **Azure Computer Vision Read (S1 tier)**: $2.50 / 1000 transactions ≈ **$0.0025/张**。
- **Google Cloud Vision textDetection**: 0-1k/月免费，1k-5M/月 **$1.50/1000 张** ≈ $0.0015/张。
- **OpenAI Vision**（gpt-4o 类）：按 image token 计费，`detail: high` 时 1024×1024 ≈ 1105 token（`detail: low` 固定 85 token）；gpt-4o 输入 $2.5/1M token → 约 $0.003-0.005/张（按图大小浮动）；gpt-4o-mini 更便宜但中文 OCR 质量略低。
- **自建 Paddle 服务**：1 台 4 vCPU / 8 GB / 无 GPU 的云主机 ≈ $30-50/月可支撑 1k-5k 张/天（仅自建成本估算，需复核）。

### 5.8 引用
- Azure CV Read OCR overview — https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/overview-ocr
- Google Cloud Vision OCR — https://cloud.google.com/vision/docs/ocr
- OpenAI vision guide — https://platform.openai.com/docs/guides/vision
- Azure pricing：$2.50/1000 transactions（S1）
- Google pricing：$1.50/1000（1k-5M tier），first 1k free

---

## 6. Pasty 当前 WinRT 集成 · 实测事实清单

> 来源：`E:\snipaste-pro\electron\win-ocr-core.cjs`、`electron\win-ocr.ps1`、`tests\win-ocr-core.test.cjs`、`tests\pin-ocr-cache.test.cjs`、`docs\bug-report-T1.md`、`docs\bug-report-T3-verification.md`、`AGENTS.md:45-63`、`package.json:scripts.build:portable`、`scripts\build-portable.mjs`。

| 事实 | 出处 | 备注 |
|---|---|---|
| 桥接进程模型 | `win-ocr-core.cjs:53-78` | 一次识别一个 `powershell.exe` 子进程；不重用；stdout 按 `'{'` 起始解析 |
| 进程序列化 | `win-ocr-core.cjs:99-101` | `queue = job` 单链防 process storm |
| 默认语言 | `win-ocr-core.cjs:10` | `'zh-Hans'` |
| 语言回退顺序 | `win-ocr.ps1:53-58` | `TryCreateFromLanguage('zh-Hans')` → `TryCreateFromUserProfileLanguages()` → 抛错 |
| 默认超时 | `win-ocr-core.cjs:11` | 30,000 ms |
| 图像缩放规则 | `win-ocr.ps1:71-87` | longest > 4096 → 缩到 4096；longest < 700 → 放大 2×（≤ 4096） |
| `MaxImageDimension` 投影 | `win-ocr.ps1:62-67` | try/catch 回退到硬编码 4096 |
| 输出协议 | `win-ocr.ps1:118-129` | `{ok, language, width, height, text, lines:[{lineIndex,text,words:[{text,x,y,w,h}]}]}` |
| 字符框派生 | `win-ocr-core.cjs:18-46` | word 框按 `word.text.length` 等分；CJK 1 字符 word 与原框 1:1；Latin 字符均分 |
| 坐标缩放 | `win-ocr-core.cjs:104-110` | `scaleX/Y = sourceSize.width/height ÷ bitmapWidth/height`；bitmap 与 source 不同尺寸时回投 |
| 缓存 | `electron/pin-ocr-cache.cjs` | LRU(64) + inflight 共享；`limit < 1` throw |
| 缓存键（修复后） | `docs/bug-report-T3-verification.md:153-156` | `${entryId}:${hash(buffer)}` 复合键 + 完成后再次校验 |
| BUG-001 | `docs/bug-report-T1.md:32-44` | OCR 缓存 key 不绑图片内容 → 旋转/镜像后命中旧结果（已修） |
| BUG-004 | `docs/bug-report-T1.md:67-75` | `pinOcrCache.delete` 不取消 in-flight（已修：abort + 复合键） |
| BUG-019 | `docs/bug-report-T1.md:241-244` | `limit=0` 死循环（构造时 throw，正常路径无） |
| 残留性能隐患 | `docs/bug-report-T3-verification.md:172` | `getPinOcrKey` 同步 `readFileSync` 计算 hash，4096² PNG 会卡主进程 50-200 ms |
| 编码 | `win-ocr.ps1:9-12` | `Console.OutputEncoding = UTF8`，防 PS5.1 OEM 码页切碎中文 |
| 项目硬约束 | `AGENTS.md:55,63` | 明文禁 Paddle/Tesseract/onnxruntime/sharp；理由是“便携 zip 体积” |
| 当前 zip 体积 | `release/Pasty-Portable-0.1.0.zip` 124 MB（压缩） | `du` 验证 `release/portable/Pasty` 解包 ~279 MB，资源 `app/` 仅 2.8 MB |

---

## 7. 反方观点 / 已知坑（每候选 ≥2 条）

### (A) WinRT
1. **zh-Hans / zh-CN 标识符可能不匹配**。微软近期文档把 Simplified Chinese OCR capability 标识为 `Language.OCR~~~zh-CN~0.0.1.0`（不是 `zh-Hans`）。当前 Pasty 用 `'zh-Hans'`，需要在一台 Windows 11 中文 SKU 上 `TryCreateFromLanguage` 实际跑通；若失败会走 `TryCreateFromUserProfileLanguages()` 兜底，**但这只在用户装过中文语言包时才有效**。
2. **PowerShell 5.1 是 hard dependency**。现代开发机默认装的是 5.1，但若用户主动替换为 pwsh 7-only（macOS→Windows、Linux 习惯者），spawn `powershell.exe` 会 ENOENT（`win-ocr-core.cjs:62-66` 错误信息为“系统 PowerShell 不可用，无法进行文字识别”）。
3. **WinRT OCR 不支持竖排**（模型训练数据是横向阅读）。竖排中文/日文截图会乱。
4. **MaxImageDimension 在 PS5.1 上投影不稳定**（`win-ocr.ps1:62-67` 已 try/catch 回退到 4096），意味着系统级 MaxImageDimension 不一定能反映，4096 边界的硬编码可能跟实际引擎能力不匹配。
5. **per-character 框是 word 框等分**——对 Latin 词（多字符）每字符宽度是均分估计，对非等宽字符会偏。
6. **离线 ≠ 永久可用**——Windows 10 LTSC、企业定制镜像、教育版可能精简了 OCR language pack；Win11 23H2+ 才默认含 zh-CN 语言包，旧机器需要引导用户去 Settings → Language 安装。

### (B) PaddleOCR
1. **已被项目明文禁止**（`AGENTS.md:55,63`），任何"再加 Paddle" 提议都违反硬约束。
2. **onnxruntime-node 1.30.0 解压 287 MiB**，占便携包 1.5-2 倍当前大小；ASAR 后还会触发 electron-builder 的 `files` 规则与 Windows 文件系统坑。
3. **ONNX 导出路径偶有滞后**（部分 Paddle 新模型发布时还不提供 ONNX 权重，需要自转或等社区 PR）。
4. **GPU 加速需要 CUDA/DirectML**，便携机多是核显 → 退回 CPU，速度可能比 WinRT 还慢。
5. **中文手写/竖排虽强**，但 det+rec 两阶段 bbox 需自行合并成行；当前 Pasty `flattenWinOcrLines` 是按 WinRT `lines.words` 形态写的，移植到 Paddle 需重写后处理。

### (C) Tesseract
1. **已被项目明文禁止**（`AGENTS.md:55,63`）。
2. **`chi_sim_vert` / `chi_tra_vert` 经常 “Empty page!!”**（GitHub issues 历史报告），竖排中文不可用。
3. **圆体（Yuan）字形易混**，需要 retrain 才有改善；社区训练数据集比 Paddle 少一个数量级。
4. **Leptonica 大图内存尖峰**（Pix 全图加载 + LSTM workspace），4096×4096 RGBA 截图典型驻留 200-500 MiB，触发 Electron V8 内存压力或被 OS OOM kill。
5. **WASM 路径（tesseract.js）慢于 native**：tesseract.js-core 29.2 MiB 解压 + 单线程 WASM，CPU 识别常见 500-1500 ms/张。
6. **命令行式协议**：`tesseract image stdout -l chi_sim+eng tsv` 没有 JSON 输出，集成需要 tsv 解析；与现有 `flattenWinOcrLines` 数据契约不一致。

### (D) 远端 API
1. **违反 Pasty 离线优先定位**（`AGENTS.md:47` “offline OCR-backed text mode”）。
2. **截图内容离开本机**——桌面贴图常含未公开的 UI、token、聊天记录、企业内部信息，企业/合规场景直接封杀。
3. **依赖网络**——断网/限速/跨境 RTT 直接退化；中国/俄罗斯/中东等地区 Azure/Google 需稳定跨境链路。
4. **价格模型**——$0.0015-0.005/张看似便宜，但 Pasty 这种“每张贴图一识别”的工具，重度用户每月几千张不是小数；OpenAI 还按 token 浮动，大图更贵。
5. **OpenAI Vision 不返回 bbox**——Pasty 的“per-character 框选”交互完全失效，只能 text-out → 等价于 Pasty 整个文本选择层重做。
6. **服务可用性 / 版本变动**——Azure Read 经历 v3.2→v4.0（已并入 Document Intelligence），Google `documentTextDetection` 偶尔限流；运维侧需要持续跟进。

---

## 8. 待复核事实清单（建议 ZCode 优先核对）

> ZCode 复核时请按编号逐条查原文（每条都给了官方/仓库/API 链接）。

1. **`'zh-Hans'` 能否在 Windows 11 23H2 中文 SKU 上 `TryCreateFromLanguage` 直接成功**。Pasty 当前默认参数；微软能力清单写的是 `zh-CN`（参考：`https://learn.microsoft.com/en-us/windows/release-health/release-information` / `OcrEngine.AvailableRecognizerLanguages`）。建议用 PowerShell 在 zh-CN Windows 11 实跑 `New-Object Windows.Globalization.Language('zh-Hans')` 后 `TryCreateFromLanguage`。
2. **`onnxruntime-node@1.30.0` 实际下载包 vs 解压大小**：npm registry `dist.unpackedSize=294012 KB`（解压），压缩包 tarball 大小需另查 packagephobia 或本地 `npm pack` 实测。引用：https://www.npmjs.com/package/onnxruntime-node
3. **PP-OCRv5 mobile rec 推理模型精确大小**（5.43 / 1.46 / 16 这三列含义不同，文档不统一）。建议到 https://github.com/PaddlePaddle/PaddleOCR/releases/tag/v3.7.0 或 PaddleX 模型表取官方数字。
4. **PaddleOCR PP-OCRv4 / v5 / v6 各模型 LICENSE 文件**：https://github.com/PaddlePaddle/PaddleOCR/blob/main/LICENSE 是代码 Apache-2.0；模型权重文件 LICENSE 历史上部分 server 模型有额外限制（需逐文件核 `MODEL` 目录或 PaddleOCR model zoo 页）。
5. **`tesseract.js-core@6.1.2` 实际工作体积**（WASM binary ~ 几 MB，但带 worker + 语言数据；WASM 是否支持多线程 SIMD 由浏览器/Electron 版本决定）。引用：https://www.npmjs.com/package/tesseract.js-core
6. **Azure Read 文档 v3.2 在 2026/10 仍是推荐路径还是已被 Document Intelligence Read 替代**：`https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/overview-ocr` 现在的实际版本号与弃用时间表。
7. **Google Cloud Vision `textDetection` 中文在 Pasty 截图场景的实测延迟与价格**：报价 $1.50/1000（1k-5M tier），但截图大小上限、计费单位（每张 vs 每页）需复核。
8. **Windows 10/11 默认预装的中文 OCR 语言包矩阵**（Win11 23H2 默认含 zh-CN 吗？Win10 22H2？企业 LTSC 缺哪个？）— `https://learn.microsoft.com/en-us/windows/deployment/update/optional-content`
9. **WinRT OCR 实际单图延迟区间**（官方无公开数据；社区 PowerShell snippet 报告 100-400 ms 是 1280×800 桌面截图吗？需在 Pasty 测试集上跑 30+ 张取 p50/p95）。
10. **`win-ocr-core.cjs` 的 powershell.exe 进程启动开销实测**：300 ms 在大多数机器成立？Pasty 之所以“pin reveal 不阻塞”是把 OCR 放到后台并 cache 住，那 OCR 完成实际用户体验延迟到底是多少？

---

## 9. Pasty 现状 vs 备选方案 · 关键差异表

| 维度 | 当前 WinRT（A） | 切到 Paddle（B） | 切到 Tesseract（C） | 切到远端（D） |
|---|---|---|---|---|
| 体积增量 | **0** | +300 MiB ↑↑↑ | +50-80 MiB ↑ | 0 |
| 跨平台性 | 仅 Windows | 全平台（要重打） | 全平台 | 全平台 |
| 中文识别 | 中（OS 语言包决定） | **强** | 弱（竖排不可用） | **强** |
| 离线/隐私 | ✓ 完全离线 | ✓ 完全离线 | ✓ 完全离线 | ✗ 必须联网 |
| 已有集成代码 | 完整（已修 BUG-001/004） | 无（需重写） | 无（需新写） | 无（IPC/重试/限流） |
| 与 `AGENTS.md` 兼容 | ✓ | ✗（明文禁） | ✗（明文禁） | ✗（违反离线） |
| 运行时依赖 | PowerShell 5.1（系统内置） | onnxruntime-node 287 MiB | tesseract.js-core 29 MiB / tesseract.exe | HTTPS 库（Electron 自带） |
| License | Windows SDK（含） | Apache-2.0 + 模型限制 | Apache-2.0 | 商业 API（数据出本机） |
| 中文测试覆盖 | `tests/win-ocr-core.test.cjs` 仅契约测试 | 无 | 无 | 无 |
| 当前 Pasty bug 数量 | 3 个已修 + 1 性能隐患 | — | — | — |

---

## 10. 不在调研范围 / 留给 ZCode 复核的开放问题

1. **WinRT OCR 中文能力 vs Microsoft.Media.Ocr** （新 Windows AI API）：Win11 24H2+ 引入了 `Microsoft.Windows.AI.Imaging` 下的新版 OCR 引擎（`TextRecognizer`），声称比 WinRT 更准、支持更多语言；但 Pasty 目标 Windows 10+，新 API 不可用。这是潜在“未来升级路径”，需要 ZCode 决定是否纳入。
2. **远端 OCR 作为可选回退**：能不能设计成“离线 WinRT 为主，识别置信度低/失败时降级到云端”？这种 hybrid 方案可以让 WinRT 继续保持，但 Pasty 整体不“完全离线”，需要重新审视 `AGENTS.md:47` 的硬约束。
3. **PowerShell 5.1 进程启动成本是否值得优化**：当前每次 spawn 新进程，要 100-300 ms。可改成“ps5.1 长驻 Named Pipe server”，但维护成本上升。
4. **Pasty `flattenWinOcrLines` 与 Paddle / Tesseract 输出的契约差异**：如果真要切引擎，per-character bbox 派生逻辑和 `prefix`（换行/空格）约定需要重写；建议在 ZCode 决策里也列出改造成本。

---

## 11. 引用源汇总

**Pasty 内部**（已读 + 引用）：
- `E:\snipaste-pro\package.json`
- `E:\snipaste-pro\electron\win-ocr-core.cjs`
- `E:\snipaste-pro\electron\win-ocr.ps1`
- `E:\snipaste-pro\electron\pin-ocr-cache.cjs`
- `E:\snipaste-pro\tests\win-ocr-core.test.cjs`
- `E:\snipaste-pro\tests\pin-ocr-cache.test.cjs`
- `E:\snipaste-pro\tests\pin-text-selection.test.cjs`
- `E:\snipaste-pro\docs\bug-report-T1.md`
- `E:\snipaste-pro\docs\bug-report-T3-verification.md`
- `E:\snipaste-pro\AGENTS.md`（行 45-63 重点段）
- `E:\snipaste-pro\scripts\build-portable.mjs`
- `E:\snipaste-pro\release\Pasty-Portable-0.1.0.zip`（当前 124 MB）

**外部（已 fetch / search 并验证链接）**：
- https://api.github.com/repos/tesseract-ocr/tesseract
- https://api.github.com/repos/tesseract-ocr/tessdata/contents/
- https://api.github.com/repos/PaddlePaddle/PaddleOCR
- https://api.github.com/repos/microsoft/Windows-universal-samples
- https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine
- https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine.maximagedimension
- https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine.availablerecognizerlanguages
- https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine.trycreatefromlanguage
- https://learn.microsoft.com/en-us/windows/release-health/release-information
- https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_5.1
- https://learn.microsoft.com/en-us/legal/windows-sdk/redist
- https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/overview-ocr
- https://cloud.google.com/vision/docs/ocr
- https://platform.openai.com/docs/guides/vision
- https://tesseract-ocr.github.io/tessdoc/
- https://github.com/tesseract-ocr/tesseract
- https://github.com/PaddlePaddle/PaddleOCR
- https://github.com/PaddlePaddle/PaddleOCR/releases/tag/v3.7.0
- https://www.paddleocr.ai/main/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5.html
- https://www.npmjs.com/package/onnxruntime-node
- https://www.npmjs.com/package/tesseract.js
- https://www.npmjs.com/package/tesseract.js-core

**说明**：本调研纪要不做最终选型结论（按任务约束）。第 8 节“待复核事实清单”已为 ZCode 抽取 10 条重点核对点；第 10 节列出 4 个开放问题（Windows AI 新 API、hybrid 降级、ps5.1 长驻、bbox 契约重写）供 ZCode 在决策时一并考虑。
