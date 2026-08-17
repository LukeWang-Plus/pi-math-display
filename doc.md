# math 插件二次开发方案（实施版）

本文记录以 `pi-math` 为基础开发 `math` 插件的方案与功能精简结果，避免后续上下文丢失。

本文最初用于确认设计；当前方案已经实施，`index.ts` 与三个 vendor 产物均已生成并通过验证。

## 1. 目标与约束

目标运行环境以 Windows + WezTerm + Nushell 为主，同时保留原插件对其他终端的兼容能力。

最终扩展应满足：

- 直接放入 Pi 的扩展目录使用；
- 运行时不需要 `node_modules`；
- 运行时不需要 npm、esbuild 或其他构建步骤；
- 运行时不访问网络、不启动子进程；
- 不维护单独的日常开发仓库；
- 除 vendor 外，业务代码全部合并到一个 `index.ts`；
- MathJax 使用固定的 3.2.2 版本；
- Resvg 使用 WASM，避免平台相关 `.node` 原生二进制；
- 保留原 Markdown、会话内容和模型上下文，只改变 TUI 显示；
- 不额外补充许可证文件或 `vendor/licenses/` 目录；
- vendor 下载和一次性打包所需的所有 npm 包只允许来自 npm 官方 registry：`https://registry.npmjs.org/`；
- 禁止使用 unpkg、jsDelivr 等第三方 CDN 获取 MathJax、Resvg、WASM、esbuild 或其他构建输入。

## 2. 最终目录结构

```text
math/
├── README.md
├── doc.md
├── index.ts
├── vendor/
│   ├── mathjax.cjs
│   ├── resvg.cjs
│   └── resvg.wasm
└── .vendor-build/
```

安装到 Pi 全局扩展目录时，正式运行只需要：

```text
~/.pi/agent/extensions/math/
├── index.ts
└── vendor/
    ├── mathjax.cjs
    ├── resvg.cjs
    └── resvg.wasm
```

Pi 会自动发现目录中的 `index.ts`，通常不需要修改 `settings.json`。`README.md` 和 `doc.md` 可以随安装保留，但不是运行时必需文件。

`.vendor-build/` 按要求暂时保留用于重建和回归测试；它不属于运行时安装集合，也不需要复制到 Pi 扩展目录。

## 3. Vendor 的来源

### 3.1 `vendor/mathjax.cjs`

MathJax 3.2.2 没有与 Resvg 类似的、适合本方案的单文件 Node 直接 API 官方产物。

官方 `tex-svg-full.js` 与 `adaptors/liteDOM.js` 不能作为两个完全独立的 Node 文件直接满足需求，原因包括：

- `liteDOM` 依赖 MathJax core/startup 的加载顺序；
- browser component 使用全局 `MathJax` 和自动启动流程；
- Node 路径还会涉及额外组件或外部模块；
- `/reload` 下的全局状态和重复初始化更脆弱；
- 若保留完整官方目录，需要携带大量文件。

因此采用一次性工具生成：

```text
mathjax-full@3.2.2 官方模块
+ mhchemparser@4.1.0
            ↓
         esbuild
            ↓
 vendor/mathjax.cjs
```

规则：

- MathJax 本身不人工重写；
- 只人工编写一个很小的打包入口，用于导入并导出所需的 direct API；
- 使用临时目录从 `https://registry.npmjs.org/` 安装固定版本依赖并运行 esbuild；
- 正式发布清理时删除临时目录和临时 `node_modules`；当前二次开发阶段按要求保留 `.vendor-build/`；
- 运行时安装集合中不包含 esbuild、npm 工程或 `node_modules`；
- 以后日常修改 `index.ts` 不需要重新构建；
- 只有升级 MathJax、改变被打包的包集合或重新生成 vendor 时才需要再次运行一次性打包流程。

`mathjax.cjs` 应导出 `index.ts` 初始化直接模式所需的 MathJax API，包括：

- `mathjax`；
- `liteAdaptor`；
- `RegisterHTMLHandler`；
- `TeX`；
- `SVG`；
- `SafeHandler`；
- 最终选定的 TeX package 配置。

