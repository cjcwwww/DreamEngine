# DreamEngine 0.2.0

After Effects 效果可视化面板：浏览本机已安装的效果，每个带真实预览缩略图，
悬停可以看到效果动态施加的过程。

## 安装

1. 解压本包
2. 右键 `install.ps1` → 「使用 PowerShell 运行」
   （或在 PowerShell 里执行 `powershell -ExecutionPolicy Bypass -File .\install.ps1`）
3. 启动 After Effects，菜单里打开 **窗口 > 扩展 > DreamEngine**

安装脚本会做三件事：把扩展装到 CEP 扩展目录、部署随包附带的预生成预览
（所以不用等渲染）、打开 CEP 调试模式以允许加载未签名扩展。

## 随包附带的内容

| 内容 | 说明 |
|---|---|
| `l1/` | 预生成预览（manifest + 缩略图），装完即可用 |
| `extension/` | 扩展本体 |
| `install.ps1` | 一键安装 |

## 需要自己渲的部分

包外的效果（你机器上装的三方插件、或者包生成之后 AE 新增的效果）没有预览。
面板里点「生成缺失预览」会按需补渲——本机效果会实时读取，
所以**别人装的 AE 上效果不同是正常的**。

## 已知限制

- 目前只在 After Effects 2021 实机验证过
- 少数效果在渲染时会拖死 AE，已在代码里排除
- Lumetri 颜色用饱和度调整代替演示（真渲会崩）
