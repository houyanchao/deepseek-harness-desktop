# DSH Desktop

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

- macOS（Apple Silicon）：`DSH-<version>-arm64.dmg`
- Windows：`DSH-Setup.exe`

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

## 开发

```bash
pnpm install
pnpm run bundle-runtime   # 下载 node/pnpm 到 ./runtime（当前平台）
pnpm run build-icons      # 由 assets/icon.svg 生成 icon.icns / icon.ico（仅 mac 可跑）
pnpm run smoke            # 冒烟：走真实首启链路（registry 装 dsh + 起 dsh web）
pnpm run test-manifest    # 单测：更新清单解析
pnpm run test-plugins     # 单测：插件预装决策逻辑
pnpm start                # 开发模式启动
```

## 打包

```bash
pnpm run bundle-runtime -- --platform darwin --arch arm64
pnpm run make             # out/make 下产出 zip/dmg（mac）或 zip/Setup.exe（win）
# 只出 dmg（复用已 package 的产物）：
pnpm exec electron-forge make --skip-package --targets @electron-forge/maker-dmg
```

runtime 只含 node + pnpm，无原生编译步骤，任何平台都可以为任何目标平台 staging；
但 Electron 打包本身仍建议在目标平台上跑（签名要求）。

## 更新机制（统一清单）

菜单「检查更新…」由**一个远程 JSON 清单**驱动两条通道（`src/update-manifest.mjs`）：

```json
{
  "shell": {
    "version": "0.2.0",
    "mac": "<dmg url>",
    "win": "<setup exe url>",
    "macFeed": "<squirrel json url>",
    "winFeed": "<squirrel dir url>"
  },
  "dsh": {
    "version": "0.1.0-rc.8",
    "versions": ["0.1.0-rc.8", "0.1.0-rc.7"],
    "plugins": ["dshmarket", { "package": "dsh-timeline", "version": "0.1.3" }]
  }
}
```

- **shell**：清单版本比本机新 → 优先走自动原地更新（`src/shell-updater.mjs`，
  Electron 内置 Squirrel autoUpdater）：配置了对应平台的 feed 就后台下载、
  提示重启完成升级；没配 feed、feed 未发布或应用失败（如 mac 未签名）时
  回退为弹框引导下载安装包。
  - `macFeed`：一个静态 JSON 文件的地址，内容 `{"url": "<maker-zip 产出的 zip 地址>"}`。
    **mac 自动更新硬性要求应用已签名**，Squirrel.Mac 拒绝换入未签名包。
  - `winFeed`：一个目录地址，放 maker-squirrel 产出的 `RELEASES` 和 `.nupkg`。
    Windows 不签名也能自动更新（仅安装时有 SmartScreen 提示）。
- **dsh**：清单钉住桌面用户应使用的 DSH 版本（发布节奏由清单控制，可刹车/回退），
  比本机新 → 后台 pnpm 安装到 `userData/runtime/<version>/`，重启生效。
  首启安装同样优先读清单，清单不可达时回落 registry 的 dist-tag。
- **dsh.versions（可选）**：人工审核的版本白名单，驱动版本切换窗口——官方发新版
  后先本地验证，验证过的才加进清单允许用户切换安装。配置后窗口只显示白名单
  （+ 本机已下载的版本，保证能切回）；清单配置了但不可达时宁缺勿滥（只显示已
  下载的，不放开审核门）；未配置 `versions` 字段则回落 registry 全量列表。
  项可以是版本字符串或含 `version` 字段的对象（多余字段会被忽略，可用于自己
  记备注）。列表顺序无所谓，窗口按版本号从新到旧排。
- **dsh.plugins（可选）**：新装机应自带的插件清单，首启预装（详见上文「架构」
  节）。项可以是包名字符串（装最新版）或 `{ "package": "...", "version": "..." }`
  对象（钉住版本）。只影响还没装过该插件的机器，存量用户不会被动装上。
- 清单地址在 `config.mjs` 的 `UPDATE_MANIFEST_URL`。**当前（过渡状态）默认指向
  随应用打包的 `update-manifest.json`**（`file:` 地址），白名单/钉版本即刻生效；
  但内置清单在打包时冻结——远程刹车/回退做不到，每次改清单都要重新打包发版。
  静态托管就绪后把它换成 https 地址即恢复"改线上 JSON 即全网生效"的完整能力
  （`DSH_DESKTOP_MANIFEST` 环境变量可临时覆盖，便于本地测试）。清单不可达时
  shell 通道跳过、DSH 首启回落 registry latest、版本窗口只显示已安装版本。

## 配置项（`src/config.mjs`）

| 常量 | 说明 |
|---|---|
| `NODE_VERSION` / `PNPM_VERSION` | 内置运行时版本（Node 需满足 DSH engines） |
| `DSH_PACKAGE` / `DSH_DIST_TAG` | DSH 包名与回落 dist-tag（默认 latest） |
| `REGISTRY` | DSH 安装、profile `.npmrc` 用的 registry，默认 npmmirror |
| `UPDATE_MANIFEST_URL` | 统一更新清单地址，`null` 时走回落行为 |

## 发布一个新版本（流程）

1. 改 `package.json` 的 `version`，`pnpm run bundle-runtime && pnpm run make`
   （mac、win 各自在目标平台上跑）。
2. 把产物传到静态托管：mac 的 zip + dmg，win 的 `Setup.exe` + `RELEASES` +
   `.nupkg`。
3. mac 再放一个 feed JSON（`{"url": "<zip 地址>"}`）。
4. 改清单 JSON 的 `shell.version` 及各下载/feed 地址。旧版本应用下次启动即
   亮「更新」按钮，点击自动升级。

## 许可证

本项目基于 [GNU General Public License v3.0](./LICENSE) 开源。

Copyright (C) 2026 houyanchao
