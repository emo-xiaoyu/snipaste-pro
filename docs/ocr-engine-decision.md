# OCR 引擎选型 · 交叉复核与决策建议（交叉复核 · ZCode）

> 任务：`c312fad0-eb1f-4542-9d38-19b6bf8131c1` · team `89025ebd-7de4-4a29-9382-62e569d98691`
> 复核对象：`docs/ocr-engine-research.md`（方案调研 · Pi，只读，未改动）
> 方法：本地实证（Pasty 真实管线 + 本机 Windows 11 build 26200 / PS 5.1.26100.9444）+ 官方文档 / npm / GitHub registry 复核
> 结论性质：带倾向性决策建议，供 lead 采信；不改动任何运行时代码

---

## 1. TL;DR

**主推维持 (A) Windows.Media.Ocr（WinRT，现状），不换引擎。** 复核确认 Pi 的体积与禁令事实基本准确（onnxruntime-node 287 MiB、tessdata 尺寸、AGENTS.md:55/63 禁令、pwsh 7 无 WinRT 投影均属实），且本次在本机用 Pasty 真实管线完成了项目内**首次有记录的** AGENTS.md:55 直接文本验证：`滑动`、`质量` 全部识别正确，30 连发零失败、无僵尸进程，端到端 p50 358 ms（后台预识别 + LRU 缓存掩盖了该延迟）。Pi 报告中关于 `zh-Hans` 标识符的担忧**被证伪**（WinRT 走语言匹配，`zh-Hans` 与 `zh-CN` 均解析到已装的 `zh-Hans-CN` 引擎），但实测**新发现一个 Pi 未覆盖的真实缺陷**：zh 引擎把 ASCII 标点识别为全角（`98.5%` → `98．5％`、`v3.2.1` → `v3．2．1`），复制保真度受损，应作为保持主推后的第一优先修复项。**(B) Paddle/onnx 与 (C) Tesseract 被 AGENTS.md:55 明文禁止且体积/中文劣势成立，排除；(D) 远端 API 违反离线+隐私定位，排除**。唯一值得跟踪的备选是两条未来路径：Win11 24H2+ 的 Copilot Runtime 新 OCR API（观察项），以及在项目所有者主动放宽轻量约束前提下的 Paddle wasm 混合「可选增强包」（备胎，不入基础 zip）。

---

## 2. 事实复核表

> 「Pi 原文」摘自 `docs/ocr-engine-research.md`；「复核结果」= ✅确认 / ✎更正 / ❓未能证实。实证环境：Windows 11 build 26200（24H2+ 家族）、Windows PowerShell 5.1.26100.9444、已装 en-US + zh-Hans-CN 两个 OCR 语言包。

