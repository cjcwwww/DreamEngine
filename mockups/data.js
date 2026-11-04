/* 效果图用的真实数据：名字来自 dist/L1/names.json，格位来自 dist/L1/manifest.json。
   全部落在 batch_000_0000.png 这张 8×8 精灵图里，跨行取样以拉开预览差异。 */
window.MOCK_SHEET = "../dist/L1/thumbs/batch_000_0000.png";

window.MOCK_ITEMS = [
  { zh: "高斯模糊",       en: "Gaussian Blur",        cat: "模糊和锐化", plugin: "内置", col: 0, row: 0, frames: 6 },
  { zh: "色光",           en: "Colorama",             cat: "颜色校正",   plugin: "内置", col: 4, row: 1, frames: 6 },
  { zh: "湍流置换",       en: "Turbulent Displace",   cat: "扭曲",       plugin: "内置", col: 3, row: 2, frames: 6 },
  { zh: "发光",           en: "Glow",                 cat: "风格化",     plugin: "内置", col: 4, row: 3, frames: 6 },
  { zh: "CC 万花筒",      en: "CC Kaleida",           cat: "风格化",     plugin: "内置", col: 1, row: 4, frames: 6 },
  { zh: "分形杂色",       en: "Fractal Noise",        cat: "杂色和颗粒", plugin: "内置", col: 0, row: 5, frames: 6 },
  { zh: "光束",           en: "Laser",                cat: "生成",       plugin: "内置", col: 1, row: 6, frames: 6 },
  { zh: "颜色范围",       en: "Color Range",          cat: "抠像",       plugin: "内置", col: 0, row: 7, frames: 6 },
  { zh: "径向模糊",       en: "Radial Blur",          cat: "模糊和锐化", plugin: "内置", col: 2, row: 0, frames: 6 },
  { zh: "亮度和对比度",   en: "Brightness & Contrast", cat: "颜色校正",  plugin: "内置", col: 1, row: 1, frames: 6 },
  { zh: "三色调",         en: "Tritone",              cat: "颜色校正",   plugin: "内置", col: 0, row: 2, frames: 6 },
  { zh: "马赛克",         en: "Mosaic",               cat: "风格化",     plugin: "内置", col: 7, row: 3, frames: 6 },
  { zh: "CC 玻璃",        en: "CC Glass",             cat: "风格化",     plugin: "内置", col: 4, row: 4, frames: 6 },
  { zh: "画笔描边",       en: "Brush Strokes",        cat: "风格化",     plugin: "内置", col: 0, row: 6, frames: 6 },
  { zh: "棋盘",           en: "Checkerboard",         cat: "生成",       plugin: "内置", col: 5, row: 7, frames: 6 },
  { zh: "CC 径向模糊",    en: "CC Radial Blur",       cat: "模糊和锐化", plugin: "内置", col: 7, row: 0, frames: 6 },
  { zh: "通道混合器",     en: "Channel Mixer",        cat: "颜色校正",   plugin: "内置", col: 7, row: 1, frames: 6 },
  { zh: "波形变形",       en: "Wave Warp",            cat: "扭曲",       plugin: "内置", col: 4, row: 2, frames: 6 },
  { zh: "查找边缘",       en: "Find Edges",           cat: "风格化",     plugin: "内置", col: 0, row: 4, frames: 6 },
  { zh: "CC 胶片灼烧",    en: "CC Burn Film",         cat: "风格化",     plugin: "内置", col: 3, row: 4, frames: 6 },
  { zh: "颜色差值键",     en: "Color Difference Key", cat: "抠像",       plugin: "内置", col: 2, row: 5, frames: 6 },
  { zh: "卡通",           en: "Cartoonify",           cat: "风格化",     plugin: "内置", col: 4, row: 6, frames: 6 },
  { zh: "光圈擦除",       en: "Iris Wipe",            cat: "过渡",       plugin: "内置", col: 7, row: 7, frames: 6 },
  { zh: "旋转扭曲",       en: "Twirl",                cat: "扭曲",       plugin: "内置", col: 7, row: 2, frames: 6 }
];
