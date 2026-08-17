# 真实终端截图测试

本目录用于在 GitHub Actions 中启动真实终端窗口，验证 `math` 扩展最终呈现的像素，而不仅是检查图片协议和转义序列。

测试程序不会调用模型或 Pi CLI，也不需要任何模型 API 密钥。`fixture.mjs` 直接使用 Pi 0.84.2 的扩展加载器、`Markdown`、`TuiMainScreen`、`TuiAltScreen` 和 `ProcessTerminal`，因此公式会经过与实际 Pi TUI 相同的扩展加载、Markdown 渲染和终端写出路径。

## 覆盖范围

| 终端            | Runner              | 常规模式 | 全屏模式 | 当前状态   |
| --------------- | ------------------- | -------- | -------- | ---------- |
| Kitty 0.48.2    | Ubuntu 24.04 + Xvfb | 截图     | 截图     | 必须通过   |
| Ghostty 1.3.1   | Ubuntu 24.04 + Xvfb | 截图     | 截图     | 必须通过   |
| WezTerm nightly | Ubuntu 24.04 + Xvfb | 截图     | 截图     | 必须通过   |
| Warp stable     | Ubuntu 24.04 + Xvfb | 截图     | 截图     | 探索性任务 |
| iTerm2          | macOS 14            | 截图     | 截图     | 探索性任务 |

Warp 与 iTerm2 暂时使用 `continue-on-error`。即使任务失败，工作流仍会上传已有日志和诊断截图。

Warp 截图测试只验证终端渲染，不测试首次启动向导。每次截图都会使用独立、临时的 XDG 目录，并在其中写入 Warp 开源代码所定义的本地 onboarding 完成标记；这些状态不会污染 runner 的真实用户目录，也不会绕过待测的终端绘制路径。

iTerm2 不使用 AppleScript 或辅助功能自动化。每种模式都在独立的临时 `HOME` 中运行，并预设测试所需的 iTerm2 首次启动状态：关闭自动更新、提示和会话恢复，使用固定的 150 × 44 深色动态配置，并将 “Allow Terminal-Initiated Display?” 的固定选择设为 “Yes”。这些设置只存在于临时目录，不修改 runner 或开发者的真实 iTerm2 配置；OSC 1337 图片仍由真实 iTerm2 解析和绘制。

iTerm2 全屏截图中显示原始 LaTeX 是预期行为：Pi 0.84.2 会在全屏 TUI 中禁用 iTerm2 图片协议。其常规模式块公式应正常显示为图片。

## WezTerm nightly

WezTerm 不使用 2024 年的 stable 版本。工作流每次都从官方 GitHub `nightly` release 下载 Ubuntu 24.04 包及其 `.sha256` 文件，并在安装前完成校验。

`nightly` 标签是可变的，因此每次运行都会在 artifact 中记录：

- 官方下载地址；
- 官方 SHA-256；
- 实际下载文件 SHA-256；
- `wezterm --version` 输出。

首次截图确认后，如果需要稳定的像素基线，应同时固定已经审核过的 nightly 文件哈希；否则 nightly 更新可能带来合理的字体或抗锯齿差异。

## 工作流

工作流文件：

```text
.github/workflows/visual.yml
```

触发方式：

- 推送影响扩展或视觉测试的文件到 `main`；
- 在 GitHub 的 **Actions → Visual terminal screenshots → Run workflow** 中手动触发。

每个终端依次运行：

1. 为该模式建立隔离的配置、缓存、状态和短路径 runtime 目录；
2. `regular`：Pi `TuiMainScreen`；
3. `fullscreen`：Pi `TuiAltScreen`；
4. 固定窗口为约 1600 × 900 像素；
5. 等待 fixture 写出 ready 文件；
6. 捕获真实终端窗口；
7. 检查截图尺寸和灰度标准差，拒绝空白图；
8. 上传截图、contact sheet、终端版本、窗口信息、插件元数据及启动日志。

## 首轮人工验收

当前阶段不自动决定公式“是否看起来正确”。首轮 artifact 应人工检查：

- `INLINE-BEGIN` 与 `INLINE-END` 是否都完整可见；
- 行内公式后面的英文后缀是否消失或错位；
- 多行矩阵是否完整，是否只剩顶部条带；
- aligned 公式、根式、分式和大括号是否被裁切；
- 宽公式是否等比例缩小而不是横向拉伸；
- 块公式各行之间是否出现接缝、空白或重复；
- 透明背景和公式颜色是否自然；
- 常规与全屏截图是否符合各终端在兼容表中的预期；
- 截图中是否出现首次启动、登录或权限提示，而不是测试内容。

每个 artifact 都包含：

```text
regular.png
fullscreen.png
contact-sheet.png
regular.json
fullscreen.json
*-install.txt
*-launcher.log
*-validation.txt
```

失败任务还可能包含：

```text
*-diagnostic-root.png
*-diagnostic-screen.png
*-windows.txt
```

## 建立自动视觉基线

第一次截图经人工确认后，再执行第二阶段：

1. 将审核通过的截图保存到 `tests/visual/baselines/<terminal>/`；
2. 固定终端版本、nightly 哈希、字体、窗口尺寸和 runner；
3. CI 生成 `actual.png` 和 `diff.png`；
4. 使用带容差的像素或感知差异，而不是要求所有抗锯齿像素完全相同；
5. 任何终端升级都先产生待审核 artifact，再更新基线。

当前仓库尚未包含基线，避免把未经人工确认的首轮输出直接视为正确结果。

## 文件说明

```text
tests/visual/
├── README.md
├── package.json
├── package-lock.json
├── fixture.mjs
├── smoke.mjs
├── install-linux-terminal.sh
├── capture-linux.sh
├── capture-iterm.sh
└── config/
    ├── kitty.conf
    ├── ghostty.conf
    ├── iterm2.json
    └── wezterm.lua
```

- `fixture.mjs`：确定性公式页面和 Pi TUI 驱动程序；
- `smoke.mjs`：在启动 GUI 前验证扩展加载器与 Pi TUI 使用同一模块实例；
- `install-linux-terminal.sh`：安装指定终端并记录版本、来源和哈希；Ghostty 使用其官方安装文档列出的 Ubuntu 社区包；
- `capture-linux.sh`：在 Xvfb/Openbox 中启动真实 Linux 终端并截取窗口；
- `capture-iterm.sh`：在隔离的 macOS 用户目录中预设无交互配置，通过 iTerm2 的 `--command` 参数启动测试窗口，再调用 `screencapture`；
- `config/`：固定字体、字号、颜色和窗口选项，包括 iTerm2 动态配置。

## 供应链约束

- Node 依赖固定为 Pi 0.84.2，并从 `https://registry.npmjs.org/` 安装；
- Kitty、WezTerm 和 Warp 从各自官方发布渠道获取；
- Ghostty 官方不提供 Linux 二进制，工作流使用其官方安装文档列出的 `ghostty-ubuntu` 社区包，并固定版本与 SHA-256；
- WezTerm nightly 使用官方 `.sha256` 校验；
- GitHub Actions 均固定到具体 commit SHA；
- 工作流权限只有 `contents: read`；
- 不使用模型密钥；截图只作为当前仓库的 GitHub Actions artifact 上传，不发送到额外服务。