| # | Pi 的声明（出处） | 复核结果 | 证据与说明 |
|---|---|---|---|
| 1 | `zh-Hans` 可能不被 `TryCreateFromLanguage` 接受；微软文档用 `zh-CN`；"zh-Hans 在某些 SKU 需用 zh-CN"（§1/§2.3/§2.6/§7.A1） | **✎ 更正（担忧不成立）** | 官方 API 文档明确写 "If the specified language **can be resolved** to any of the OCR languages available on the device… See **language matching**"——即语言匹配而非精确字符串比较。本机实测：`TryCreateFromLanguage('zh-Hans')` 与 `('zh-CN')` **均成功**，且都解析到同一引擎 `RecognizerLanguage = zh-Hans-CN`（本机已装中文 OCR 包的注册标签既非 `zh-Hans` 也非 `zh-CN`，而是 `zh-Hans-CN`）。`Language.OCR~~~zh-CN~0.0.1.0` 是 DISM/FOD 能力标识命名空间，与运行时 BCP-47 标签是两回事——Pi 把两个命名空间混为一谈。**真正的风险是语言包是否安装，不是标签拼写** |
| 2 | `onnxruntime-node@1.30.0` 解压 287 MiB（§3.2） | **✅ 确认** | npm registry 实时数据：`dist.unpackedSize = 301,068,136 B` = 287.1 MiB，43 个文件。Pi 数字精确 |
| 3 | `chi_sim` 42.31 MiB、`chi_sim_vert` 2.36、`chi_tra` 56.29、`eng` 22.38、`osd` 10.07（§4.2） | **✅ 确认** | GitHub API `tessdata/contents` 实时字节数逐一吻合：44,366,093 / 2,470,991 / 59,025,073 / 23,466,654 / 10,562,874 B |
| 4 | `AGENTS.md` 行 55、63 明文禁止 Paddle/Tesseract/onnxruntime/sharp（§1/§3.6/§4.6） | **✅ 确认** | 行 55 原文含 "Never bundle OCR models or runtimes (no Paddle/Tesseract/onnxruntime/sharp) — that dependency weight is why the portable build exists"；行 63 是轻量化加固条款。另发现 `docs/feature-research-report.md:39` 记录这些依赖是**历史上真实剔除过的**（"已彻底剔除旧版 sharp、paddleocr、tesseract、onnxruntime 等庞然大物"），禁令有项目史依据，非随意条款 |
| 5 | pwsh 7 无 WinRT 投影，必须 PS 5.1（§2.6） | **✅ 确认** | .NET 5+ 移除内建 WinRT 支持（dotnet/runtime#35318，官方 breaking-change 文档）；PowerShell 官方 issue（2021-03）确认 `ContentType=WindowsRuntime` 类型语法在 pwsh 7 不再受支持。`win-ocr.ps1` 选 PS 5.1 是唯一正确解 |
| 6 | WinRT 单图延迟 "100-400 ms"（§2.4） | **✎ 修正区间** | 本机用 Pasty 真实 `win-ocr.ps1` 管线实测 1280×800 测试图 ×10：min 350 / **p50 358** / p95≈372 / max 1105（一次冷缓存离群）；360×110 小贴图（触发 <700 放大路径）365-430 ms。~300 ms 是 PS 5.1 spawn + 9 个 WinRT 类型加载的**常数开销**，识别本身只占几十 ms。结论：**one-shot 进程模型下 100 ms 下限不可达**，稳定区间是 350-450 ms；UX 上由 `main.cjs:1502` 的后台预识别（image-ready 后 120 ms 触发）+ LRU(64) 缓存掩盖，用户通常无感 |
| 7 | PowerShell 5.1 桥接可靠性 / 进程风暴隐患（§2.6/§10.3） | **✅ 确认安全（30 连发实测）** | 30 次串行调用：10,664 ms 总耗时（均 355 ms）、**0 失败**，结束后 `tasklist` 确认**无僵尸 powershell.exe**。`queue` 单链序列化 + one-shot + Node 自动 reap 的组合在实测规模下无泄漏迹象。Pi 提出的"长驻 Named Pipe server"优化收益（省 ~300 ms）不抵复杂度，当前不建议 |
| 8 | `MaxImageDimension` 在 PS 5.1 投影不稳定（§2.4/§7.A4） | **✅ 确认（实证）** | 本机 `[int]$engine.MaxImageDimension` 输出为**空**——投影确实失败。`win-ocr.ps1:58-62` 的 try/catch 回退到硬编码 4096 是必要的防御，不是多余代码 |
| 9 | "Win11 23H2+ 才默认含 zh-CN 语言包"（§7.A6） | **❓ 未能证实，改述** | 未找到官方预装矩阵佐证该精确表述。决定性因素是 **FOD 语言包是否安装**：zh 区域 Windows 安装默认带；en-US 机器可能没有。本机 en-US + zh-Hans-CN 并存。真正的问题是：zh 包缺失时回退 `TryCreateFromUserProfileLanguages()` 可能拿到 **en-US 引擎照常出结果但中文识别质量静默劣化**——现状代码不区分"引擎存在但语言不对"（见 §6 改进项 2） |
| 10 | 繁中需繁中语言包（§1 行 A） | **✅ 确认并加强** | 本机实测 `TryCreateFromLanguage('zh-Hant')`、`('zh-TW')`、`('yue')`、`('ja')` 均 NULL（包未装即无引擎，不是 API 不支持）。zh-Hans-only 机器上繁中贴图直接不可识别 |
| 11 | AGENTS.md:55 要求"直接验证 滑动 / 质量 代表文本"——此前无人跑过 | **✅ 证实空缺 + 本次补上** | `tests/win-ocr-core.test.cjs` 只测 `flattenWinOcrLines` 离线契约（mock 数据），全仓库无真实图像端到端测试。**本次复核首次执行**：System.Drawing 渲染 1280×800 白底黑字图（微软雅黑，含"滑动解锁，进入设置页面 / 质量检测报告 Quality Check 2024 / 版本 v3.2.1 · 完成度 98.5%，耗时 1234ms / The quick brown fox…"），跑真实管线：`滑动`、`质量`、`版本`、`完成度` 等全部正确，CJK 逐字成 word（1:1 框假设成立），`，`、`·` 正确。**但发现新缺陷见 §3.A-1** |
| 12 | Azure Read "$2.50/1000"（§5.7） | **✎ 更正** | 现行公布的 S1 Read 定价为 **$0.75/千次**（0-500K 档；500K-2M 约 $0.60/千次）；Azure 中国区 ¥9.54/千次。Pi 的 $2.50 高估约 3.3 倍。价格修正不改变排名（隐私/离线仍是硬否决），但引用必须准确 |
| 13 | "GPU 加速需要 CUDA/DirectML，便携机多是核显 → 退回 CPU，可能比 WinRT 还慢"（§7.B4） | **✎ 更正（论述过时）** | `onnxruntime-node` 官方包现已内建 **DirectML 与 WebGPU execution provider**（Windows 平台），任意 DX12 核显可用、无需 CUDA。"核显只能退 CPU"不成立。该更正**不改变** B 的排除结论（体积 287 MiB + AGENTS.md 禁令仍在），但 Pi 报告中的技术叙述应更新 |
| 14 | tesseract.js 7.0.0 / core 6.1.2（§4.2） | **✅ 版本确认；✎ core 体积有出入** | registry `dist-tags.latest` = 7.0.0 ✓、core 6.1.2 ✓；但 core 6.1.1 的 `unpackedSize ≈ 45.26 MB`，大于 Pi 写的 29.2 MiB（可能 Pi 量的是单个 wasm 产物）。量级结论（几十 MB、破坏便携定位、且被禁）不变 |
| 15 | PaddleOCR v3.7.0 / PP-OCRv6 于 2026-06-11 发布（§3.1） | **✅ 确认** | GitHub releases API：tag v3.7.0，published 2026-06-11；v6 medium 档较 PP-OCRv5_server 检测 +4.6% / 识别 +5.1%，支持 50 语言，**提供 tiny/small/medium 三档**——tiny 档是 Pi 未提及的新信息，对"备胎混合包"评估有参考意义 |
| 16 | Pi 引用的 Pasty 内部文件与行号（§6 表、§2.7） | **✅ 抽查全部吻合** | `win-ocr-core.cjs:10,11,53-78,99-101`、`win-ocr.ps1:47-53,55-62,71-87`、`bug-report-T1.md` BUG-001/004/019、`bug-report-T3-verification.md` 复合键修复与 `readFileSync` 同步 hash 隐患（"最大 4096² PNG 同步读卡主进程 50-200 ms"）均如实存在；`release/Pasty-Portable-0.1.0.zip` 实测 124,033,632 B = 124.0 MB（十进制）✓；`package.json` 无 `dependencies` 键（零运行时 npm 依赖）✓ |

