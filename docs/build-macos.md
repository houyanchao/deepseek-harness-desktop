# macOS 打包指南

产物：`DSH-<version>-arm64.dmg`（分发安装用）+ `out/make/zip/darwin/` 下的 zip（自动更新 feed 用）。

## 环境要求

- macOS（Apple Silicon 打 arm64 包；如需 Intel 包，见下文「架构」）
- Node.js ≥ 22、pnpm ≥ 10（仅开发机需要；产物内置独立运行时，与开发机环境无关）

## 打包步骤

```bash
pnpm install
pnpm run bundle-runtime -- --platform darwin --arch arm64   # stage 内置 node/pnpm
pnpm run make                                               # 产出 dmg + zip 到 out/make
```

只想重新出 dmg（复用已 package 的产物）：

```bash
pnpm exec electron-forge make --skip-package --targets @electron-forge/maker-dmg
```

## 注意事项

### runtime 与目标平台必须一致

`bundle-runtime` 每次运行会**清空重建** `./runtime`，并按 `--platform/--arch`
下载对应的 node。打包前确认 `runtime/manifest.json` 里的 platform/arch 与目标
一致——forge 配置只检查 runtime 是否存在，**不校验平台**；用 win32 的 runtime
打出的 mac 包外表正常、启动即坏。在同一台机器上交替打 mac/win 包时，切换前
必须重新 stage。

### 图标

`assets/icon.icns` / `icon.ico` 已提交入库，日常打包**不需要**重新生成。
只有改了 `assets/icon.svg` 之后才需要跑：

```bash
pnpm run build-icons   # 依赖 sips/iconutil，仅 macOS 可跑
```

生成后记得把两个产物一起提交（Windows 打包机通常没法自己生成）。
更换图标后本机 Dock 可能显示旧图标，是系统缓存：`killall Dock` 即可刷新。

### 签名与公证（当前未配置）

`forge.config.mjs` 的 `packagerConfig` 里留有 TODO。未签名的影响：

- 其他机器首次打开会被 Gatekeeper 拦截。绕过方式：右键 → 打开，
  或 `xattr -cr /Applications/DSH.app`。
- **mac 自动更新（Squirrel.Mac）硬性要求已签名**，未签名时壳子的 shell
  更新通道自动回退为「弹框引导手动下载」，其余功能不受影响。

配置签名需要：

1. Apple Developer Program 账号（99 美元/年）；
2. **Developer ID Application** 证书（在 developer.apple.com 创建，
   导入本机钥匙串）；
3. 公证（notarization）用的 App Store Connect API Key；
4. 将 `osxSign` / `osxNotarize` 填进 `forge.config.mjs` 的 `packagerConfig`。

**证书安全**：`.p12` 证书与私钥绝不能提交进仓库（见仓库根 `.gitignore`，
也不要放任何公开位置）。CI 签名的标准做法是把 .p12 base64 后存入
GitHub Actions Secrets，构建时解码导入临时 keychain。

### 架构（arm64 / x64）

当前流程按 Apple Silicon（arm64）打包。arm64 的包**不能**在 Intel Mac 上
运行；需要 Intel 包时单独打一份：

```bash
pnpm run bundle-runtime -- --platform darwin --arch x64
pnpm exec electron-forge make --arch x64
```

注意两点：内置 node 的架构由 bundle-runtime 决定、Electron 本体架构由
make 的 `--arch` 决定，**两者必须一致**。

### 发布对接

- dmg → 上传到下载页 / GitHub Releases；
- zip → 上传后把地址写进 macFeed JSON（`{"url": "<zip 地址>"}`），
  供 Squirrel 自动更新拉取（前提是已签名）。
