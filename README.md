# deepseek-harness-desktop

**中文** | [English](./README.en.md)

专为 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/)（DSH）打造的 macOS 与 Windows 桌面客户端：内置运行时、无需任何环境配置，安装即用，并支持在多个 DSH 版本之间一键切换。

## 特性

- **零配置**：内置 Node.js 与 pnpm，不依赖、也不影响系统里已有的任何环境；首次启动自动从 registry 安装 DSH。
- **版本管理**：顶栏打开版本列表，展示每个版本的发布日期与磁盘占用；一键下载切换、秒级回退，新版本启动失败自动回滚；不用的版本可手动删除释放空间。
- **数据跨版本共享**：所有 profile、插件、会话数据都在同一个 `DSH_HOME` 下，切换版本不丢数据。
- **双通道自动更新**：一份远程清单同时驱动壳子自身的更新（Squirrel 原地升级）与 DSH 的版本钉住/白名单。
- **插件预装**：首次启动自动装好推荐插件（插件市场 `dshmarket`、时间线 `dsh-timeline`），已有或被用户删除的插件不会被重复安装。
- **外链走系统浏览器**：DSH 界面里的外部链接自动交给系统默认浏览器打开。

## 安装

从 [Releases](https://github.com/houyanchao/deepseek-harness-desktop/releases) 下载对应平台的安装包：

- macOS（Apple Silicon）：`DSH_<version>_darwin_arm64.dmg`
- Windows：`DSH_<version>_win32_x64.exe`

首次启动需要网络（下载 DSH 本体）；之后离线可用。

## 架构

- **壳（本工程）**：进程管理 + 窗口。spawn `dsh web --port 0`，解析 stdout 的
  `dsh web: http://127.0.0.1:<port>` 就绪行后把 Web GUI 加载进窗口。壳子发版与 DSH 发版完全独立。
- **内置运行时**（`runtime/`，打包为 extraResource，只读）：
  - Node（仅 `bin/node` 单文件，剥离 npm/corepack）
  - pnpm dist + `runtime/bin` 下的 shim（`pnpm` / `pnpm.cmd`，固定使用内置 node）
- **DSH 不打进壳子**：首次启动时查询 registry 的 dist-tag（默认 `latest`），用内置
  pnpm 安装到 `userData/runtime/<version>/`（`.ready` 标记保证半成品会被重装）。
  启动时优先选 `runtime/current` 钉住的版本（版本切换器写入），没有钉住时
  回落到已安装的最新版本——DSH 升级 = 装一个新版本目录，与壳子无关。
- **版本切换**（`src/versions.mjs`）：顶栏版本按钮打开版本管理子窗口
  （`pages/versions.html`），列出可用版本的版本号、发布日期、磁盘占用（已下载的
  实测，未下载的按均值估算），并标出已下载/当前版本；切换 = 按需下载 → 写
  `runtime/current` → 原地重启 DSH 子进程（新版本起不来会自动回滚），成功后关闭
  窗口并弹 toast。旧版本不随切换删除（秒切回 / 可离线回退），由保留策略兜底磁盘：
  仅保留当前版本 + 最近 2 个其他版本，更旧的启动时后台清理；非当前版本也可在
  窗口里手动删除（只删程序文件，`DSH_HOME` 数据不动）。
- **插件预装**（`src/plugins.mjs`）：更新清单的 `dsh.plugins` 列出新装机应自带的
  插件，每次启动 DSH 前检查——profile 里已有的跳过、壳子装过一次的不再重复
  （用户之后删掉也不会被装回来，记录在 `dsh-home/.preinstalled-plugins.json`）、
  安装失败在后续启动重试至多 3 次后放弃。安装走 `dsh plugin --profile web add`
  （而非直接 pnpm），装完 DSH 会把插件 reconcile 进 profile 的 bundles，无需
  额外重启。全程尽力而为，清单不可达或安装失败都不阻塞启动。
- **用户数据**（`userData = <appData>/dsh-desktop`，与显示名解耦）：
  - `dsh-home/`：`DSH_HOME`，DSH 的 profile、插件、会话全在这里
  - `runtime/<version>/`：DSH 安装（首启 + 后续升级）
  - `logs/`：`install.log`（安装输出）、`dsh.log`（DSH 子进程输出）
