# math

`math` 是一个面向 [Pi](https://github.com/badlogic/pi-mono) TUI 的本地 LaTeX 公式渲染扩展。它使用 MathJax 完成 TeX 排版，再通过 Resvg WASM 生成透明 PNG，最后根据终端能力选择合适的图片协议显示公式。

扩展名称固定为 **math**。当前实现以 **Pi 0.84.2、Node.js 22、Windows、WezTerm 和 Nushell** 为主要目标，同时保留 Kitty、Ghostty、Warp 与 iTerm2 的兼容路径。

## 功能概览

- 使用 MathJax 3.2.2 进行完整的 TeX → SVG 排版，而不是用 Unicode 字符近似公式；
- 使用 Resvg WASM 生成透明、随主题着色的 PNG；
- 支持 `$...$`、`\(...\)`、`$$...$$`、`\[...\]` 及常见数学环境；
- 支持 AMS、矩阵、cases、`mhchem`、`braket`、`cancel`、`amscd` 等扩展能力；
- 行内公式可与普通文字、标点和列表内容共同排版；
- 块公式自动居中，过宽时只做必要的等比例缩小；
- 感知终端 cell 的像素尺寸，并在窗口宽度变化后重新渲染；
- 针对 Pi 全屏模式的逐行清屏行为，将多行块公式拆分为逐行图片；
- 保留 Markdown 代码区域、TeX `\verb`、转义分隔符和货币符号等扫描保护；
- 渲染失败或终端不支持图片时保留原始 LaTeX；
- 只改变 TUI 显示，不改写消息、会话记录或模型上下文；
- 运行时不依赖 `node_modules`，不访问网络，也不启动子进程；
- 无开关命令：扩展加载成功后始终启用。

## 运行要求

- Pi 0.84.2；
- Pi 所使用的 Node.js 22 运行时；
- Pi 能够识别的终端图片协议。

当前实现会包装 Pi 0.84.2 的 `Markdown.render()`，并在 WezTerm、Warp 中包装 `ProcessTerminal.write()`。升级 Pi 后应重新运行集成测试，确认相关内部接口没有变化。

## 终端兼容性

| 终端或环境   | 行内公式     | 常规模式块公式 | Pi 全屏模式  | 实现方式                                              |
| ------------ | ------------ | -------------- | ------------ | ----------------------------------------------------- |
| Kitty        | 支持         | 支持           | 支持         | 行内 Unicode virtual placement；块公式逐行 Kitty 图片 |
| Ghostty      | 支持         | 支持           | 支持         | 行内 Unicode virtual placement；块公式逐行 Kitty 图片 |
| WezTerm      | 支持         | 支持           | 支持         | OSC 1337、`doNotMoveCursor=1`、逐行块图片             |
| Warp         | 支持         | 支持           | 支持         | 受保护的行内 Kitty 覆盖图片；逐行块图片               |
| iTerm2       | 回退原 LaTeX | 支持           | 回退原 LaTeX | 常规模式使用 OSC 1337；Pi 全屏模式禁用该协议          |
| tmux、screen | 回退原 LaTeX | 回退原 LaTeX   | 回退原 LaTeX | 遵循 Pi capability detection，不发送图片              |
| 其他终端     | 回退原 LaTeX | 回退原 LaTeX   | 回退原 LaTeX | 未识别图片协议时保留源文本                            |

Kitty、Ghostty 和 Warp 的块公式会按终端行切成独立 PNG。每个 Kitty placement 只占一行，使用独立图片 ID，并固定为 `r=1`、`C=1`，因此不会被后续其他行的 `ESC[2K` 清除。

WezTerm 使用其支持的 OSC 1337 `doNotMoveCursor=1` 扩展。块公式同样逐行绘制，避免 Pi 全屏重绘时只剩顶部条带。行内图片的数据在最终写入终端前才展开，不会参与 Pi 的文本宽度计算。

当前兼容性验证包含协议、布局、像素及 Pi TUI 输出自动化测试。仓库另提供真实终端截图工作流；首轮截图需人工审核，审核前不作为自动视觉基线。

## 安装

Pi 会自动发现全局扩展目录中以 `index.ts` 为入口的扩展。运行时只需要以下四个文件：

```text
~/.pi/agent/extensions/math/
├── index.ts
└── vendor/
    ├── mathjax.cjs
    ├── resvg.cjs
    └── resvg.wasm
```

Windows 上对应的目录通常是：

```text
C:\Users\<用户名>\.pi\agent\extensions\math\
```

安装步骤：

1. 创建 `~/.pi/agent/extensions/math/` 及其 `vendor/` 子目录；
2. 将 `index.ts` 和三个 vendor 文件复制到对应位置；
3. 不要复制 `.vendor-build/` 或其中的 `node_modules`；
4. 在 Pi 中执行：

```text
/reload
```

通常不需要修改 Pi 的 `settings.json`。`README.md` 与 `doc.md` 仅用于说明，不是运行时必需文件。

## 使用

在用户消息或模型回复中使用普通 LaTeX 分隔符即可。

### 行内公式

```markdown
Euler 恒等式是 $e^{i\pi}+1=0$。

也可以写成 \(E=mc^2\)。
```

支持的行内分隔符：

```text
$...$
\(...\)
```

### 块公式

```markdown
\[
x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}
\]
```

也可以使用双美元符号：

```markdown
$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx=\sqrt{\pi}
$$
```

### 数学环境

```markdown
\begin{align}
a^2+b^2&=c^2,\\
e^{i\pi}+1&=0.
\end{align}
```

扫描器支持 `equation`、`align`、`gather`、`multline`、`aligned`、`array`、各种矩阵及 `cases` 等常见环境。

### 显示分隔符源码

如果想显示字面量 `\(...\)`，而不是渲染其中内容，请使用 Markdown 行内代码：

```markdown
请使用 `\(...\)` 包裹行内公式。
```

代码块、行内代码、HTML `<code>` / `<pre>` 以及 TeX `\verb` 中的内容不会被公式扫描器转换。

## 公式大小与布局

基础公式尺度固定为：

```text
0.40 × 终端 cell 高度 / MathJax ex
```

具体规则如下：

- 行内公式会等比例限制在一行高度内；
- 能正常容纳的公式不会被放大；
- 公式过宽时只缩小到刚好适合当前内容宽度；
- 宽高始终使用同一比例，不拉伸公式；
- PNG 画布对齐到整数个终端 cell，并保留透明安全边距；
- 小画布优先使用 2× 像素密度；超过 4096 像素限制时退回 1×；
- 终端尺寸变化后，会按新的布局重新计算并缓存结果。

## 字体配置

大多数数学符号、拉丁字母和希腊字母使用 MathJax 自带的 SVG 路径，不需要额外配置字体。

当公式包含中文、CJK 字符或其他必须通过 SVG `<text>` 绘制的字符时，可以在启动 Pi 前设置唯一支持的环境变量：

```text
PI_MATH_FONT_FILES
```

### Nushell

```nu
$env.PI_MATH_FONT_FILES = 'C:\Windows\Fonts\MiSans-Regular.ttf'
pi
```

多个字体在 Windows 上使用分号分隔：

```nu
$env.PI_MATH_FONT_FILES = 'C:\Windows\Fonts\MiSans-Regular.ttf;C:\Windows\Fonts\seguisym.ttf'
```

在 POSIX 系统上，多个路径使用冒号分隔。

字体配置规则：

- 路径在扩展初始化时校验；
- 字体只在首次遇到需要外部字体的公式时读取；
- 字体字节会在当前扩展实例内缓存；
- 第一项字体作为主要默认字体，应优先放置覆盖范围最合适的字体；
- 未配置字体而公式需要外部字体时，整个公式回退为原始 LaTeX；
- 修改环境变量后需要执行 `/reload`，或重新启动 Pi。

以下环境变量已经删除，不会生效：

```text
PI_MATH_MACROS
PI_MATH_ENVIRONMENTS
PI_MATH_SYSTEM_FONTS
```

## 宏与 MathJax 扩展

扩展不提供全局宏或全局环境配置，但保留了 `newcommand` package，因此单个公式内部仍可使用：

```latex
\def
\newcommand
\renewcommand
\let
\newenvironment
\renewenvironment
```

每个公式都是独立渲染单元。公式内创建的命令、分隔符和环境会在转换后清理，不会泄漏到下一条公式。

默认启用的 MathJax package：

<details>
<summary>查看完整列表</summary>

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

</details>

`physics`、`colorv2` 和 `setoptions` 已预先打入 `mathjax.cjs`，但默认不启用。若以后需要，可以修改 `index.ts` 的启用列表，而不必重新打包 MathJax。启用前应重新评估兼容性：`physics` 可能与现有宏冲突，`colorv2` 不能与当前 `color` 同时启用，`setoptions` 则允许公式改变解析选项。

`configmacros` 已从 bundle 和运行时配置中删除。`html`、`noerrors` 与 `noundefined` 也未打包或启用，以维持安全边界和“失败时保留原 LaTeX”的行为。

## 回退与错误处理

下列情况会保留原始分隔符和 LaTeX：

- Pi 未检测到支持的图片协议；
- 当前模式主动禁用了图片，例如 iTerm2 全屏模式；
- MathJax 拒绝不完整、错误或不支持的输入；
- 公式超过输入、画布或 PNG 大小限制；
- 公式需要外部字体，但未配置有效字体；
- MathJax、Resvg 或 Pi 渲染集成初始化失败。

回退只影响显示，不会把公式改写成 Unicode 近似文本。扩展也不会修改存储消息或发送给模型的上下文。

通知规则：

- 渲染器不可用但仍可回退原始 LaTeX 时，发送一次 `warning`；
- Markdown 或终端最终输出补丁安装失败时，发送一次 `error`；
- 单条公式渲染失败时静默回退，不连续弹出通知。

扩展没有 `/math-render` 或其他命令。若需要重新初始化渲染器、清空缓存或重新读取配置，请执行 `/reload`。

## 常见问题

### 为什么公式仍显示为 LaTeX？

依次检查：

1. 当前终端是否在兼容表中；
2. 是否位于 tmux 或 screen 中；
3. iTerm2 是否处于 Pi 全屏模式；
4. 公式语法是否完整；
5. 公式是否包含需要外部字体的字符；
6. Pi 是否显示了 `math` 的 warning 或 error 通知；
7. 修改配置或文件后是否执行了 `/reload`。

### 为什么中文公式没有渲染？

Resvg WASM 不能直接借用终端当前使用的字体。请通过 `PI_MATH_FONT_FILES` 明确指定覆盖中文字符的字体文件。

### 为什么 `\(...\)` 被识别为公式？

这是标准行内公式分隔符。若要原样显示，请使用 Markdown 行内代码，例如 `` `\(...\)` ``。

### 如何暂时关闭扩展？

本项目没有运行时开关。请将 `math` 目录移出 Pi 的 `extensions` 目录，或临时改名其中的 `index.ts`，然后执行 `/reload`。

## 开发者指南

### 目录结构

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
    ├── build-mathjax.mjs
    ├── mathjax-entry.mjs
    ├── integration.mjs
    ├── vendor-check.cjs
    ├── package.json
    ├── package-lock.json
    └── ...
```

- `index.ts`：全部运行时业务逻辑；
- `vendor/`：固定版本的运行时产物；
- `.vendor-build/`：vendor 重建与回归测试环境，不属于正式安装集合；
- `doc.md`：设计决策、精简范围、供应链信息和实施记录。

### 渲染流程

```text
Markdown
  ↓ TeX/Markdown 感知扫描
公式 span
  ↓ 规范化 label、tag 和外层环境
MathJax TeX → SVG
  ↓ 尺寸、安全边距与资源限制
Resvg WASM → 透明 PNG
  ↓ 终端行切片与缓存
协议相关布局
  ↓
Kitty / Ghostty / WezTerm / Warp / iTerm2
```

扫描器会跳过 fenced code block、缩进代码块、行内代码、HTML code/pre、HTML 注释、TeX `\verb` 和 TeX `%` 注释，并保护转义分隔符、货币美元符号及不完整公式。

### Pi 集成

Pi 0.84.2 的公开 Markdown transformer 只能在渲染前同步替换字符串，无法完成行内图片定位和渲染后的图片插入。因此本扩展安装一个可逆的 `Markdown.prototype.render` 包装。

WezTerm 和 Warp 还需要一个可逆的 `ProcessTerminal.prototype.write` 包装：

- Markdown 布局阶段只看到具有正确宽度的占位符；
- PNG 数据存放在带随机 nonce 的零宽 OSC 8 标记中；
- 写入终端前，标记才会展开为 OSC 1337 或 Kitty 图片控制序列；
- 无效或伪造 nonce 的标记不会被展开；
- shutdown 和 `/reload` 时，只在 prototype 仍指向当前包装的情况下恢复原函数。

这一过程只作用于 TUI 输出，不改写 Markdown 组件的原始文本、会话对象或模型上下文。

### 安全与资源边界

主要保护包括：

- MathJax `SafeHandler`；
- 禁止公式 URL 和任意样式输入；
- 不启用 `html`、`noerrors`、`noundefined`；
- 输入长度上限 20,000 个字符；
- 栅格宽高上限 4096 像素；
- 单个完整 PNG 或全部行切片总计上限 12 MiB；
- alpha 墨迹边界检测，墨迹触及画布边界时拒绝图片；
- SVG 与 PNG 独立的加权 LRU 缓存；
- 失败结果负缓存；
- 公式内动态宏和环境在每次转换后清理；
- 最终输出标记使用进程内随机 128-bit nonce。

### Vendor 来源

运行时不从 `node_modules` 加载 MathJax 或 Resvg。

| 文件                 | 来源                                       | 生成方式                            |
| -------------------- | ------------------------------------------ | ----------------------------------- |
| `vendor/mathjax.cjs` | `mathjax-full@3.2.2`、`mhchemparser@4.1.0` | 小型人工入口通过 esbuild 一次性打包 |
| `vendor/resvg.cjs`   | `@resvg/resvg-wasm@2.6.2/index.js`         | 从 npm 官方 tarball 提取并改名      |
| `vendor/resvg.wasm`  | `@resvg/resvg-wasm@2.6.2/index_bg.wasm`    | 从同一 npm 官方 tarball 原样提取    |

MathJax 本身不是人工重写的；人工维护的只有显式导入 package 并导出 direct API 的打包入口。

所有构建输入只允许从 npm 官方 registry 获取：

```text
https://registry.npmjs.org/
```

禁止使用 unpkg、jsDelivr 或其他第三方 CDN、镜像站和文件代理。所有版本均须精确固定，不使用 `latest` 或范围版本。

当前 vendor SHA-256：

```text
mathjax.cjs  81b196b9eca41a6a367c1b2a22c1fc5a123b737abfef0bc78d04c4e0da66a8c8
resvg.cjs    0c1cd17c478a10ad891b147808c4f27b1023216f7726c49528c22c310c83ee6c
resvg.wasm   22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70
```

更完整的 npm integrity、打包参数与供应链记录见 [`doc.md`](./doc.md)。

### 重建 MathJax vendor

只有升级 MathJax、改变 bundle 中的 package 集合或重新生成 vendor 时，才需要执行一次性打包。日常修改 `index.ts` 不需要重建。

在仓库的 `.vendor-build/` 目录中执行：

```bash
npm ci --registry=https://registry.npmjs.org/
node build-mathjax.mjs
node vendor-check.cjs
```

`build-mathjax.mjs` 使用以下关键参数：

```text
bundle: true
platform: node
format: cjs
target: node22
packages: bundle
sourcemap: false
legalComments: inline
```

Resvg 必须通过 npm 官方 registry 获取 `@resvg/resvg-wasm@2.6.2` 的完整 tarball，再从中提取 `index.js` 和 `index_bg.wasm`。不要从第三方 CDN 分别下载这两个文件。

### 格式化与测试

以下命令从仓库根目录执行：

```bash
npm ci --prefix tests/visual --registry=https://registry.npmjs.org/ --ignore-scripts

npm_config_registry=https://registry.npmjs.org/ \
  npx --yes prettier@3.8.2 --check \
  index.ts README.md doc.md .vendor-build/integration.mjs \
  tests/visual/fixture.mjs tests/visual/smoke.mjs

tests/visual/node_modules/.bin/tsc -p .vendor-build/tsconfig.json
node tests/visual/smoke.mjs
node .vendor-build/integration.mjs
node .vendor-build/vendor-check.cjs
sha256sum vendor/mathjax.cjs vendor/resvg.cjs vendor/resvg.wasm
```

集成测试使用 Pi 0.84.2 的实际扩展加载器、`Markdown`、`TuiMainScreen` 和 `TuiAltScreen`，覆盖：

- 普通公式、AMS、矩阵、cases、化学式和专用 package；
- Markdown/HTML/TeX 代码区域保护及货币符号；
- malformed TeX、超长输入、字体缺失和无图片协议回退；
- 公式内宏可用且不会跨公式持久化；
- 终端 resize、高公式、超宽公式和 2× → 1× 像素密度退化；
- Kitty/Ghostty 行内 virtual placement 与逐行块图片；
- Warp 行内最终输出展开、宽度保持与逐行块图片；
- WezTerm OSC 1337、`doNotMoveCursor=1` 和逐行块图片；
- iTerm2 常规绘制顺序与全屏回退；
- 每行图片在 Pi `ESC[2K` 之后绘制；
- 行 PNG 拼接后与完整 Resvg PNG 像素逐字节一致；
- nonce 防伪、patch 卸载和 `/reload` 生命周期。

`integration.mjs` 使用仓库内固定版本的 Pi 0.84.2 依赖，可以从任意检出目录运行。若系统没有可用的 CJK 字体，可通过 `MATH_TEST_FONT_FILE` 指定字体文件，以启用中文公式测试。

### 真实终端截图 CI

`.github/workflows/visual.yml` 会在 GitHub 托管 runner 中启动真实 Kitty、Ghostty、WezTerm nightly、Warp 和 iTerm2 窗口，分别捕获常规与全屏模式。该流程不调用模型，也不需要 API 密钥。

首轮工作流只上传截图、contact sheet、终端版本和诊断日志，供人工确认；审核通过后再建立带容差的自动视觉基线。完整说明见 [`tests/visual/README.md`](./tests/visual/README.md)。

## 设计取舍

- 扩展名称和安装目录固定为 `math`；
- 运行时只保留 `index.ts` 与三个 vendor 文件；
- MathJax 3.2.2 打包为本地 `mathjax.cjs`；
- Resvg 使用平台无关的 WASM 版本；
- 不提供 `/math-render` 及启用、停用、状态或清缓存命令；
- 不支持 `PI_MATH_MACROS`、`PI_MATH_ENVIRONMENTS`、`PI_MATH_SYSTEM_FONTS`；
- 不包含 `configmacros`，只保留公式内部的 `newcommand` 能力；
- 唯一配置项为 `PI_MATH_FONT_FILES`；
- 基础公式尺度固定为 `0.40`；
- WezTerm、Warp 和 Pi 全屏 TUI 使用协议专用兼容路径；
- 所有 Kitty 兼容块公式均使用逐行 PNG，避免跨行图片被后续清屏破坏；
- 运行时不需要 npm 安装、构建步骤、网络访问或子进程。

## 致谢

本项目的设计与初始实现来源于 [`Fadouse/pi-math`](https://github.com/Fadouse/pi-math)。公式排版与栅格化分别依赖 MathJax 和 Resvg 项目。