不能直接使用 `AllPackages` 作为打包入口，因为它会把已明确删除或禁用的包也作为副作用引入。打包入口应显式导入最终包集合。

### 3.2 `vendor/resvg.cjs`

来源为官方：

```text
@resvg/resvg-wasm@2.6.2/index.js
```

文件内容不人工重写，仅改名为 `resvg.cjs`，明确以 CommonJS 加载。

### 3.3 `vendor/resvg.wasm`

来源为官方：

```text
@resvg/resvg-wasm@2.6.2/index_bg.wasm
```

保存为：

```text
vendor/resvg.wasm
```

下载后应校验 npm 官方发布信息中的完整性哈希。

`index.ts` 负责读取该文件，并调用官方 `initWasm()`。WASM 不能脱离 JS glue 单独使用，因此 `resvg.cjs` 与 `resvg.wasm` 都必须保留。

### 3.4 下载源与供应链约束

生成 vendor 时，唯一允许使用的远程 npm 源为：

```text
https://registry.npmjs.org/
```

这里的 npm 官方源指 `registry.npmjs.org`，不是 npm 包展示网页，也不是第三方文件代理。

明确禁止使用：

```text
unpkg.com
cdn.jsdelivr.net
jsDelivr
其他第三方 CDN、镜像站或文件代理
```

该限制适用于：

- 下载 `mathjax-full@3.2.2`；
- 下载 `mhchemparser@4.1.0`；
- 下载固定版本的 esbuild 及其平台包；
- 下载 `@resvg/resvg-wasm@2.6.2`；
- 获取 `index.js` 和 `index_bg.wasm`；
- 将来重新生成或升级任何 vendor。

所有版本必须精确固定，不能使用 `latest`、范围版本或未固定标签。

MathJax 一次性打包应在临时目录中使用类似流程：

```text
npm install --save-exact \
  mathjax-full@3.2.2 \
  mhchemparser@4.1.0 \
  esbuild@0.25.12 \
  @esbuild/win32-x64@0.25.12 \
  --registry=https://registry.npmjs.org/
```

Resvg 官方发布物应通过 npm 官方 registry 获取，例如在临时目录执行：

```text
npm pack @resvg/resvg-wasm@2.6.2 \
  --registry=https://registry.npmjs.org/
```

然后只从该 npm 官方 tarball 中提取：

```text
package/index.js       → vendor/resvg.cjs
package/index_bg.wasm  → vendor/resvg.wasm
```

不得改为从 unpkg、jsDelivr 或其他 CDN 分别下载这两个文件。

完整性要求：

1. 从 npm 官方 registry 元数据取得 `dist.integrity`；
2. 由 npm 校验下载 tarball 的完整性；
3. 记录或复核最终提取文件的哈希；
4. MathJax bundle 的全部输入包也必须由 npm 官方 registry 提供；
5. 正式发布清理时删除临时 tarball、临时工程和临时 `node_modules`；当前 `.vendor-build/` 按要求保留。

实现和验证阶段如需查询包元数据，也应直接查询 `registry.npmjs.org`，不得为了方便改用第三方 CDN。

本次 MathJax bundle 使用的 esbuild 关键选项为：

```text
bundle: true
platform: "node"
format: "cjs"
target: "node22"
packages: "bundle"
sourcemap: false
legalComments: "inline"
```

本次实施核对的 npm `dist.integrity` 为：