**复核小结**：Pi 报告的**体积类、禁令类、pwsh 类事实全部准确**；两处技术性错误（zh-Hans 标识符担忧、GPU 后端论述）与一处价格过时（Azure）已更正；一处关键空缺（真实图像质量验证）本次补齐并产出新缺陷发现。

---

## 3. Pi 漏掉的维度（反例与补全）

### (A) WinRT —— 四个新角度

1. **【新缺陷】ASCII 标点被全角化，复制保真度受损**。实测 zh-Hans-CN 引擎把 `98.5%` 识别为 `98 ． 5 ％`、`v3.2.1` 为 `v3 ． 2 ． 1`（小数点→全角句点、%→全角百分号），`1234ms` 的 `s` 被识别为大写 `S`。对"从贴图复制数字/版本号"这一 Pasty 核心场景是真实退化；现有 CJK 空格清理（`AGENTS.md:51`）不覆盖此问题。这是保持 WinRT 后**价值最高的修复项**（详见 §6 改进 1）。
2. **Windows 版本/SKU 矩阵 + 24H2 迁移期动荡**。旧 `Windows.Media.Ocr` 从 Win10 1507 到本机 Win11 26200 实测可用（API 未死）；但 24H2 时代确有外围动荡证据：PowerToys Text Extractor 在 Win11 Home Single Language 24H2 上报 "OCR engine unavailable"（issue #42150，以重复关闭、无根因结论），且 2026-04 有 Snipping Tool OCR/文字提取被移除的官方 Q&A。综合判断：**失败模式是裁剪 SKU（Home Single Language / LTSC / N）的 FOD 语言包供给缺失，不是 API 被移除**——Pasty 现有的优雅降级方向正确，但缺少"引导用户安装中文 OCR 包"的闭环（§6 改进 2）。
3. **Win11 24H2+ 的 Copilot Runtime 新 OCR API（`Microsoft.Windows.AI.Ocr` / TextRecognizer）**。Pi 在 §10.1 提过但未展开：新 API 存在、走 NPU/GPU 模型、经 Windows App SDK 投影，**与旧 API 并存**。对 Pasty 的含义：目标用户含 Win10，新 API **不能当主引擎**；且从 PS 5.1 桥接调用 CsWinRT 投影的复杂度远高于现状。定位为**观察项**（§5 触发条件）。
4. **进程模型压测（Pi 只做了静态分析）**。30 连发零失败、无僵尸进程、均速 355 ms（见复核表 #7）——Pi §10.3 担心的进程开销值得优化但 one-shot 模型的**可靠性**实证过关，"长驻 PS host"降级为可选优化而非必要项。

