# MathStudio — a visual IDE for ManimGL

Drag mobjects onto a live preview, arrange them on a video-editor timeline, and export with
`manimgl`. Everything you do is turned into a real ManimGL script, which you can see and
edit.

## Download

* **Windows** (x64): [MathStudio-Setup.exe](https://github.com/LucaM185/mathstudio/releases/latest/download/MathStudio-Setup.exe)
  — installs for your user, no admin rights. It isn't code-signed yet, so SmartScreen may say
  "Windows protected your PC": *More info → Run anyway*.
* **Mac** (Apple Silicon): [MathStudio-arm64.dmg](https://github.com/LucaM185/mathstudio/releases/latest/download/MathStudio-arm64.dmg)
  — signed and notarized; drag it to Applications.
* **Linux** (x86_64): [AppImage](https://github.com/LucaM185/mathstudio/releases/latest/download/MathStudio-x86_64.AppImage)
  · [.deb](https://github.com/LucaM185/mathstudio/releases/latest/download/MathStudio-amd64.deb)

[All releases](https://github.com/LucaM185/mathstudio/releases). Windows, Mac and AppImage installs
update themselves (Settings → Updates); the .deb tells you when a new version is out.

## Run from source

```bash
./setup.sh              # once: Python venv with manimgl, npm install, build
./MathStudio.command    # or: npm start
```

Requirements: macOS, Node 18+, Python 3.10+ (uv is used if available), ffmpeg, and a LaTeX install
for `Tex` mobjects.

> If you launch from a VS Code / Cursor terminal, `ELECTRON_RUN_AS_NODE` is set there; the
> scripts above unset it. Plain `npx electron .` from those terminals will not open a window.

## Settings

**Settings** (the gear icon at the top right, or ⌘, / Ctrl+,) holds:

* **OpenRouter API key** for the AI agent: paste it, *Test* checks it against OpenRouter (free).
  Stored owner-only in `settings.json` in the app's user-data folder
  (`~/Library/Application Support/MathStudio`, `~/.config/MathStudio` on Linux). A key typed there
  wins over `OPENROUTER_KEY` in the environment or a `.env` file.
* **Preview quality**: Auto / High / Balanced / Low cap the live preview resolution
  (1920 → 960 px). The panel shows which OpenGL renderer the engine got; Auto picks Low on a
  software renderer (Mesa llvmpipe, i.e. no usable GPU driver). Exports always use the Export
  dialog resolution.

## Linux build (x86_64)

```bash
npm run dist:linux   # → release/MathStudio-x86_64.AppImage, release/MathStudio-amd64.deb, release/latest-linux.yml
npm run test:linux   # installs the .deb in a clean Ubuntu 24.04 container and drives the real app
npm run test:linux-update  # the built AppImage updates itself to a newer build (after test:linux)
```

Built in an amd64 Docker container (works on Apple Silicon through emulation). The packages carry
a standalone Python 3.12 with ManimGL and the engine's packages, a static ffmpeg and the search
model, so nothing has to be installed on the target except OpenGL (any desktop has it). LaTeX is
not bundled: `Tex`/Equation mobjects need `sudo apt install texlive-latex-extra texlive-science dvisvgm`
(the app says so if it's missing). The developer `.env` is never packaged.

* `.deb`: `sudo apt install ./MathStudio-amd64.deb`, then start *MathStudio* from the menu.
* AppImage: `chmod +x MathStudio-x86_64.AppImage && ./MathStudio-x86_64.AppImage` (needs `libfuse2`, or run
  with `--appimage-extract-and-run`). It runs with Chromium's sandbox off, because AppImages can't
  ship the setuid helper and Ubuntu 24.04 blocks the namespace sandbox for them.

## Windows build (x64)

```bash
npm run dist:win   # on Windows (Git Bash): → release/MathStudio-Setup.exe (+ .blockmap), release/latest.yml
npm run test:win   # installs it silently and drives the installed app
```

Built and tested on GitHub's `windows-latest` runner by the release workflow (there is no Docker
route like Linux's). Same bundle as Linux — Python 3.12 with the pinned engine packages
(`packaging/linux/constraints.txt`), static ffmpeg, the search model — plus the VC++ runtime DLLs
and Mesa's software OpenGL (llvmpipe): when a PC has no OpenGL 3.3 driver (VMs, remote desktop)
the engine says so and is restarted on Mesa automatically (`MATHSTUDIO_SOFTWARE_GL=1` forces it).
The runners have no GPU, so CI exercises exactly that path. LaTeX: install MiKTeX. Not code-signed
(no certificate), so the installer shows SmartScreen's unknown-publisher warning.

## Mac release (Apple Silicon)

```bash
npm run install:mac   # this Mac's own build (incl. the non-commercial library) → /Applications
npm run release:mac   # public build, notarized → dmg + update zip, uploaded to the current tag's release
```

`packaging/mac/build.sh --release` signs with the Developer ID certificate in the keychain and
notarizes with a `notarytool` keychain profile (`MS_NOTARY_PROFILE`, default `feather`;
`xcrun notarytool store-credentials <name>` creates one), so no Apple credentials live in the repo
or on GitHub. Notarizing/stapling runs in a temp folder because `stapler` can't write under
~/Desktop. Local builds with the non-commercial library are marked, so their updater only links to
the download page instead of replacing them with the public build. `tests/mac_update.mjs` updates a
release build to a newer one through Squirrel (see the file for the two builds it needs).

## How it works

```
Electron + React UI ──HTTP──► engine/server.py (ManimGL, OpenGL offscreen)
        │                          │
        │ project JSON             ├─ codegen.py      project → ManimGL code
        │                          ├─ library.py      mobject templates (${param} placeholders)
        │                          └─ studio_runtime.py  timeline evaluated at any time t
        ▼
   export: manimgl scene.py MainScene -w   (same code + same runtime ⇒ identical frames)
```

* **Library** (left): ~45 pre-made mobjects with animated previews on hover. Drag them onto the
  preview (sets position) or the timeline (sets time + track). Drop images/SVGs from Finder.
* **Mathstudio library** (second tab of the Library): every file of `engine/mathstudio_library/`
  (copied from `mathstudio library/`), indexed by `engine/library_imported.py`. Files under
  `non-commercial/` and `manim-assets/manimgl/3b1b-videos/` are CC BY-NC-SA 4.0 (non-commercial only)
  and are drawn with a red overlay labelled NON-COMMERCIAL. Images and SVGs can be double-clicked to add
  them to the project; Python modules and videos are reference material (double-click copies the path).
* **Preview**: drag to move, corners to scale, top handle to rotate. `⇧` constrains,
  `⌘` bypasses snapping. Every change re-renders immediately (~5–15 ms per frame).
* **Timeline**: the vertical order of tracks is the z-order; the top track is in front. Drag clips
  (time and track), trim the edges, drag the shaded enter/exit regions, move the keyframe ◆ and effect bars.
  The **Camera** row holds pan/zoom keyframes.
* **Inspector**: parameters, transform with keyframes, enter/exit animations (including
  *Transform Into* / *Transform Matching Parts* between clips), effects, and a **Code** tab to
  edit any clip as raw ManimGL code. Code can depend on `t` / `a` to animate every frame.
* **Code panel** (`</> Code`): the complete generated `scene.py`.
* **Export**: MP4, MOV (transparent) or GIF at up to 4K, via the `manimgl` CLI. *Save as
  ManimGL project* writes `scene.py` + `studio_runtime.py` + assets so you can keep going by hand.

* **AI Agent**: before every message the project is committed to a private git repo
  (`~/Library/Application Support/mathstudio/checkpoints`). The ↺ button next to a message restores
  the project to that commit and rewinds the chat (the message goes back in the input; ⌘Z undoes
  the restore). `git log -p` there shows every turn as `Before:` / `Agent:` commits.

### 3D and CAD-style navigation

The **3D** library category has 3D axes, surface plots z = f(x, y), parametric surfaces, solids
(sphere, cube, box, cylinder, cone, torus, dodecahedron), space curves and 3D vectors. Dropping the
first one tilts the camera to ManimGL's usual 3D view (⌘Z undoes just the tilt).

* **Orbit**: right-drag, middle-drag or ⌥-drag · **Pan**: ⇧ + right-drag (or drag, with the camera
  selected) · **Zoom**: scroll / pinch, towards the pointer · **F** zoom to fit (selection or all).
* **View cube** (top right): click a face, edge or corner to look from there, drag it to orbit; ⌂ goes
  back to the flat 2D view. Keys `7` top, `1` front, `3` right, `5` the ManimGL 3D view (⌃ = opposite side).
* With nothing or a clip selected, navigation moves a free **editor view** (purple badge, ground grid,
  the camera's frame drawn in blue) that is never exported. *Set camera here* copies it to the camera;
  `0` looks through the camera again. With the **Camera** selected, the same gestures keyframe the
  real camera (x / y / z, zoom, orbit θ, tilt φ, roll γ — `frame.reorient` angles).
* Clips have a **Z** position; dragging in a tilted view slides objects on the ground plane (on the
  vertical plane facing you when looking from the side). **Pin to screen** keeps titles flat on the
  video while the camera moves (`fix_in_frame`).

Shortcuts: `Space` play · `←/→` frame step (`⇧` 1 s) · `A` select tool · `B` blade tool (click a clip to cut it, `⇧`-click cuts all) · `⌘B` blade at playhead · `⇧⌘B` blade all · `K` keyframe · `⌘D` duplicate ·
`⌘C/⌘V` copy/paste · `⌫` delete · `⌘Z/⇧⌘Z` undo/redo · `⌘S` save · `⌘E` export · `⌘`+scroll zoom
the timeline.

## Releases and updates

```bash
npm run release              # patch bump (or: minor | major); --no-mac: release without Mac files,
                             # --no-install: don't reinstall this Mac's app, --dry: only check
```

`scripts/release.sh` checks (on main, clean tree, up to date, typecheck, signing certificate, gh
login), bumps the version, tags vX.Y.Z, pushes and creates the **draft** release; then builds the
Mac release files here (`release:mac`) and installs this Mac's own build in /Applications.

`.github/workflows/release.yml` builds the Linux packages (tested in a clean Ubuntu container,
including a real AppImage self-update) and the Windows installer (silently installed and driven on
Windows, including a real self-update), then uploads them to the draft. `scripts/release-upload.sh`
publishes the release once it has every platform's update feed (`latest-linux.yml`, `latest.yml`,
`latest-mac.yml`) — whichever upload comes last — so no updater ever sees a half-uploaded release.
If the Mac step fails (e.g. an expired Apple agreement), fix it and run `npm run release:mac`, or
publish without it: `scripts/release-upload.sh vX.Y.Z --publish`. *Run workflow* by hand does a
dry run (build + tests, no release; all platforms or just one). Files go to GitHub Releases only.

In the app, **Settings → Updates** checks that release feed (also in the background at launch and
every 6 h; can be turned off). Updates download only the changed blocks when they can, and the
project is saved first: an AppImage replaces itself, Windows runs the new installer silently, a Mac
release build is swapped by Squirrel (from the zip) — each then restarts. A .deb install (or a
local Mac build) gets a link to the download page. Running from source shows a `git pull` hint. The feed is the repo
in `package.json` → `repository`. `npm run test:updates` covers the panel against a fake server.

## Tests

```bash
npm run test:engine   # every mobject × every animation, scrubbing, keyframes, camera,
                      # error handling, perf, real manimgl exports compared pixel-wise with the preview
npm run test:e2e      # drives the Electron app with mouse/keyboard (drag & drop, handles,
                      # timeline editing, z-order, keyframes, code editing, camera, save, export)
npm run test:e2e3d   # 3D: overlay vs render alignment, orbit / pan / zoom, view cube, 3D moves, pinning
node tests/perf.mjs   # playback / drag frame rates
node tests/checkpoints.mjs  # agent git checkpoints + back button (mocked model, free)
npm run test:settings # Settings popup (gear icon): API key save/test/remove, preview quality caps (free)
```

## Notes

* ManimGL 1.7.2 has a few upstream bugs (`MarkupText`/`Code` call removed helpers,
  `FunctionGraph` ignores `color`, `--fps` is parsed as a string). `studio_runtime.py` patches the
  first, the templates avoid the second, and the export sets fps inside the scene.
* A render job that runs longer than 20 s (for example an endless loop in custom code) is
  aborted, and only that clip is marked as failed.

## License

MathStudio is free software, released under the [GNU Affero General Public License v3.0](LICENSE)
(AGPL-3.0-only). You can use, study, change and share it. If you distribute a modified version, or
run one as a service that people use over a network, you must publish its source code under the
same license.

Bundled third-party code and assets keep their own licenses: ManimGL and the example scenes under
`engine/mathstudio_library/manim-assets/` are MIT-licensed. Content under non-commercial licenses
(CC BY-NC-SA) is not part of this repository or its releases.
