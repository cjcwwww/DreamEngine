# DreamEngine Hub

## 开发运行

```powershell
npm install
npm start
```

## 构建

```powershell
npm run pack      # dist/win-unpacked
npm run dist      # NSIS 安装器
npm run test:package
npm run test:release
```

## 离线预设渲染

- 默认每个专用 AE 实例连续处理最多 40 条预设。
- 成功一条会立即写入结果并继续下一条，不会每 12 条主动重启。
- 只有 AE 崩溃、实例超时或达到 40 条上限时才启动下一个 AE 实例。
- 超时下限为 240 秒，并会按每条 30 秒自动放大，避免大批次被误判超时。
- 动态预设按 6 fps 抽取，最多保留 36 帧；面板按真实源时长播放，不再压缩成 0.5 秒快放。

## 持久构建缓存

默认位置：

```text
%LOCALAPPDATA%\DreamEngine\build-cache
```

其中：

- `electron-dist/<版本>/`：已解包 Electron，构建时直接复用；
- `electron-builder/`：NSIS、7zip 等工具；
- `electron/`：Electron 下载归档缓存。

只有主动删除这个目录才会重新准备构建依赖。`npm run pack` 不会重新下载 Electron。

## 安装器说明

NSIS 安装器会调用现有的 `install_dreamengine.ps1` 安装 CEP 面板和 L1 预览。
卸载器会调用 `uninstall_dreamengine.ps1`，清理 CEP 面板、预设库、背景、缓存、日志和安装时写入的 CEP 调试设置。升级路径不会执行这些清理。
安装器当前未配置代码签名，Windows SmartScreen 可能提示。