### (B) PaddleOCR —— 三个新角度

1. **wasm/WebGPU 混合方案的真实体积下界**。Pi 未评估"不打包 onnxruntime-node 巨兽"的替代路径：`onnxruntime-web`（wasm + JS glue ≈ 10-30 MB）+ PP-OCRv5/v6 mobile ONNX 模型（det+rec+cls ≈ 15-30 MB）≈ **zip 增量 25-60 MB**，跑在 Electron 渲染进程 Web Worker，官方 Hugging Face demo 已用 ONNX 后端跑通浏览器推理。**技术上可行，但依然被 AGENTS.md:55 禁令覆盖**——禁令点名 "onnxruntime" 与 "OCR models"，不分 node/web 变体。所以该路径**不是工程决策，是产品约束决策**：只有项目所有者主动修订 AGENTS.md 才能解锁，且合理形态是"可选下载增强包"（用户显式下载，基础 zip 仍零模型）而非默认打包。
2. **PP-OCRv6 新增 tiny 档**（2026-06-11）：三档 tiny/small/medium，medium 已比 v5_server 强 4.6%/5.1%。若未来解锁混合包，tiny 档可把模型体积再压一档——记入备胎档案。
3. **GPU 论述修正的连带影响**：onnxruntime-node/web 均有 DirectML/WebGPU EP，核显可用（复核表 #13）。这意味着"CPU 太慢"不再是 B 的反对理由；**反对理由只剩体积 + 禁令 + 集成契约重写成本**（det+rec 两阶段输出需重写 `flattenWinOcrLines` 的 item/prefix 契约，约 1-2 天工作量，非阻断级）。

