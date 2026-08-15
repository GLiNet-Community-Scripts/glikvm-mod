# glikvm-mod

Patches for the **GLKVM Windows desktop client** (GL-iNet's Electron app for the Comet / RM1 / RM10 KVMs, `C:\Program Files\GLKVM`, tested with 1.5.0). It shows up in the app as **ui-mod 0.1.1**.

## What it adds

| Feature | How |
|---|---|
| **Sessions in separate windows** | `Shift`+click a device to open it in its own window · right-click a session tab → *Move to its own window* / *Move back to the main session window* · setting *Open sessions in: Tabs / A separate window per session* |
| **"+" new session button** | at the end of the tab strip, like a browser's new-tab button: lists sessions you opened before (last 12, remembered across restarts) and your local-access devices, or *Choose from device list...* which raises the home window and routes the next device you click into that session window as a new tab (with *A separate window per session* set, "+" opens a new window instead) |
| **Paste local clipboard into the remote machine** | `Ctrl+Alt+V` while a session window is focused (hotkey configurable) · or right-click a tab → *Paste local clipboard into "..."* · optional *Slow* paste speed for targets that drop characters |
| **1:1 resize to KVM resolution** | button next to the fullscreen button in the session toolbar (rounded square with diagonal arrows), or tab right-click menu → *Resize window to KVM resolution*: sizes the window so the remote screen is shown pixel-for-pixel · setting *Always open sessions at 1:1 (KVM resolution)* does it automatically as soon as a session shows video |
| **Start screen** | choose whether the app opens on Remote Access or Local Access; Back from Settings returns to whichever access page you were on (stock always went to Remote Access) |
| Window titles = device name | detached windows (and the main session window, for its active tab) are titled `<device> - GLKVM`, so Alt-Tab and the taskbar are usable |
| New windows inherit geometry | a moved or Shift-clicked session opens at the same size (and maximized state) as the window it came from, offset by 40 px so both stay visible |
| Takeover dialog | starting the mod while the stock client is running (for example in the tray) asks whether to close it and take over, instead of silently handing off to the stock window |
| Visible mod stamp | home footer shows `V1.5.0 release1 · ui-mod 0.1.1`; the About page shows *ui-mod 0.1.1 installed* with a link to this repo; the tab menu footer opens it too (the version used by the update check is untouched) |
| **Settings UI** | Settings → General → *Sessions (ui-mod)*: start screen, open mode, paste hotkey (click, then press the keys), paste speed, always 1:1 |

Everything is applied to a **side-by-side copy** in `%LOCALAPPDATA%\Programs\GLKVM-mod`: the stock install is never touched, no admin rights are needed, and uninstalling is one command. Login, device list and settings are shared with the stock client (same `%APPDATA%\gl-kvm`), so it is a drop-in replacement. Only one of the two can run at a time; if the stock client is still running when you start the mod, the mod asks whether to close it and take over.

## Requirements

* Windows 10/11 with the stock GLKVM desktop client installed (default `C:\Program Files\GLKVM`, tested with 1.5.0). Download it from the GL-iNet app page: https://www.gl-inet.com/en-de/pages/app-rm
* [Bun](https://bun.sh) 1.x (the JavaScript runtime that runs the patch script; Node.js is not needed). Install it with `powershell -c "irm bun.sh/install.ps1 | iex"` (or `winget install Oven-sh.Bun`, or `npm i -g bun`), then open a new terminal so `bun` is on your PATH.
* No admin rights: the default install writes only to `%LOCALAPPDATA%\Programs\GLKVM-mod` and your Start Menu.

## Install

```powershell
git clone https://github.com/emaspa/glikvm-mod.git
cd glikvm-mod
bun install
bun patch.ts install        # build + install side-by-side copy + Start Menu entry "GLKVM (mod)"
bun patch.ts run            # launch it (or use the Start Menu entry)
bun patch.ts status         # what is installed, and whether the stock client changed underneath
bun patch.ts uninstall      # remove the copy + shortcut
```

Other forms: `bun patch.ts build` (only produce `build/app`), `bun patch.ts install --inplace` (write `resources\app` into the stock install; Electron prefers that dir over `app.asar`; needs an elevated shell; `uninstall --inplace` reverts), `--src <dir>` / `--dest <dir>` to override locations.

**After GLKVM updates itself**, run `bun patch.ts install` again; `status` warns when the stock `app.asar` no longer matches what the mod was built from. Every patch is anchored on unique snippets of the stock code and aborts loudly if an anchor moved, so an update can't produce a silently half-patched app. **After re-installing the mod**, quit and restart "GLKVM (mod)" to pick up the new files.

## Using it

* **Session tab right-click menu**: move to its own window / back to the main window, paste local clipboard, resize to KVM resolution, and the checkboxes *Always open sessions in a new window*, *Slow paste*, *Always open sessions at 1:1*; the last entry opens this repo.
* **"+" at the end of the tab strip**: remembered sessions, local-access devices, *Choose from device list...*.
* **Toolbar button next to fullscreen** (inside the KVM page): resize the window to the KVM resolution. If the resolution doesn't fit on the screen the window takes the largest same-aspect size and tells you.
* **Ctrl+Alt+V** (default): types your local clipboard into the remote machine. Failures (empty clipboard, device refused, no session focused) show as Windows notifications.

## Settings

All in Settings → General → *Sessions (ui-mod)*; they live in the client's own settings file `%APPDATA%\gl-kvm\GLKVM.json`:

| key | default | meaning |
|---|---|---|
| `startScreen` | `"remote"` | `"local"` = open on the Local Access page instead of Remote Access |
| `remoteOpenMode` | `"tab"` | `"window"` = every device opens in its own window (Shift+click is then irrelevant) |
| `remotePasteHotkey` | `"Ctrl+Alt+V"` | accelerator-style, e.g. `"Ctrl+Shift+V"`, `"CmdOrCtrl+Alt+P"`, `"F9"` (set it from the UI by clicking the current value and pressing the keys) |
| `remotePasteSlow` | `false` | send `slow=1` to the device (longer inter-key delay) |
| `remoteFitOnOpen` | `false` | always open sessions at 1:1: resize the window to the KVM resolution as soon as a session shows video |
| `recentSessions` | `[]` | last 12 sessions, used by the "+" menu (managed automatically) |

## What the client actually is (why these were the patchable bits)

The desktop client is a thin **Electron 34** wrapper (unminified `app.asar`, ASAR-integrity fuse off, `nodeIntegration: true`). The main process keeps **one** singleton "remote" `BrowserWindow`; opening any device just IPCs `openRemotePage` to that window, whose Vue renderer adds an antd tab containing an `<iframe src="https://<device>">`, i.e. the device's own web UI, exactly what you'd get in a browser. There is no clipboard logic in the client at all; "Paste" lives inside the device UI and is implemented (as on PiKVM, whose `kvmd` GL-iNet forked: [gl-inet/glkvm](https://github.com/gl-inet/glkvm)) by *typing* the text over USB HID via `POST /api/hid/print`.

So the mod:

* replaces the singleton with a small window manager (`src/inject/main-remote-windows.js`): tab window + N detached windows, a device→window map (re-opening a device focuses wherever it already lives), per-window webterm cleanup, session hooks registered once instead of per-window, geometry inheritance, the "+" menu and the takeover dialog;
* intercepts the paste hotkey with `webContents.on("before-input-event")` in the main process (fires *before* the iframe's keyboard capture sees it), reads `clipboard.readText()`, and `POST`s it to `<device origin>/api/hid/print?limit=0` through the window's session (so the client's `auth_token` cookie and self-signed-cert allowance apply);
* measures the `<video>` inside the device UI's frame with `webFrameMain.executeJavaScript` (main process, so cross-origin is fine) to size the window for a 1:1 picture, and injects the resize button into the device UI's toolbar the same way (it posts a message to the wrapper, which asks the main process to resize);
* adds a `data-gl-device-id` to each tab, a `contextmenu` hook and the "+" button in the session renderer, a settings section and About/version stamps in the home renderer, a one-shot router guard for the start screen, and a handful of tiny IPC helpers in the preload (`window.utils.glMoveDevice(deviceId, "window"|"tab")` is also callable from devtools/CDP for scripting).

Files: `patch.ts` (CLI), `src/patches.ts` (anchored replacements), `src/inject/main-remote-windows.js` (new main-process code), `src/inject/home-settings.js` (settings section).

This repository contains only the patch tooling and the injected code; no GL-iNet binaries or bundles are redistributed, the tool reads your locally installed client. Not affiliated with GL-iNet.

## Limits / honest notes

* **Paste = keystrokes.** Same physics as the built-in clipboard: text only, the target's keyboard layout must match kvmd's keymap (en-US unless you changed it on the device), typing takes time, don't switch focus on the target while it types. Speed control is what upstream issue [#112](https://github.com/gl-inet/glkvm/issues/112) asks for; the mod exposes kvmd's existing `slow` flag.
* **Remote → local clipboard is not possible** with a HID-only KVM. PiKVM does it with OCR (Tesseract) on the video frame; GL-iNet declined it for quality reasons. An agent on the target (or `ssh`) is the only real answer.
* Auth for paste relies on the client having logged into that device UI once (it stores the token and sets the cookie). If a device replies 401 you'll get a notification saying so: log in inside the session, then retry.
* Ctrl+Alt+V was chosen so Ctrl+Shift+V still reaches remote terminals. AltGr+V on layouts where that types a character will be swallowed; change the hotkey in that case.
* The 1:1 size is computed in CSS pixels; on a display scaled above 100% the picture is 1:1 in CSS pixels, not device pixels.
* Cloud sessions in the "+" menu reuse the relay URL they were opened with; if it has expired the session shows the usual access-denied page and you can reopen the device from the home window.
* Tested against client 1.5.0 / Electron 34.5.8 on Windows 11 with an RM10 on firmware V1.10.0.

## License

MIT, see [LICENSE](LICENSE).
