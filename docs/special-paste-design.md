# Pasty Special Paste（特殊粘贴）变换菜单设计

## 1. 背景与借鉴

Ditto 的 Special Paste 是最接近目标的参考：它把大小写、空白、路径、slug、GUID、换行、当前时间和“作为图片粘贴”放进上下文子菜单，并允许在粘贴前改变内容。Pasty 应借鉴其高频操作分组、菜单可发现性和对 Windows 路径的关注，但避免把选项做成不可预览的一长串列表。

CopyQ 以脚本/命令组合处理选中条目，强项是可组合、可复用和面向高级用户的扩展点。Pasty 借鉴其 pipeline 思路，但只接受经过 schema 校验的声明式 JSON，不执行 JavaScript、Shell 或任意脚本。

Maccy 的 paste-as-plain-text 解决的是“保留文本语义但去掉富文本样式”的单一高频问题。Pasty 应保留一个明确的顶层快捷项，并将它与普通文本变换区分开，避免用户误以为 UPPER 等操作只影响显示。

PastePaw、Cliptoo 等轻量剪贴板工具把快速转换放在条目附近，强调少一步操作和即时反馈。Pasty 借鉴其键盘友好、短菜单和 hover 预览；复杂或异步操作则进入预览面板，不阻塞原始条目。

## 2. 用户体验

入口是历史条目右键菜单中的“特殊粘贴 ›”，文本、图片、文件条目按能力显示子项。键盘模式下，焦点条目按 `Shift+Enter` 打开同一菜单，方向键选择，Enter 提交；主快捷键仍只负责显示 Pasty，不改变已有粘贴路径。常用的“作为纯文本粘贴”可绑定独立用户快捷键，但默认不抢占现有快捷键。

点击或 hover 一个变换后，在右侧小型预览面板显示原始值、结果、长度/格式变化和警告；预览不得写剪贴板。默认 Enter 执行，Escape 返回条目，`Ctrl+Enter` 执行并记住该变换。异步变换显示进度和取消按钮。菜单标题显示接受的输入类型，图片/文件不适用项灰显并说明原因。`?` 帮助页列出入口、`Shift+Enter`、提交/取消键和当前已绑定的专用快捷键。

分类为 Text case、Whitespace、Encoding、Date/Time、Path、Text operations、Format conversion、Image operations；“Paste as plain text”作为常用项置顶。原始历史条目不变，特殊粘贴只产生一次性的输出，除非用户选择“保存为新条目”。

## 3. 变换目录

以下是第一版 29 个内置菜单项；`text`、`image`、`file` 表示输入能力。`[D]` 表示借鉴 Ditto，`[C]` 表示借鉴 CopyQ 的可组合/脚本式思想，`[M]` 表示 Maccy 的纯文本语义。