### (C) Tesseract —— 两个新角度

1. **CLI spawn 模式 vs wasm 的真实权衡**。裸 `tesseract.exe` + dlls 约 10-15 MB，比 wasm 路径（core 解压 ≈ 45 MB，见复核表 #14）小；但输出是 tsv/hOCR 而非 JSON，需自写解析层，且中文质量在 Pi 已列的竖排/圆体问题之外，**没有任何一个维度胜过现状 WinRT**（简中印刷体两者相当、竖排双废、体积 WinRT 为零）。即使没有禁令，C 也没有立足点——这是"双输"候选。
2. **简繁同装的叠加成本被 Pi 低估了一点**：chi_sim(42.31) + chi_tra(56.29) + 两个 vert(4.6) + eng(22.4) ≈ 126 MiB 数据 + 引擎，已超过 Pasty 当前整个 zip（124 MB）的体积。对比之下 Pi 给 C 的 2 分仍偏高（复核后打 1.5，见 §4）。

### (D) 远端 API —— 三个新角度

1. **价格修正后的单位经济**：Azure $0.75/千次、Google $1.50/千次、Azure 中国 ¥9.54/千次。重度用户每月 5k 张 ≈ $3.75-7.5——比 Pi 算的便宜，**但价格从来不是 D 的首要否决项**，隐私才是：桌面贴图天然含未公开 UI、token、聊天记录，出本机即不可逆。
2. **OpenAI Vision 无 bbox 的交互级杀伤**（Pi 已提，补充定位）：Pasty 的字粒度框选是整个文本模式的存在理由，纯 text-out 等于砍掉产品特性——D 不是"准确率更高"的替代，是**另一个产品**。
3. **"断网降级到云端"的 hybrid（Pi §10.2）明确否决**：与 AGENTS.md:47 "offline OCR-backed text mode" 硬约束直接冲突，且引入"什么时候把我的截图传出去"的不可预期性，比纯云端更糟（用户无法建立稳定心理模型）。

---

## 4. 候选打分（1-5，加权）

> 权重：便携体积 30% · 中文准确率 25% · 集成/契约兼容 20% · 离线隐私合规 15% · 运行时成本 10%（体积与离线是 AGENTS.md 双硬约束，故权重最高；准确率是体验核心）。**凡是被 AGENTS.md 明文禁止的候选，合规维度直接 0 分并在总分后标注。**

| 候选 | 体积(30%) | 中文(25%) | 集成(20%) | 离线隐私(15%) | 运行时(10%) | 加权总分 | 备注 |
|---|---|---|---|---|---|---|---|
| **(A) WinRT**（现状） | 5 | 3.5 | 5 | 5 | 3.5 | **4.33** | 中文扣分：全角标点缺陷、繁中需装包、竖排不支持；运行时扣分：355 ms spawn 开销（已被缓存掩盖）。实测背书 |
| **(B) Paddle onnx** | 1 | 5 | 2 | 5 | 3.5 | **3.05 → 禁令封顶 1** | 纯技术分尚可，但 287 MiB 违反便携根基 + 明文禁止。wasm 混合版理论可到体积 2.5-3、总分约 3.6，仍被禁令覆盖 |
| **(C) Tesseract** | 2 | 2 | 2 | 5 | 2.5 | **2.60 → 禁令封顶 1** | 中文无一项胜过 A（简中相当、繁中更差、竖排双废）；简繁全装 ≈ 126 MiB 数据。比 Pi 的 2 分再降：**没有禁令也没有立足点** |
| **(D) 远端 API** | 5 | 5 | 2 | 0 | 2 | **3.15 → 离线约束封顶 1** | 准确率确实最强，但隐私 0 分是乘法级否决；OpenAI 路线还砍掉字粒度交互 |

