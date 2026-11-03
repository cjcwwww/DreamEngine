# CEP 骨架壳 · 安装与运行

这个壳**只为完成 M0 里两项必须在面板环境里测的任务**：

- `T0.3` CEF 纹理上限 / 大图 PNG 解码耗时 / 帧序列轮播掉帧 / GIF·WebP·视频编码可用性
- `T0.6b` 拖拽能否拿到真实文件路径（决定 M3 预设库要不要做拖拽入口）

它**不含任何 M1 业务代码**（没有预览墙、没有名字表、没有生成队列）。正式 `engine/` 目录到 M1 才建立，这个壳不依赖它。

---

## 1. 放文件

把 `cep/com.aeviewer.panel/` 整个文件夹拷到扩展目录：

- **Windows**：`C:\Users\<你>\AppData\Roaming\Adobe\CEP\extensions\com.aeviewer.panel`
  （也可放 `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\`）
- **macOS**：`~/Library/Application Support/Adobe/CEP/extensions/com.aeviewer.panel`

**层级必须对**：`com.aeviewer.panel/CSXS/manifest.xml`，不要多套一层或少套一层。

目录结构：

```
com.aeviewer.panel/
├ CSXS/manifest.xml
├ index.html
├ css/style.css
└ js/  bridge.js  main.js  t03_cef_probe.js  t06_drag_probe.js
```

## 2. 打开未签名扩展的调试开关

未打包签名的扩展必须开 `PlayerDebugMode`，**改完要退出 AE 重开**。

- **Windows**（cmd 执行，按 AE 用的 CEP 版本，建议 11/12/13 都写上）：

```
reg add HKCU\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add HKCU\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add HKCU\Software\Adobe\CSXS.13 /v PlayerDebugMode /t REG_SZ /d 1 /f
```

- **macOS**（终端）：

```
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
defaults write com.adobe.CSXS.13 PlayerDebugMode 1
```

新版 AE 用的是较新的 CEP/CSXS 运行时，所以三个都写最省事；manifest 里 `<RequiredRuntime Name="CSXS" Version="12.0"/>` 也要和你机器实际运行时对得上（见 §4 排查）。

## 3. 打开面板并跑

菜单路径：`窗口 > 扩展`（部分版本叫 `Extensions`，AE 不带 `(Legacy)` 后缀）→ **AE Viewer 骨架(探针)**

面板内顺序：

1. **「环境自检」**页签：三个点全绿才继续。CEP 通道 / AE jsx 可执行 / 脚本写文件权限
   - 第三个变红 = 没勾 `首选项 > 脚本和表达式 > 允许脚本写入文件和访问网络`
2. **「T0.3」**页签：先确认已经跑过 AE 侧的 `T0_2_渲染耗时探针.jsx`（要有整网 PNG 才能测大图解码），
   把 `文稿/AEViewerProbe/render_tmp` 路径填进去（**反斜杠会自动转正斜杠，但建议直接写 `/`**），点「运行 T0.3」
3. **「T0.6b」**页签：从资源管理器拖 3~5 个 `.ffx` 进去，看日志里 `path=` 有没有真实绝对路径，
   然后点「把拖拽结果写入 AEViewerProbe」
4. **「输出」**页签 → 「全部写入文件」：内容写到 `文稿/AEViewerProbe/`，文件名 `T0_3_CEF探针.txt`、`T0_6b_拖拽.txt`

跑完连同 AE 侧探针的输出一并打包回传。

---

## 4. 面板打不开 / 不出现：按这个顺序排查

| 现象 | 处理 |
|---|---|
| 菜单里完全没有扩展项 | ① 确认 `PlayerDebugMode` 已写 **且 AE 已完全退出重开**；② 检查目录层级是否 `CSXS/manifest.xml`；③ manifest 的 `Host Name="AEFT"` 版本区间是否含你的 AE（骨架里已放宽到 `[22.0,99.0]`） |
| 面板出现但空白 | `RequiredRuntime CSXS` 版本与机器实际运行时不符，把 manifest 里 `12.0` 依次改 `11.0` / `13.0` 试 |
| 「环境自检」显示非 CEP 环境 | 说明 `window.__adobe_cep__` 不存在 —— 你可能是在浏览器里打开的，见 §5 |
| AE 版本点变红 | AE 侧 jsx 执行失败，先确认 AE 里已开写文件权限，再确认面板是通过 AE 菜单打开而非外部浏览器 |
| 写文件失败 `OPEN_FAIL` | `AEViewerProbe` 目录没权限或被占用；先把探针目录整体改名备份再跑 |

---

## 5. 想先用浏览器预演（只能算近似参考）

`index.html` 可以直接用 Chrome 打开，此时：

- **能测到**：WebGL 上限、Canvas 尺寸、图片/视频格式支持 —— 但浏览器内核 ≠ CEP 的 CEF，结论只能参考
- **测不到**：AE 通道、写盘、目录列举、**拖拽的 `path` 属性**（标准浏览器没有这个扩展属性）

所以正式数据必须在 AE 面板里跑，浏览器预演不作为定版依据。

---

## 6. 诚实声明

这个骨架没在你的机器上实跑过，manifest 的运行时版本、菜单名称在不同 AE/CEP 组合上有差异，属正常现象；**打不开时先按 §4 调，不要怀疑探针逻辑本身**。跑通后如果发现某处 API 在当前版本不可用（比如 `canPlayType` 或 `getImageData` 行为异常），把面板日志贴回来即可。

---

内容由 AI 生成