| 类别 | id | 标签 | 输入 | 说明 | 示例 |
|---|---|---|---|---|---|
| Case | upper | UPPERCASE [D] | text | Unicode 大写，不改 emoji/CJK | `Hello 世界` → `HELLO 世界` |
| Case | lower | lowercase [D] | text | Unicode 小写 | `HTTP` → `http` |
| Case | title | Title Case [D] | text | 按词边界首字母大写 | `hello world` → `Hello World` |
| Case | sentence | Sentence case [D] | text | 每句首字母大写，其余小写 | `hello. WORLD` → `Hello. World` |
| Case | invert | Invert case [D] | text | 逐字符反转大小写 | `AbC` → `aBc` |
| Case | camel | CamelCase [D] | text | 分隔词转 Pascal/Camel 词组 | `hello-world` → `HelloWorld` |
| Case | snake | snake_case | text | 词组转小写下划线 | `Hello World` → `hello_world` |
| Case | kebab | kebab-case [D] | text | 词组转小写连字符 | `Hello World` → `hello-world` |
| Whitespace | trim | Trim whitespace [D] | text | 去首尾空白，保留内部换行 | `  a  ` → `a` |
| Whitespace | collapse | Collapse whitespace | text | 连续空白折叠成一个空格 | `a\n\t b` → `a b` |
| Whitespace | remove-line-breaks | Remove line breaks [D] | text | 换行替为空格 | `a\nb` → `a b` |
| Whitespace | crlf-to-lf | CRLF → LF | text | 规范化行尾 | `a\r\nb` → `a\nb` |
| Whitespace | lf-to-crlf | LF → CRLF | text | Windows 行尾 | `a\nb` → `a\r\nb` |
| Whitespace | line-prefix-suffix | Prefix/suffix each line | text | 参数化添加每行前/后缀 | `a\nb`, `>` → `>a\n>b` |
| Encoding | url-encode | URL encode | text | `encodeURIComponent` 语义 | `a b` → `a%20b` |
| Encoding | url-decode | URL decode | text | 解码百分号序列，错误可见 | `%E4%B8%AD` → `中` |
| Encoding | html-encode | HTML entity encode | text | 转义 `&<>"'` | `<a>` → `&lt;a&gt;` |
| Encoding | html-decode | HTML entity decode | text | 解实体为 Unicode | `&amp;` → `&` |
| Encoding | base64 | Base64 encode/decode | text,image,file | 文本编码；图片/文件编码字节 | `hi` → `aGk=` |
| Encoding | json-format | JSON pretty/minify | text | 严格解析后美化或压缩 | `{"a":1}` → `{"a": 1}` |
| Encoding | escape-quotes | Escape quotes | text | 面向 JSON/JS 字符串转义引号和反斜杠 | `a"b` → `a\"b` |
| Date/Time | now | Insert current date/time | text | 在光标处插入按设置格式的本地时间 | `Today: ` → `Today: 2026-09-14` |
| Date/Time | timestamp | Epoch ↔ ISO 8601 | text | 自动识别秒/毫秒或 ISO | `0` → `1970-01-01T00:00:00Z` |
| Path | win-to-posix | Windows → POSIX path [D] | text,file | 盘符映射为 `/c/...`，UNC 转 `/server/share` | `C:\\a\\b` → `/c/a/b` |
| Path | expand-home | Expand `~` | text | 仅在路径首段展开用户目录 | `~/x` → `C:\\Users\\u\\x` |
| Path | relative-absolute | Absolute ↔ relative | text,file | 相对当前工作目录转换，缺上下文则拒绝 | `src/a` → `C:\\app\\src\\a` |
| Text ops | slugify | Slugify [D] | text | Latin/CJK 保守处理；中文默认保留 Unicode，不伪造拼音 | `Hello 世界` → `hello-世界` |
| Text ops | guid-uuid | Generate GUID/UUID [D] | text | 不依赖输入，生成 v4 UUID | `—` → `550e8400-e29b-41d4-a716-446655440000` |
| Text ops | hash | Hash MD5/SHA-256 | text,image,file | 输出十六进制摘要；大对象异步 | `abc` → `sha256:ba7816...` |
| Text ops | lines | Sort/dedupe/reverse/number/join | text | 参数选择一种行操作 | `b\na\nb` → `a\nb`（dedupe/sort） |
| Format | markdown-html | Markdown ↔ HTML | text | 受限 sanitizer，拒绝脚本标签 | `**x**` → `<strong>x</strong>` |
| Format | json-yaml | JSON ↔ YAML | text | 解析后转换，限制深度/大小 | `{"a":1}` → `a: 1` |
| Format | csv-tsv | CSV ↔ TSV | text | 保留引号和空字段 | `a,b` → `a\tb` |
| Image | image-data-url | Image ↔ base64 data URL | image,file,text | PNG/JPEG MIME 明确，安全限制尺寸 | PNG → `data:image/png;base64,...` |
| Image | combine | Combine images H/V | image | 选中多条图片横向/纵向合成 | `a,b` → 一张 PNG |
| Image | paste-as-image | Paste as image [D] | file | 文件路径读取可识别图片并写 image clipboard | `a.png` → 图片粘贴 |
| Plain text | plain-text | Paste as plain text [M] | text | 丢弃 HTML/RTF，仅写 `text/plain` | 富文本 → 纯文本 |

“Paste as image”只能处理明确的本地图片文件，不解析任意 URL。`lines`、`base64`、`hash` 等应在二级参数面板中选择模式，但仍是单一 registry id 的参数化变换。

## 4. 技术架构

### Registry 与 pipeline

Transform 的核心接口如下：

```ts
type InputType = 'text' | 'image' | 'file';
type TransformContext = { entryId: string; cwd?: string; locale: string; cursor?: number; signal: AbortSignal };
type TransformOutput = { type: InputType; text?: string; bytes?: Uint8Array; mime?: string; warnings?: string[] };
interface Transform {
  id: string; label: string; category: string; inputTypes: InputType[];
  async: boolean; run(input: TransformInput, ctx: TransformContext): Promise<TransformOutput>;
}
```