```text
mathjax-full@3.2.2
sha512-+LfG9Fik+OuI8SLwsiR02IVdjcnRCy5MufYLi0C3TdMT56L/pjB0alMVGgoWJF8pN9Rc7FESycZB9BMNWIid5w==

mhchemparser@4.1.0
sha512-rFj6nGMLJQQ0WcDw3j4LY/kWCq1EftcsarQWnDg38U47XMR36Tlda19WsN4spHr0Qc9Wn4oj6YtvXuwVnOKC/g==

esbuild@0.25.12
sha512-bbPBYYrtZbkt6Os6FiTLCTFxvq4tt3JKall1vRwshA3fdVztsLAatFaZobhkBC8/BrPetoa0oksYoKXoG4ryJg==

@esbuild/win32-x64@0.25.12
sha512-alJC0uCZpTFrSL0CCDjcgleBXPnCrEAhTBILpeAp7M/OFgoqtAetfBzX0xM00MUsVVPpVjlPuMbREqnZCXaTnA==

@resvg/resvg-wasm@2.6.2
sha512-FqALmHI8D4o6lk/LRWDnhw95z5eO+eAa6ORjVg09YRR7BkcM6oPHU9uyC0gtQG5vpFLvgpeU4+zEAz2H8APHNw==
```

最终 vendor 文件的 SHA-256 为：

```text
vendor/mathjax.cjs
81b196b9eca41a6a367c1b2a22c1fc5a123b737abfef0bc78d04c4e0da66a8c8

vendor/resvg.cjs
0c1cd17c478a10ad891b147808c4f27b1023216f7726c49528c22c310c83ee6c

vendor/resvg.wasm
22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70
```

其中 `resvg.cjs` 和 `resvg.wasm` 已与 npm 官方 tarball 内的 `index.js`、`index_bg.wasm` 逐字节比较一致。

## 4. MathJax package 策略

### 4.1 默认启用

保留当前 `pi-math` 的广泛兼容策略，默认启用以下 package：

```text
base
action
ams
amscd
bbox
boldsymbol
braket
bussproofs
cancel
cases
centernot
color
colortbl
empheq
enclose
extpfeil
gensymb
mathtools
mhchem
newcommand
upgreek
unicode
verb
tagformat
textcomp
textmacros
```

这意味着继续支持普通数学、AMS 环境、量子力学记号、化学式、证明树、交换图、颜色、约去线、特殊箭头等较广泛的 TeX 功能。

`mhchemparser@4.1.0` 一并打入 `mathjax.cjs`，避免运行时外部依赖。

### 4.2 预先打包但默认不启用

以下配置模块可预先打入 `mathjax.cjs`，但遵循 MathJax 官方兼容策略，默认不启用：

```text
physics
colorv2
setoptions
```

原因：

- `physics` 可能与其他宏定义冲突；
- `colorv2` 不能与当前 `color` 同时启用；
- `setoptions` 允许公式输入改变解析选项。

以后如确有需要，只修改 `index.ts` 的启用列表即可，不必重新生成 `mathjax.cjs`。

### 4.3 明确删除

从 bundle 和运行时 package 列表中删除：

```text
configmacros
```

因为已经确定不支持全局 `macros` 和 `environments` 配置，保留它没有用途。

### 4.4 沿用原插件禁用策略

继续不打包、不启用：

```text
html
noerrors
noundefined
```

原因：

- `html` 扩大 HTML、样式、URL 和属性输入面；
- `noerrors` 会将 TeX 错误转成公式内错误文本，破坏原 LaTeX 回退；
- `noundefined` 会吞掉未知命令错误，破坏原 LaTeX 回退。

### 4.5 公式内宏仍然支持

虽然删除 `configmacros`，但保留 `newcommand` package，因此单个公式内部仍可使用：

```latex
\def
\newcommand
\renewcommand
\let
\newenvironment
\renewenvironment
```

每个公式是独立渲染单元，这些定义不会跨公式持久化。

## 5. 配置精简结果

### 5.1 删除的环境变量

删除：

```text
PI_MATH_MACROS
PI_MATH_ENVIRONMENTS
PI_MATH_SYSTEM_FONTS
```

同时删除：

- JSON 宏配置解析；
- JSON 自定义环境配置解析；
- 系统字体启用开关；
- 系统字体数据库发现和扫描。

### 5.2 唯一保留的环境变量

只保留：

```text
PI_MATH_FONT_FILES
```

它不是专门限定为中文字体，而是提供给 Resvg WASM，用于渲染 MathJax SVG 中必须由外部字体绘制的 `<text>` 字符。

标准数学符号、拉丁字母和希腊字母优先使用 MathJax 自带 SVG 路径；外部字体主要用于：

