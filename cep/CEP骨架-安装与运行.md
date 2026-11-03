# DreamEngine 面板安装与运行

更新：2026-11-03
当前环境：After Effects 2021 / CEP 11.1

## 1. 当前面板是什么

`cep/com.dreamengine.panel` 已经不再是 M0 探针壳，而是 DreamEngine 的 M1 首屏：

- 读取 AE 本机效果目录并显示预览墙；
- 内置 20 个真实效果缩略图；
- 支持中文 / English 切换；
- 支持按名称、matchName、分类搜索；
- 支持按内置、BCC、Sapphire、Red Giant、RE:Vision、Video Copilot 筛选来源；
- 未生成预览的效果显示缺图占位；
- 支持重新扫描 AE 效果。

M0 的探针页面和输出已经归档到 `probe-results/AE2021/`，不再作为当前面板入口。

## 2. 部署目录

Windows 的扩展目录是：

```text
C:\Users\<用户>\AppData\Roaming\Adobe\CEP\extensions\com.dreamengine.panel
```

目录层级必须为：

```text
com.dreamengine.panel/
├ CSXS/manifest.xml
├ index.html
├ css/
├ js/
├ data/
└ engine/
```

本机当前使用目录联接，便于直接修改仓库后重开面板：

```powershell
cmd /c mklink /J "$env:APPDATA\Adobe\CEP\extensions\com.dreamengine.panel" "D:\workqwen\DreamEngine-1\cep\com.dreamengine.panel"
```

如果目标联接已存在，先确认它是 Junction，并确认目标指向正确的仓库目录，再删除联接。不要直接递归删除扩展目录，以免误删仓库文件。

## 3. 开启未签名扩展

未签名 CEP 扩展需要设置 `PlayerDebugMode`。修改后完全退出 AE，再重新启动：

```powershell
reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add HKCU\Software\Adobe\CSXS.13 /v PlayerDebugMode /t REG_SZ /d 1 /f
```

当前 manifest 使用：

- Host：`AEFT [18.0,99.0]`
- RequiredRuntime：`CSXS 6.0`
- Bundle ID：`com.dreamengine.panel`
- 菜单名：`DreamEngine`

## 4. 启动与验收

启动 AE 2021，打开：

```text
窗口 > 扩展 > DreamEngine
```

首屏应满足：

1. 顶栏显示 `DreamEngine`。
2. 默认显示 20 张卡片，且 20 张都有真实缩略图。
3. 状态栏显示本机效果目录数量；当前基线为 1371 条。
4. 中文 / English 切换后，名称立即变化。
5. 搜索“模糊”应有匹配结果。
6. 切换“全部已安装”后，无缩略图的效果显示灰色占位，不报错。
7. 点击重新扫描后，效果数量和筛选结果仍能正常刷新。

## 5. 静态验证

在仓库根目录运行：

```powershell
node tools/test-m1.mjs
node tools/test-probes.mjs
node tools/es3check.mjs
git diff --check
```

其中 `test-m1.mjs` 检查当前 DreamEngine 面板目录、数据文件和测试路径；如果仍引用旧目录，会直接失败。

## 6. 常见问题

| 现象 | 处理 |
|---|---|
| 菜单里没有 DreamEngine | 确认 `PlayerDebugMode` 已设置、AE 已完全退出重开、扩展目录层级正确 |
| 面板空白 | 检查 `CSXS/manifest.xml` 是否可解析，以及 `RequiredRuntime` 是否与当前 CEP 兼容 |
| 面板显示“不在 CEP 内” | 这是用普通浏览器打开了 `index.html`，不能读取 AE 数据 |
| AE 版本显示错误 | 确认面板是从 AE 的“窗口 > 扩展”打开，而不是外部浏览器 |
| 读取不到效果 | 在 AE 中打开面板后点“重新扫描”；确认 CEP 与 ExtendScript 通道可用 |
| 缩略图缺失 | 这是正常降级；只有 20 个效果有离线缩略图，其余显示占位 |

## 7. 兼容边界

当前只在 AE 2021 / CEP 11.1 上完成实机验证。CC2022 / CC2023 的 manifest 和基础 API 仍在设计目标范围内，但没有实机结论；不能把 AE 2021 的结果当成完整兼容证明。

输出模板和探针目录统一使用 `DreamEngine PNG Sequence` 与 `DreamEngineProbe`。当前代码和运行路径不依赖旧名称。
