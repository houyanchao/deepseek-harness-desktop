# Windows 打包指南

产物（`out/make/squirrel.windows/x64/`）：`DSH-Setup.exe`（分发安装用）+
`RELEASES` + `.nupkg`（自动更新 feed 用），另有 zip。

## 环境要求

- Windows 10 及以上（自带 bsdtar，`bundle-runtime` 解压依赖它）
- Node.js ≥ 22、pnpm ≥ 10（仅打包机需要；产物内置独立运行时）
- **建议在 Windows 上打包**：maker-squirrel 在非 Windows 平台需要
  mono/wine，坑多不值得。

## 打包步骤

```powershell
pnpm install
pnpm run bundle-runtime -- --platform win32 --arch x64   # stage 内置 node/pnpm
pnpm run make                                            # 产出 Setup.exe + RELEASES + nupkg
```

## 注意事项

### runtime 与目标平台必须一致

`bundle-runtime` 每次运行会**清空重建** `./runtime`。打包前确认
`runtime/manifest.json` 是 `win32`——forge 只检查 runtime 目录存在，
**不校验平台**；拿 darwin 的 runtime 打 win 包不会报错，但装出来的应用
起不来（内置 node 是 Mach-O 二进制）。

### 图标不需要生成

`assets/icon.ico` 已提交入库，直接可用。`pnpm run build-icons` 依赖 macOS
的 sips/iconutil，在 Windows 上跑不了；改图标需在 mac 上重新生成后提交。

### Squirrel 安装器的特性

- 安装**不需要管理员权限**，装到 `%LocalAppData%` 下，适合个人分发；
- 安装/更新/卸载时 Squirrel 会用特殊参数（`--squirrel-install` 等）拉起
  应用本体。**当前工程尚未引入 `electron-squirrel-startup` 处理这些事件**，
  副作用是安装/更新过程中应用可能被多余地拉起一次；如需彻底规避，在
  `main.mjs` 入口最前面加：

  ```js
  import squirrelStartup from 'electron-squirrel-startup'
  if (squirrelStartup) app.quit()
  ```

  并 `pnpm add electron-squirrel-startup`。

### SmartScreen 提示（未签名）

未签名的 `Setup.exe` 首次运行会弹 SmartScreen：「更多信息 → 仍要运行」可
继续。**不影响自动更新**（Windows 的 Squirrel 更新不要求签名，这点和 mac
不同）。想去掉提示需要 OV/EV 代码签名证书（DigiCert、Sectigo 等 CA 购买），
EV 证书生效最快，OV 需要积累下载信誉。

### 发布对接

- `DSH-Setup.exe` → 上传到下载页 / GitHub Releases；
- `RELEASES` + `.nupkg` → 原样上传到一个静态目录，把该目录地址写进
  更新清单的 `winFeed`，老版本即可自动更新。每次发版要把**新旧所有**
  `.nupkg` 对应的行保留在 `RELEASES` 里（maker 会生成，注意别只传新文件
  覆盖掉整个目录）。