- 公式中的中文；
- CJK 和其他 MathJax 没有内置路径的字符；
- 某些显式 Unicode 字符；
- 其他需要 SVG `<text>` 的内容。

MathJax 输出应配置为路径字形优先，例如不让普通 `mtext` 无条件继承系统字体。只有 SVG 中确实出现 `<text>` 时才加载字体。

### 5.3 Nushell 示例

在启动 Pi 前设置：

```nu
$env.PI_MATH_FONT_FILES = 'C:\Windows\Fonts\MiSans-Regular.ttf'
pi
```

多个字体在 Windows 下用分号分隔：

```nu
$env.PI_MATH_FONT_FILES = 'C:\Windows\Fonts\MiSans-Regular.ttf;C:\Windows\Fonts\seguisym.ttf'
```

若要永久生效，可写入 Nushell 的 `config.nu`。

规则：

- 路径在扩展初始化时校验；
- 字体只在首次遇到需要 `<text>` 的公式时读取；
- 字体字节在当前扩展实例中缓存；
- 第一项字体作为主要默认字体，因此覆盖中文的字体应放在最前；
- MiSans 只负责需要外部字体的文本，不改变普通数学符号的 MathJax 字形；
- 未配置字体而公式需要外部字体时，整个公式保留原 LaTeX；
- 配置字体缺少某个字形时可能显示缺字符号，应使用覆盖范围足够的字体；
- Resvg 图片栅格化不能直接借用 WezTerm 当前使用的终端字体。

当前机器上可使用：

```text
C:\Windows\Fonts\MiSans-Regular.ttf
```

## 6. 命令精简结果

整个删除：

```text
/math-render
```

包括删除：

```text
/math-render on
/math-render off
/math-render status
/math-render clear
```

以及 `enable`、`disable` 别名。

相应删除：

- 运行时启用/停用状态；
- `enabled` 开关；
- 面向命令显示的协议信息；
- 面向命令显示的缓存数量和字节数；
- 面向命令显示的最近一次公式失败；
- 手动清缓存入口。

最终行为：

- 扩展加载成功后始终启用；
- 不支持图片的终端自动保留原 LaTeX；
- 单个公式渲染失败时自动保留原 LaTeX；
- `/reload` 会重新创建扩展实例和缓存；
- 渲染器初始化失败但可回退原始 LaTeX 时，通过 Pi UI 发送一次 `warning`；Markdown 集成补丁或终端图片最终输出补丁安装失败时发送一次 `error`。

内部仍可保留结构化失败代码、负缓存和测试所需诊断，但不再提供用户命令查看。

## 7. 保留的公式识别能力

全部保留：

### 行内公式

```text
$...$
\(...\)
```

内容恰好为 `...` 或 `…` 时仍按公式处理，不增加基于内容的特殊排除规则。因此，“使用 `\(...\)` 包裹了吗”中的省略号会作为公式渲染；若要明确展示定界符源码，应使用 Markdown 行内代码。

### 块级公式

```text
$$...$$
\[...\]
```

### 裸数学环境

保留原扫描器支持的环境，包括：

```text
equation
equation*
displaymath
math
align
align*
alignat
alignat*
flalign
flalign*
gather
gather*
multline
multline*
split
aligned
alignedat
gathered
array
matrix
pmatrix
bmatrix
Bmatrix
vmatrix
Vmatrix
cases
```

## 8. 保留的 Markdown 与 TeX 扫描保护

继续保留：

- fenced Markdown code block；
- indented Markdown code block；
- inline code span；
- HTML `<code>`；
- HTML `<pre>`；
- HTML 注释；
- TeX `\verb` / `\verb*`；
- TeX `%` 注释；
- 转义分隔符；
- 内联美元符号的货币误判保护；
- 嵌套 `\begin` / `\end` 环境栈；
- 不完整公式原样保留；
- 解析或渲染回调异常时原样保留。

这些属于正确性和安全保护，不作为可选功能删除。

## 9. 保留的公式规范化

保留原插件的消息级规范化，包括：

