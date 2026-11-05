<h1 align="center">DreamEngine</h1>

<p align="center">
  A unified After Effects workspace for effects, presets, curves, and media
</p>

<p align="center">
  English · <a href="README.md">中文</a>
</p>

> **Beta status:** DreamEngine targets Windows. The main workflows are validated on After Effects 2021 / CEP 11. Later AE releases have not completed full validation.

## Download and install

Current release: **DreamEngine Hub 0.1.0 / CEP panel 0.2.0**

Download from [GitHub Releases](https://github.com/yoanx/DreamEngine/releases/tag/v0.1.0-beta.1):

- `DreamEngine-Hub-Setup-0.1.0.exe`
- `SHA256SUMS.txt`

Installation:

1. Save your After Effects project and quit AE.
2. Run the installer, choose an installation directory, and finish setup.
3. Start After Effects and open `Window > Extensions > DreamEngine`.

The installer is unsigned, so Windows SmartScreen may show an "Unknown publisher" warning. Upgrades replace application files and built-in preview resources without deleting user presets, categories, favorites, or generated previews.

## Quick start

### AE panel

| Page | Action |
| --- | --- |
| Effects | Search or filter; double-click to add an effect to the selected layer; hover to play animated previews |
| Presets | Click a card to apply an `.ffx` preset; filter by category and favorites |
| Curves | Shape a Bezier curve; apply it to selected keyframes; save custom presets |
| Media | Select one root folder; click to preview; double-click to import at the current composition time |

### DreamEngine Hub

Hub is a standalone manager that runs outside the active AE process:

- Add, rename, favorite, categorize, and long-press to delete `.ffx` presets.
- Render offline previews and animated frame sequences for plugin presets.
- Skip one preset from automatic rendering or re-render only that preset.
- Add custom preview backgrounds.
- Inspect panel installation, AE versions, directories, and render logs.

Preset categories, preset favorites, and skip-render state are shared between the panel and Hub.

## Features

### DreamEngine Hub

**Preset library**

- Import `.ffx` files through the file picker or drag and drop.
- Create, rename, and delete categories in the left sidebar.
- Favorites are an independent filter and can be combined with categories.
- Animated presets play while hovered; static previews show an orange dot in the upper-right corner.
- The context menu provides rename, favorite, skip-render, render-only, and move-to-category actions.
- Long-press a card to delete its `.ffx` file from the preset library.

**Offline preview rendering**

- Plugin presets render in dedicated AE instances to avoid destabilizing the active AE session.
- Each dedicated AE instance handles up to 40 presets by default to reduce repeated launches.
- Save and close AE before rendering. Hub can reopen AE when the job finishes.
- Built-in and custom preview backgrounds are supported.
- "Skip render" persistently excludes one preset without stopping other work.
- "Render only" processes one preset and forces a fresh render, bypassing existing previews and the failure blacklist.

**Settings and diagnostics**

- Inspect Hub, panel, and built-in preview versions.
- Detect installed AE versions and current AE status.
- Open the extension, preset, and log directories.

### AE panel

**Effects**

- Sort by name or category and filter by plugin source.
- Animated previews play on hover; static previews stay still.
- Double-click an effect or use its add button to apply it to the selected layer.
- Favorite effects and combine favorites with category filters.

**Presets**

- Browse imported presets and their previews.
- Click to apply a preset; long-press to delete a preset inside the library.
- Categories and favorites are shared bidirectionally with Hub.
- Animated presets play on hover; static presets show an orange dot.

**Curves**

- Value, speed, and spatial-path views.
- Drag control handles to shape easing and apply it to selected keyframes.
- Save custom curve presets; long-press to delete a preset, including built-ins.
- Detect keyframe changes before writing to avoid overwriting concurrent edits.

**Media**

- Register one media root without copying, moving, or modifying source files.
- Automatically classify video, images, audio, and `.aep` projects.
- Click video to preview up to two seconds.
- Audio displays a waveform and can be played or stopped with a click.
- Double-click video, images, or audio to import and place it at the current composition time.
- `.aep` files are imported as projects only; their contents are not parsed or added as media layers.
- Favorite media and combine favorites with category filters.

## Requirements

- Windows 10 or Windows 11
- After Effects 2021 (18.0) or later
- `ffmpeg` is recommended for audio waveforms and cached previews of some video formats

Without `ffmpeg`, core AE workflows still work, but some media previews may be blank.

## Screenshots

**After Effects panel**

![DreamEngine effects panel](assets/screenshots/ae-panel.png)

**DreamEngine Hub**

![DreamEngine Hub](assets/screenshots/hub.png)

## User data

DreamEngine does not upload projects, media, or presets.

| Path | Contents |
| --- | --- |
| `Documents/DreamEngine/presets/` | User `.ffx` presets |
| `Documents/DreamEngine/backgrounds/` | Custom preview backgrounds |
| `Documents/DreamEngine/preset_categories.json` | Preset categories, preset favorites, and skip-render state |
| `Documents/DreamEngine/materials/` | Media index, waveform, and video preview cache |
| `Documents/DreamEngineProbe/` | Hub render state and logs |
| `%APPDATA%/Adobe/CEP/extensions/com.dreamengine.panel/` | Installed panel and built-in preview indexes |

Effect favorites, media favorites, curve presets, and some panel preferences remain in the panel's local CEP `localStorage`.

Back up `Documents/DreamEngine/` before uninstalling if you need to keep presets and caches.

## Troubleshooting

**DreamEngine is missing from the AE menu**

1. Confirm the installer and AE run under the same Windows user.
2. Quit AE completely and start it again.
3. Check the panel installation state and extension directory on Hub's Settings page.

**A plugin preset will not render**

- Save and close every AE instance before starting a Hub render.
- Check Hub's render log and `Documents/DreamEngineProbe/`.
- Confirm the third-party plugins required by the preset are installed.

**Media previews are missing**

- Install `ffmpeg`, or put the absolute path to `ffmpeg.exe` in `Documents/DreamEngine/materials/ffmpeg.txt`.
- Return to the Media page and click Refresh.

## Repository layout

```text
cep/com.dreamengine.panel/   After Effects CEP panel
hub/                         Electron manager
dist/L1/                     Built-in effect preview resources
assets/screenshots/          README screenshots
```

Development probes, internal test tooling, and progress notes are not included in the public repository.

## Current limitations

- The installer is not code-signed.
- Full validation currently covers AE 2021 / CEP 11.
- Third-party plugin previews depend on the local plugin and licensing environment.
- The media library supports one root folder and requires a manual refresh after disk changes.
- `.aep` contents are not parsed, and project files are not opened automatically.
- Hub and the AE panel do not continuously poll the other process; each view reloads shared state when revisited.