Pi 原评分 4/1/2/2 的逻辑漏洞：**(C) 高于 (D) 站不住**——C 被 Pi 自己列出的证据（竖排 Empty page、圆体混淆、126 MiB 数据、禁令）全面压制，却在推荐度上比 D 高半档；D 的扣分项（联网/隐私）是**定位级**否决，C 的扣分项（质量/体积/禁令）是**全维度**平庸，二者不构成 2>2 的并列或 C 优势。修正为 A 4.33 ≫ B≈C≈D（均被硬约束封顶）。

---

## 5. 最终倾向

### 主推：(A) Windows.Media.Ocr（保持现状，加固而非更换）

**理由**（按权重序）：① 体积增量 0，是唯一与 124 MB 便携 zip 定位兼容的引擎；② 集成已完整且经过 BUG-001/004 实战修复，本次实测证明质量与可靠性达标（滑动/质量验证通过、30 连发零失败）；③ 完全离线符合 AGENTS.md:47；④ 已发现的三个真实短板（全角标点、语言包缺失静默劣化、355 ms spawn 开销）都有**低成本原地修复路径**，没有一个需要换引擎才能解决。

### 备胎：Paddle wasm 混合「可选增强包」（有条件启用，不入基础 zip）

仅当项目所有者**主动修订 AGENTS.md:55/63 轻量约束**时评估：onnxruntime-web + PP-OCRv6 tiny/small mobile 模型（增量 25-60 MB）以"用户显式下载的 OCR 增强包"形态提供，解决 WinRT 退化场景（繁中、竖排、艺术字、低分辨率小字）。触发前提见下。**这是产品决策不是工程决策，工程侧不应绕开禁令先行。**

### 排除（含理由，非一句话）

- **不选 (B) onnxruntime-node 完整打包**：287 MiB 解压体积使 124 MB 的 zip 翻 2.5 倍以上，摧毁"便携轻量"这一项目存在理由（AGENTS.md:55 原文"that dependency weight is why the portable build exists"）；且这些依赖是本项目**历史上已付出成本剔除过的**（feature-research-report.md:39），回退等于撤销已完成的决策。GPU 后端可用（已更正）不改变体积否决。
- **不选 (C) Tesseract**：即使忽略禁令，它在每个评估维度都不优于现状——简中印刷体与 WinRT 相当（本次实测 WinRT 已达"逐字正确"），繁中更弱，竖排同样不可用，126 MiB 简繁数据超过当前整个 zip，tsv/hOCR 输出还需重写契约。**更换成本换不来任何收益，是纯下行交易。**
- **不选 (D) 远端 API**：截图出本机在桌面贴图场景（token、内部 UI、聊天记录）是不可逆隐私损失；断网即功能消失；OpenAI 系无 bbox 直接废掉字粒度框选交互；"hybrid 云端降级"比纯云端更糟（不可预期的数据外发时机）。与离线硬约束 AGENTS.md:47 冲突。

### 触发再评估的条件

1. **微软动态**：`Microsoft.Windows.AI.Ocr`（Copilot Runtime）在 Win10 份额跌破 Pasty 用户覆盖线前不会成为主引擎；当官方给出 `Windows.Media.Ocr` 弃用时间表、或 PowerToys/Snipping Tool 完成新 API 迁移并证明其语言包模型更健壮时，重评"新 API 主 + 旧 API 回退"的双引擎结构。
2. **用户反馈**：真实用户简中识别错误率投诉（尤其小字号、深色模式截图、繁中需求）达到可见规模时，优先重评 §6 改进 1/2 是否够用，不够则升级备胎评估。
3. **约束变更**：项目所有者修订 AGENTS.md 轻量条款（例如接受可选下载组件）→ 立即启动备胎可行性 spike（wasm 混合包）。
4. **可靠性红线**：若实测中出现 one-shot PS 进程模型的真实泄漏/失败证据（本次 30 连发未见），或 355 ms 延迟被用户投诉，重评长驻 PS host 或原生 Add-Type 常驻方案。