- 去除孤立公式中无意义的 `\label{...}`；
- 将显式 `\tag{...}` 转为本地可见标注，避免 MathJax 生成全宽编号表；
- 移除 `\notag` 和 `\nonumber`；
- 解开最外层 `equation`、`equation*`、`displaymath`、`math` 环境。

## 10. 保留的 SVG 与 PNG 渲染能力

保留：

- MathJax TeX → SVG；
- Resvg WASM SVG → PNG；
- 透明背景；
- 主题相关公式颜色；
- 固定基础公式尺度为终端 cell 高度的 `0.40` 倍（原插件为 `0.50`），同时作用于行内和块级公式；
- 公式过宽时只做最小必要比例缩小；
- 宽高使用同一比例，不拉伸；
- 行内公式限制在一行高度内；
- 终端 cell 像素尺寸感知；
- 终端宽度变化后重新计算布局；
- 整数 cell 画布；
- 四周透明安全留白；
- RGBA alpha 实际墨迹边界扫描；
- 墨迹触边时拒绝图片，防止根号、分数线、边框或重音裁切；
- 小画布优先 2× device scale；
- 2× 超过 4096 像素时退到 1×；
- 输入长度、画布尺寸和 PNG 大小限制；
- 所有 Kitty 兼容块公式按终端行生成像素完全等价的 PNG 切片；
- 失败时不输出部分或损坏图片。

## 11. 保留的缓存

保留：

- SVG 加权 LRU 缓存；
- PNG 加权 LRU 缓存；
- 条目数量和字节数双重上限；
- 结构化失败负缓存；
- Markdown 组件级 `WeakMap` 转换缓存；
- 同一消息、尺寸、颜色和协议下复用转换及图片 ID；
- 窗口尺寸变化时生成新的布局缓存键。

由于删除 `/math-render clear`，缓存通过 `/reload` 或扩展实例销毁释放。

## 12. 保留的终端兼容范围

继续正式保留原插件支持范围：

### Kitty 和 Ghostty

- Kitty graphics protocol；
- 行内公式使用 Unicode virtual placement，真正参与终端 cell 布局；
- 块公式按终端行切成独立 PNG，每行使用一个 `r=1`、`C=1` 且具有独立图片 ID 的 Kitty placement；
- 每个块图片 placement 只覆盖当前行，不会与随后其他行的 `ESC[2K` 相交。

### WezTerm

- 不使用会被逐行清屏破坏的 Kitty 直接 placement；
- 使用 WezTerm 官方支持的 OSC 1337 `doNotMoveCursor=1` 扩展；
- 行内公式继续作为真正的一行 MathJax 图片；
- 块公式按终端行切成独立 PNG，每行在 Pi 全屏清行完成后单独绘制，避免只剩顶部条带；
- Markdown 阶段只放置定宽私用字符及受保护的短期标记，最终写终端前才展开图片载荷，避免 Pi 把 base64 误计入文本宽度；
- 常规与全屏 TUI 使用同一路径。

### Warp

- Kitty graphics compatibility；
- 行内公式在 Markdown 布局阶段只保留定宽占位符和受 nonce 保护的短期标记，最终写终端时才展开为光标覆盖式一行 Kitty 图片，避免光标控制序列破坏 Pi 的宽度计算；
- 块公式与 Kitty/Ghostty 一样按终端行切片，每行使用独立的一行 Kitty placement；
- 常规与全屏 TUI 使用同一路径。

### iTerm2

- 常规模式使用 OSC 1337 块级图片，并在绘制完整图片前先预留其全部终端行，因此不会在图片绘制后继续清理其覆盖行；
- Pi 0.84.2 在全屏模式主动禁用 iTerm2 图片，扩展随 capability 回退原 LaTeX；
- 不支持可靠真行内图片时使用原公式回退。

### tmux、screen 和不支持图片的终端

- 遵循 Pi capability detection；
- 不发送图片协议；
- 保留原 LaTeX。

## 13. Pi 0.84.2 集成方式

当前 Pi 版本为 0.84.2。