内置实现放在 `electron/transforms/*.cjs`，由一个静态 index 显式加载；不扫描并执行目录中的代码。用户扩展位于 `%APPDATA%/pasty-clipboard/transforms/*.json`，启动时读取、schema 校验并合并到 `pasty-transforms.json` registry 快照。扩展只允许有限 AST：`lower`、`upper`、`trim`、`regex-replace` 等 op；禁止 `eval`、函数、脚本、文件/网络访问。正则必须有长度、步数/超时保护，拒绝明显灾难性回溯模式。

一次变换和组合 pipeline 都支持，组合格式为 `a|b|c`，每一步校验上一步输出类型和大小。hover 默认调用 preview，结果缓存按 `entry fingerprint + pipeline + locale + parameters`，Enter 调用 apply。apply 把结果交给现有的 clipboard 写入/WindowsBridge 粘贴路径，不在 transform 中发送按键。

同步项包括大小写、空白、简单路径和小文本编码；hash 大对象、图片合成、OCR、格式转换和文件读写为异步。UI 显示“处理中”、阶段、已处理字节和取消；超时或取消不改变剪贴板。单项默认限制 10 MB 文本/32 MB 图片，文件先拒绝超限，不把完整大对象复制到多份内存。

IPC 新增：`transform:list({inputType})`、`transform:preview({entryId,pipeline,params})`、`transform:apply({entryId,pipeline,params,mode})`、`transform:register({json})`。主进程重新取 entry、检查来源窗口和权限，不信任 renderer 传来的内容；`register` 只写 schema 通过的 JSON。异常返回稳定错误码。`apply` 复用现有复制入口，随后调用 `resolvePasteDelay`；因此变换发生在 paste timing 之前，不改该函数。

## 5. 数据模型与状态

持久 registry 快照为 `%APPDATA%/pasty-clipboard/pasty-transforms.json`，包含 schema version、内置版本、用户变换和禁用 id。每个用户 JSON 例如：

```json
{
  "id": "my-slug", "label": "项目代号转小写", "input": "text",
  "ops": [
    { "type": "regex-replace", "pattern": "PROJ-(\\d+)", "replacement": "proj-$1", "flags": "i" },
    { "type": "lower" }
  ]
}
```

历史条目不写每次结果；保持无状态、可复现。可在非持久 session state 中保留每条 entry 最近 5 个 pipeline，供菜单“最近使用”显示，重启清空；仅 registry 和用户偏好落盘。结果若选择“保存为新条目”，按普通 text/image/file entry 进入 history，走 `textFingerprint`/敏感检查。

## 6. 与现有功能集成

`resolvePasteDelay` 不认识 transform；变换先完成，再按目标来源决定 35ms 本地或 320ms 远程延迟，保持现有性能目标。`protectSensitive` 是最终写入前的硬门：原始条目和变换结果都检测，任何 pipeline 不能传入 `custom` 绕过它；敏感结果只允许预览脱敏或拒绝粘贴。

OCR 结果支持“发送 OCR 结果到历史为文本”，之后按普通 text entry 变换；不要在 pin renderer 内直接执行 transform。F4 仍是截图编辑器“复制并 pin”，不触发特殊粘贴；从历史图片选择 Image transforms 后另行粘贴，pin/保存状态不改变。富文本条目选择普通变换默认先取 plain text，并明确提示；`plain-text` 则是显式的格式剥离。

## 7. 风险与缓解

1. `eval`/脚本变成任意代码执行：只接受 JSON schema 和白名单 AST，主进程逐 op 执行，拒绝函数、模块、命令和网络。
2. 大文件/图片造成 OOM：大小上限、流式 hash、单次 buffer 配额、合成画布像素上限，超限给出可操作错误。
3. 异步变换阻塞粘贴：preview/apply 返回任务状态，允许取消；只有完成且敏感检查通过才调用 clipboard/WindowsBridge。
4. 用户变换抛错：每步隔离 try/catch、错误码和日志摘要；坏 registry 项禁用而不阻止 Pasty 启动。
5. 与既有 paste-as-plain-text 冲突：保留单独的显式菜单项和快捷键，声明它只影响格式，不再隐式套用其他 pipeline。
6. transform 触发剪贴板监听造成重入：apply 使用一次性内部 transaction id，暂时标记写入来源；监听器忽略同 transaction 的回读，但仍保留用户随后手动复制的内容。
7. 正则灾难性回溯或极深 pipeline：限制 pattern/替换长度、禁止危险结构、最多 8 步并设置执行预算；失败即取消。
8. 路径和文件读取泄露：只允许用户明确选中的 file entry，路径转换不自动访问文件；工作目录缺失时不猜测。