---

## 6. 落地清单

### 改进档（保持主推 WinRT，按优先级）

1. **全角标点归一化（P1，本次新发现缺陷）**：在复制清理路径（现有 CJK 空格清理同层，pin 文本选择的 copy 处理）把 OCR 全角化的 ASCII 族字符映射回半角：`．→.`、`％→%`、`０-９Ａ-Ｚａ-ｚ→ASCII`、`ｍＳ` 类大小写修正可顺带处理 `S→s`（语境：纯单位后缀）。**注意保留真中文标点（，。！？；：「」）不转换**——只转换全角化的 ASCII 字符族，源图里真实存在的中文标点不受影响。需新增测试用例锁定 `98．5％ → 98.5%`。
2. **语言包缺失的用户引导闭环（P1）**：`win-ocr.ps1` 已回传 `RecognizerLanguage.LanguageTag`，但 main 进程未利用。当解析出的语言不属于 zh 族（说明回退到了 en-US 等引擎）时，在文本模式入口提示"当前系统未安装中文 OCR 语言包，识别质量受限"，并给出安装指引（设置→语言，或管理员 `DISM /Add-Capability Language.OCR~~~zh-CN~0.0.1.0`）。同时把引擎实际解析出的 LanguageTag 写入 OCR 结果的 diagnostics。
3. **异步化 OCR 缓存键 hash（P2，T3 已记录的遗留）**：`getPinOcrKey` 的 `fs.readFileSync` 同步读在 4K PNG 上卡主进程 50-200 ms，改 async 读 + hash，消除贴图操作期间的卡顿源。
4. **延迟优化暂缓（P3）**：355 ms p50 由 ~300 ms spawn 常数构成，但后台预识别 + LRU 已使常规路径无感。长驻 PS host（Named Pipe）可省 ~250 ms 但引入状态管理/崩溃恢复复杂度，**仅当用户投诉文字模式进入慢时再做**。

### 切换档（若未来触发备胎，需要动的面）

- 新增 `resources/extras/ocr-pack/`（下载式，非默认打包）+ `electron/ocr-pack-core.cjs`（onnxruntime-web session 管理，Web Worker 内 det+rec 推理）；
- 输出适配层：把 Paddle det+rec 两阶段 bbox 合并成行、再走与 `flattenWinOcrLines` 相同的 item/prefix 契约（renderer 的文本选择层零改动）；
- `main.cjs` 增加引擎协商：增强包存在且可用时优先，否则回退 WinRT；
- `tests/`：wasm 引擎契约测试 + 双引擎一致性对比脚本；
- 逐模型核对 Paddle 权重 LICENSE（代码仓库 Apache-2.0，但部分预训练模型历史上附额外限制——Pi 待复核 #4 遗留项，本复核未逐文件验证，切换前必须补做）；
- `AGENTS.md` 必须先由所有者修订（这一步在工程启动之前）。

### 验证档（本次已做 + 建议固化）

- **本次已完成**（首次有记录）：zh-Hans/zh-CN/zh-Hant/yue/ja 语言解析矩阵、MaxImageDimension 投影失败实证、1280×800 与 360×110 端到端识别（滑动/质量通过 + 全角标点缺陷发现）、10 次延迟采样（p50 358 ms）、30 连发可靠性（零失败、无僵尸进程）。
- **建议固化为 opt-in 集成测试**：新增 `tests/win-ocr-e2e.test.cjs`，用 `PASTY_OCR_E2E=1` 环境变量门控（Windows + 中文 OCR 包环境才跑）：System.Drawing 渲染固定测试图 → 调真实 `win-ocr.ps1` → 断言输出含 `滑动`/`质量` + ASCII 标点半角化后的复制结果 + 延迟 < 2 s。把 AGENTS.md:55 的"直接验证"要求从一次性人工动作变成可回归的资产，防止未来引擎/系统更新造成静默退化。

