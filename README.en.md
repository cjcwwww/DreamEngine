<p align="center">
  <img src="cep/com.dreamengine.panel/css/brand-mark.png" width="96" alt="DreamEngine logo">
</p>

<h1 align="center">DreamEngine</h1>

<p align="center">
  A unified After Effects workspace for effects, presets, curves, and media
</p>

<p align="center">
  English · <a href="README.md">中文</a>
</p>

> **Beta status:** DreamEngine currently targets Windows. The core workflows have been verified on After Effects 2021 / CEP 11. Later AE releases have not completed full validation.

## Download Beta

Current beta: **DreamEngine Hub 0.1.0 / Panel 0.2.0**

- [Download the Windows installer](https://github.com/yoanx/DreamEngine/releases/tag/v0.1.0-beta.1)
- The installer is unsigned, so Windows SmartScreen may show an "Unknown publisher" warning.
- Installing or upgrading only replaces application files. It does not overwrite generated previews or the user's preset library.

## Quick start

1. Save your project and close After Effects.
2. Run `DreamEngine-Hub-Setup-0.1.0.exe` and complete the installer.
3. Start AE and open `Window > Extensions > DreamEngine`.

The panel is ready to use after installation. DreamEngine Hub is mainly used for adding presets, rendering previews, and managing folders.

## Common actions

- **Effects:** double-click a card to add the effect to the selected layer.
- **Presets:** click a card to apply it; add new `.ffx` presets through DreamEngine Hub.
- **Materials:** click to preview; double-click to insert the media at the current composition time.
- **Favorites:** hover a card and click the star in the upper-right corner. Favorites can be combined with category filters.

## Features

### Effect browser

- Browse, search, and filter After Effects effects by plugin source.
- Hover to preview animated effects; static effects stay still.
- Double-click an effect or use `+` to add it to the selected layer.
- Favorite effects and combine favorites with the active category filter.

### Preset library

- Add `.ffx` presets through DreamEngine Hub using the file picker or drag and drop.
- View static, animated, and third-party plugin preset previews.
- Create custom categories, rename or delete them, and move presets between categories.
- Favorites are an independent filter and can be combined with categories.

### Curve editor

- Flow-style curve-template workflow.
- Value, speed, and spatial-path graphs.
- Drag handles to shape the curve and apply it to selected keyframe easing.
- Save, delete, and manage custom curve presets.

### Material library

- Register one root folder without copying, moving, or modifying source files.
- Automatically classify video, images, audio, and `.aep` projects.
- Click to select and preview: video plays for up to two seconds; audio can be toggled on and off.
- Double-click video, images, or audio to import them and place the layer at the current composition time.
- `.aep` files are imported into the project only; they are not opened or added as layers.
- Favorite materials and combine favorites with material categories.

## Requirements

- Windows 10 or Windows 11
- Adobe After Effects 2021 or later
- `ffmpeg` is recommended for audio waveforms and cached previews of some unsupported video formats

The first installation deploys the CEP panel and built-in preview library into the user profile. Administrator access is not required. Continue past SmartScreen only if you trust the download source.

## Usage notes

- Double-click an effect card to add the effect to the selected layer.
- A single click applies a preset. New presets must be added through DreamEngine Hub.
- Double-clicking media inserts a layer at the current composition time. If no composition is open, the media is only imported into the project.
- Offline previews for third-party plugin presets require AE to be closed. Hub launches a dedicated rendering process instead of rendering them inside the active AE session.

## User data

DreamEngine does not upload projects, media, or presets to the network.

- Presets, caches, and backgrounds: `Documents/DreamEngine/`
- Favorites and custom preset categories: local CEP `localStorage`
- Logs and probe data: `Documents/DreamEngineProbe/`

## Repository contents

```text
cep/com.dreamengine.panel/   CEP panel
hub/                         Electron manager
dist/L1/                     Built-in effect preview package
```

Development probes, internal test tooling, and progress notes are not included in the public repository. Installation and release artifacts are distributed through GitHub Releases.

## Known Beta limitations

- The installer is not code-signed.
- Full validation currently covers After Effects 2021 / CEP 11.
- Third-party plugin previews depend on the local plugin environment and may not match another machine.
- The material library supports one root folder and requires manual refresh after disk changes.
- `.aep` contents are not parsed or opened automatically.