## 8. 分步实施计划（每步不超过一天）

1. 在 `electron/transforms/types.cjs`、`registry.cjs` 建接口、白名单 schema、大小/正则限制；单测恶意 JSON。
2. 在 `electron/transforms/text.cjs` 实现 case/whitespace/plain-text；测试 Unicode、换行、富文本降级。
3. 在 `electron/transforms/encoding.cjs` 实现 URL/HTML/Base64/JSON；测试错误输入和上限。
4. 在 `electron/transforms/path.cjs`、`datetime.cjs`、`ops.cjs` 实现路径、时间、行操作、slug、UUID、hash。
5. 在 `electron/transforms/format.cjs`、`image.cjs` 接入受限 parser、PNG/data URL 与合成；验证无脚本 HTML。
6. 在 `electron/main.cjs` 加载静态 registry、用户快照和 `transform:list/register` IPC；不改受保护 Sites 文件。
7. 增加 `transform:preview/apply` IPC，复用现有 entry 读取、敏感检查、clipboard 写入和 WindowsBridge；保留 delay 逻辑。
8. 在 `src/App.jsx`/新增 `src/components/SpecialPasteMenu.jsx` 接入右键、键盘菜单、预览、取消和错误展示。
9. 加入 `?` 帮助、最近 5 个 session pipeline、设置中的自定义 JSON 导入提示；不提供代码编辑器。
10. 运行单元/IPC/UI smoke、`npm run build` 与 `npm run test:sites`；确认 `dist/client/index.html`、`dist/server/index.js`、`dist/.openai/hosting.json` 均存在且受保护文件无差异。

## 9. 测试计划

- `UPPERCASE` 的 `Hello 😀 世界 é` 应保留 emoji/CJK，正确转换 Latin；Title/Sentence 对 Unicode 边界有固定断言。
- slugify 的中文默认保留 Unicode（不引入不稳定的拼音库）；`你好 世界` 变为 `你好-世界`，标点被安全移除，英文转小写。
- CRLF→LF→CRLF 对 `a\r\n\r\n` 保持两行语义；不把 lone CR 静默扩成多行。
- 文本和真实 PNG image→base64 data URL→image clipboard 往返，MIME、字节 hash 和透明通道一致。
- declarative transform 含 `eval`、超长 pattern、危险回溯、未知 op、8 步以上时注册失败；恶意正则在预算内被拒绝/取消。
- JSON、CSV、URL 的非法输入只产生可读错误，不写剪贴板；敏感输入及变换后敏感输入都被 `protectSensitive` 阻断。
- preview 不改变 clipboard/history；apply 只写一次、不会被监听器重入，且本地/远程 delay 仍为 35/320ms 目标。
- 多图片 H/V 合成、文件非图片拒绝、异步 hash 取消、renderer 关闭期间 IPC 权限校验；F4 capture/pin 行为回归测试保持不变。

## 10. 可访问性、性能与可观测性约束

菜单必须完全可键盘操作，焦点环不能被预览面板遮住；每个灰显项仍有可读的不可用原因。屏幕阅读器应读出类别、变换名称、输入类型和预览状态，颜色不能成为唯一的成功/警告信号。预览面板支持复制结果但必须再次经过敏感检查，并明确显示“尚未粘贴”。

性能预算沿用现有路径：小文本同步预览目标小于 35ms，远控目标仍为 320ms 的同步延迟而不是变换延迟；慢变换只能显示 spinner，不得让主窗口卡顿。主进程记录 transform id、输入类型、耗时、输出大小、取消/失败原因和 registry 版本，但不记录原文、路径内容或敏感结果。日志中的 entry id 必须可脱敏，用户可在设置中关闭诊断日志。

IPC 每次请求都校验 sender、entry 是否仍存在、pipeline 是否来自当前 registry，以及参数是否在范围内。renderer 只能看到安全的 preview 摘要和受限 data URL；原始文件路径、用户目录和敏感检测详情不通过无关 IPC 广播。registry 更新采用临时文件加原子替换，解析失败保留上一版快照。升级时以 schema version 迁移；未知 op 只禁用该自定义项，不影响内置菜单。

