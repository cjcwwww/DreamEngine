# T0.7 aerender 结论（AE 2021 / 18.4.1x4）

## 已确认

- `aerender -help` 的参数表中没有 `-r`。
- `aerender -r` 不能作为执行 jsx 的入口。
- `aerender -outputSettings "Format: PNG Sequence"` 返回：

```text
aerender Error: After Effects错误: Invalid Value for key: <Format>. Property is read-only
```

- `AfterFX.exe -r <probe.jsx>` 在本机启动后立即退出，未生成任何探针输出，不能作为可靠自动化入口。

## 当前采用形态

离线生成采用两段式：

1. 在 AE 内运行 jsx，建立预览合成并保存 `.aep`。
2. 用 `aerender -project <aep> -comp <comp>` 渲染已保存的合成。

## 第三方插件验证

- 建立测试工程 `T0_7_plugin_test.aep`，图层包含 `S_Glow`。
- 当前 AE 中读回效果为：`MATCH=S_Glow|NAME=S_Glow`。
- `aerender -project ... -comp T0_7_plugin_test` 成功渲染出 PNG 帧。
- 日志中没有“效果缺失/插件未加载”错误。
- PNG 序列模板会把输出名追加帧号，实际文件为 `T0_7_plugin_render.png00000`。

## 并发

Adobe 许可条款与订阅类型未核实，因此工程默认 **aerender 并发数=1**。如后续确认许可允许，再单独提高并发，不把未经验证的许可结论写进代码。