Pi 已提供公开的 `registerMarkdownTransformer()`，但该 API 只能进行 Markdown 渲染前的同步字符串转换，无法完成 WezTerm 和 Warp 行内图片所需的渲染后定位、占位符替换和行级图片插入。

因此仍需保留受控的 `Markdown.render()` 包装。WezTerm 和 Warp 还需要一个受控的 `ProcessTerminal.write()` 最终输出包装：Markdown 和布局阶段只接触可正确计宽的占位内容，终端写出前才将受 nonce 保护的标记分别展开为 OSC 1337 图片或光标覆盖式 Kitty 图片。两个包装都必须：

- 安装前检查运行时结构；
- 分别保存原始 `Markdown.prototype.render` 和 `ProcessTerminal.prototype.write`；
- 只在 TUI 和相应受支持图片协议下转换；
- 使用 `try/finally` 恢复组件原始 Markdown 文本；
- 在 `session_shutdown` 和 `/reload` 时卸载；
- 仅当相应 prototype 仍是本扩展包装时才恢复，避免覆盖其他扩展；
- 兼容失败时停止图片转换并保留原 Markdown；
- 不修改会话、消息对象或模型上下文。

Pi 0.84.2 自带 Unicode LaTeX 显示。为了维持本方案的“失败时显示原 LaTeX”语义，包装层需要确保未成功转换的公式不被内置 Unicode 公式渲染替换。

## 14. `index.ts` 的职责

除 vendor 外，以下业务逻辑全部合并到 `index.ts`：

1. 定位扩展目录和 vendor 文件；
2. 加载 `mathjax.cjs`；
3. 初始化 MathJax direct API；
4. 加载 `resvg.cjs`；
5. 读取并初始化 `resvg.wasm`；
6. 解析唯一配置 `PI_MATH_FONT_FILES`；
7. 按需读取字体字节；
8. 扫描 Markdown 公式；
9. 规范化 LaTeX；
10. MathJax SVG 转换；
11. SVG 尺寸解析与安全画布构造；
12. Resvg WASM PNG 栅格化；
13. alpha 边界和资源限制检查；
14. Kitty 兼容终端的逐行 PNG 切片编码；
15. SVG、PNG 和转换缓存；
16. Kitty Unicode placeholder 编码；
17. Kitty/WezTerm/Warp/iTerm2 图片布局；
18. 安装和卸载 Markdown 及终端图片最终输出包装；
19. 注册 session lifecycle；
20. 初始化失败通知。

不再注册任何 slash command。

## 15. 初始化与 reload

推荐流程：

```text
扩展异步加载
  ↓
读取唯一配置
  ↓
加载 MathJax vendor
  ↓
读取并初始化 Resvg WASM
  ↓
安装 Markdown 包装
  ↓
正常渲染
```

`/reload` 时：

```text
session_shutdown
  ↓
卸载 Markdown 包装
  ↓
旧实例和缓存释放
  ↓
重新加载 index.ts
  ↓
重新初始化扩展
```

Resvg 的 `initWasm()` 只能对同一个 glue 模块初始化一次，实现时需要处理 Pi `/reload` 下 CJS 模块缓存和重复初始化，确保复用已初始化模块或安全识别“已经初始化”。

## 16. 验证范围

本次实施至少验证：