预览还应提供“查看差异”折叠区：短文本按字符高亮新增、删除和替换，图片显示尺寸、MIME 与字节变化，文件显示仅转换了路径还是读取了内容。这样用户可以区分“路径字符串转换”和“图片实际读取”，降低误操作风险。对会生成新值的 GUID/UUID、当前时间和随机化操作，hover 预览固定本次结果，直到参数或刷新动作改变，避免用户看到的预览与 Enter 后粘贴的结果不一致。重试、取消和窗口关闭都应释放 AbortController，不能留下后台读取任务。

默认只在菜单打开且条目仍处于焦点时预览，鼠标快速划过多个项使用 100ms debounce；缓存命中直接展示。对敏感内容，预览只显示局部掩码和结果状态，不显示可复制的完整文本。若用户明确选择“保存为新条目”，弹出一次“这会把变换后的内容加入历史”的确认，仅对敏感结果额外要求确认，不让普通操作增加多余对话框。

发布验收以三条硬门为准：第一，未选择变换时旧的 `clipboard:paste-entry`、F4 截图、pin、OCR 和快捷键行为逐项回归；第二，任何失败、取消或敏感拦截都不能写入系统剪贴板；第三，Sites 构建产物和既有 Windows bridge 均保持可用。registry 读写、预览和 apply 的错误必须可在无网络、无外部服务的本地环境重现，不能依赖云端转换器或在线 OCR。实现完成后应在干净用户目录运行一次，确认缺少自定义 registry 时内置菜单仍完整显示。

菜单文案还要区分“转换后粘贴”和“复制转换结果”：前者完成 apply 后自动恢复/聚焦目标窗口并走 WindowsBridge，后者只更新系统剪贴板，不发送 Ctrl+V。预览中的结果格式应标注 `text/plain`、`image/png` 或文件路径，防止用户误把 data URL 当成图片文件。所有变换均应保留原条目可再次打开，且不会改变 pinned、createdAt、source 或截图 pin 的会话几何信息。

诊断页可提供“重置自定义变换”操作：只删除用户 registry 快照并重新加载内置项，不删除历史、图片、pins 或应用偏好。导入文件先在内存校验，展示将新增、替换、禁用的 id，用户确认后才原子写入；重复 id 默认拒绝覆盖内置变换。

The implementation should keep transformation semantics independent from window focus. A preview request may be retried, reordered, or discarded, while an apply request must carry one explicit transaction and one source entry. This separation makes cancellation safe and prevents a late preview response from replacing a newer result. It also gives telemetry a stable boundary: registry validation, transformation execution, sensitive-content policy, clipboard write, and keystroke paste can each be tested and diagnosed separately.

## 11. 代码级骨架

```ts
type InputType = 'text' | 'image' | 'file';
type TransformInput = { type: InputType; text?: string; bytes?: Uint8Array; mime?: string };
type TransformContext = { entryId: string; locale: string; cursor?: number; signal: AbortSignal };
type TransformOutput = TransformInput & { warnings?: string[] };
interface Transform { id: string; label: string; category: string; inputTypes: InputType[];
  async: boolean; run(input: TransformInput, ctx: TransformContext): Promise<TransformOutput>; }

const UpperTransform: Transform = { id: 'upper', label: 'UPPERCASE', category: 'case',
  inputTypes: ['text'], async: false,
  async run(input) { return { ...input, text: input.text!.toLocaleUpperCase() }; } };
const SlugifyTransform: Transform = { id: 'slugify', label: 'Slugify', category: 'text',
  inputTypes: ['text'], async: false,
  async run(input) { return { ...input, text: input.text!.normalize('NFKC').trim()
    .toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') }; } };

ipcMain.handle('transform:preview', async (_event, request) =>
  transformService.preview(request.entryId, request.pipeline, request.params));

function SpecialPasteMenu({ entry, onClose }) {
  const [pipeline, setPipeline] = useState('upper');
  const [preview, setPreview] = useState(null);
  const previewNow = async (next) => setPreview(await window.pasty.transformPreview(entry.id, next));
  const apply = () => window.pasty.transformApply(entry.id, pipeline);
  return { entry, pipeline, preview, onHover: previewNow, onCommit: apply, onCancel: onClose };
}
```