---

## 7. 引用（本次新增；Pi 的引用清单见其 §11，不重复）

**本地实证（2026-10-08，Windows 11 build 26200 · PS 5.1.26100.9444 · 已装 en-US/zh-Hans-CN OCR 包）**：
- 语言解析实测：`TryCreateFromLanguage('zh-Hans'|'zh-CN') → zh-Hans-CN`；`zh-Hant/zh-TW/yue/ja → NULL`；`MaxImageDimension` 投影为空
- 端到端实测：Pasty 真实 `win-ocr.ps1` + `win-ocr-core.cjs`，1280×800 ×10（p50 358 ms）、360×110 ×3（365-430 ms）、30 连发（0 失败、无残留 powershell.exe）
- 识别样本：`98.5% → 98 ． 5 ％`（全角化缺陷证据）

**外部**：
- OcrEngine.TryCreateFromLanguage（语言匹配语义原文）— https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine.trycreatefromlanguage
- onnxruntime-node@1.30.0 unpackedSize 301,068,136 B — https://registry.npmjs.org/onnxruntime-node/1.30.0
- tessdata 实时字节数 — https://api.github.com/repos/tesseract-ocr/tessdata/contents/
- tesseract.js@7.0.0 / tesseract.js-core@6.1.2（6.1.1 unpacked ≈ 45.26 MB）— https://registry.npmjs.org/tesseract.js 、https://registry.npmjs.org/tesseract.js-core
- .NET 5+ 移除内建 WinRT（pwsh 7 无投影的根因）— https://learn.microsoft.com/en-us/dotnet/core/compatibility/2.2-3.0 （breaking change "Built-in support for WinRT is removed"）及 dotnet/runtime#35318
- onnxruntime-node Windows EP（WebGPU/DML）— https://www.npmjs.com/package/onnxruntime-node 、https://onnxruntime.ai/docs/install/
- PaddleOCR v3.7.0 release（PP-OCRv6，2026-06-11）— https://api.github.com/repos/PaddlePaddle/PaddleOCR/releases/latest
- PP-OCRv5/v6 ONNX 模型分发 — https://huggingface.co/monkt/paddleocr-onnx
- Azure AI Vision Read 现行定价（$0.75/千次，S1 0-500K；中国区 ¥9.54/千次）— https://azure.microsoft.com/pricing/details/cognitive-services/computer-vision/
- Win11 24H2 OCR 外围动荡：PowerToys Text Extractor #42150（closed as duplicate，SKU 语言包供给问题的弱证据）— https://github.com/microsoft/PowerToys/issues/42150 ；Snipping Tool OCR 移除 Q&A（2026-04）— https://learn.microsoft.com/answers/ （产品层决策，非 API 移除）
- Windows Copilot Runtime OCR（新 API 存在性与定位）— https://blogs.windows.com/windowsdeveloper/unlock-a-new-era-of-innovation-with-windows-copilot-runtime/

**内部文件（复核时实际读取）**：
- `AGENTS.md`（行 47/55/63 硬约束）、`electron/win-ocr-core.cjs`、`electron/win-ocr.ps1`、`electron/pin-ocr-cache.cjs`、`electron/main.cjs:82-118`（recognizePinImage / 后台预识别 / LRU 接线）、`tests/win-ocr-core.test.cjs`、`scripts/build-portable.mjs`、`package.json`（无 `dependencies` 键）、`docs/bug-report-T1.md`、`docs/bug-report-T3-verification.md`、`docs/feature-research-report.md:39`、`release/Pasty-Portable-0.1.0.zip`（124,033,632 B）