- 普通行内 `$...$`；
- `\(...\)` 行内公式；
- `$$...$$` 和 `\[...\]` 块级公式；
- `align`、矩阵、cases、嵌套环境；
- `mhchem`、braket、cancel 等专用 package；
- malformed TeX 原样回退；
- Markdown 和 HTML code 区域不转换；
- 货币美元符号不误判；
- 窄宽度比例缩小；
- 窗口 resize 重绘；
- 高公式和超宽公式；
- 透明留白和裁切检测；
- 2× 到 1× density 退化；
- SVG、PNG 和失败缓存；
- WezTerm OSC 1337 行内图片、块公式逐行切片以及 `doNotMoveCursor=1`；
- WezTerm 全屏 TUI 每一公式行均在该行清理后绘制；
- WezTerm 用户消息容器中的图片载荷不参与文本宽度计算，后续中英文保持完整；
- Kitty/Ghostty 行内 Unicode placeholder、逐行块图片及全屏逐行清理顺序；
- Warp 受保护的行内标记、最终 Kitty 光标覆盖展开、逐行块图片及全屏逐行清理顺序；
- Kitty/Ghostty/Warp 块图片的协议高度恒为 `r=1` 且图片 ID 逐行独立；WezTerm 块图片的 OSC 高度恒为 `height=1`；所有切片像素均可无损重组为原始完整 PNG；
- iTerm2 常规块级布局和全屏原 LaTeX 回退；
- tmux/screen/无协议回退；
- 不配置字体时中文公式原样回退；
- 配置 MiSans 后中文公式成功显示；
- 原始 Markdown 在渲染后完全恢复；
- 会话和模型上下文不被修改；
- `/reload` 后旧 patch 被正确卸载；
- 不存在 `/math-render` 命令；
- 已删除的三个环境变量不再生效；
- 正式安装时不复制 `.vendor-build/`，运行时文件集合中不存在 `node_modules`。

## 17. 实施与验证状态

已实施：

- 使用生成的 `vendor/mathjax.cjs`；
- Resvg 使用官方 CJS glue + WASM；
- 业务逻辑合并为单个 `index.ts`；
- 删除 `/math-render` 全部命令；
- 删除 `PI_MATH_MACROS`；
- 删除 `PI_MATH_ENVIRONMENTS`；
- 删除 `PI_MATH_SYSTEM_FONTS`；
- 删除 `configmacros` package；
- 只保留 `PI_MATH_FONT_FILES`；
- MathJax 保留广泛 package 兼容；
- 保留所有原终端兼容路径，并为 WezTerm 增加 OSC 1337 最终输出路径、为 Warp 增加受保护的最终 Kitty 覆盖路径；
- 所有 Kitty 兼容终端的块公式均按终端行切片，适配 Pi 0.84.2 全屏逐行清理；
- 保留行内和块级公式；
- 保留缓存、质量检查、安全扫描和回退；
- 不补充许可证文件；
- `newcommand` 的动态宏、分隔符和环境映射在每个独立公式转换后清空，避免定义跨公式残留；
- 块级公式使用单字符内部标记，避免窄窗口下标记被 Markdown 换行。

验证已覆盖：

- `npx tsc` 严格类型检查；
- Pi 0.84.2 自身扩展加载器加载 `math/index.ts`；
- 普通、AMS、矩阵、cases、`mhchem`、`braket`、`cancel`、`amscd`；
- 公式内宏可用且不会跨公式持久化；
- malformed TeX、超长输入、无字体中文和无图片协议的原始 LaTeX 回退；
- Markdown/HTML/TeX verbatim 保护和货币误判保护；
- Kitty/Ghostty 虚拟行内占位及逐行块图、WezTerm OSC 1337 行内图及逐行块图、Warp 受保护的覆盖式行内图及逐行块图、iTerm2 常规块图与全屏回退；
- 窄窗口重排、深层公式、高公式、超宽公式以及 2× 到 1× density 退化；
- MiSans 字体配置；
- 渲染器初始化失败发送一次 `warning`，Markdown 或终端图片最终输出集成失败发送一次 `error`；
- 同一进程重复初始化所对应的 `/reload` 路径；
- shutdown 后原始 `Markdown.prototype.render` 与 `ProcessTerminal.prototype.write` 恢复；
- 不注册 `/math-render` 或其他命令。

当前终端兼容验证同时包含本地协议、布局、像素和 Pi `TuiAltScreen` 输出自动化测试，以及 GitHub Actions 中的 Kitty、Ghostty、WezTerm nightly、Warp 与 iTerm2 真实终端截图流程。截图目前用于人工审核，尚未建立自动视觉基线。

`.vendor-build/` 当前按要求继续保留，用于后续二次开发和回归测试；只有在用户明确要求清理时才删除。正式运行所需文件仍只有第 2 节列出的四个文件。
