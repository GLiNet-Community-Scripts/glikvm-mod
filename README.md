# glikvm-mod

Patches for the **GLKVM Windows desktop client** (`C:\Program Files\GLKVM`, v1.5.0) that add:

| Feature | How |
|---|---|
| **Sessions in separate windows** | `Shift`+click a device to open it in its own window · right-click a session tab → *Move to its own window* / *Move back to the main session window* · tab menu checkbox *Always open sessions in a new window* |
| **Paste local clipboard straight into the remote machine** | `Ctrl+Alt+V` while a session window is focused (configurable) · or right-click a tab → *Paste local clipboard into "…"* · optional *Slow paste* for flaky targets |
| Window titles = device name | detached windows (and the main session window, for its active tab) are titled `<device> - GLKVM`, so Alt-Tab / taskbar are usable |
| New windows inherit geometry | a moved/Shift-clicked session opens at the same size (and maximized state) as the window it came from, offset by 40 px so both stay visible |
| Visible mod stamp | home footer shows `V1.5.0 release1 · ui-mod 0.1.0`, the About page shows *ui-mod installed* with a link here (the version used by the update check is untouched) |
| **Settings UI** | Settings → General → *Sessions (ui-mod)*: open mode, paste hotkey (click, press keys), paste speed |

Everything is applied to a **side-by-side copy** in `%LOCALAPPDATA%\Programs\GLKVM-mod` - the stock install is never touched, no admin rights needed, and uninstalling is one command. Login, device list and settings are shared with the stock client (same `%APPDATA%\gl-kvm`), so it is a drop-in replacement; just quit the stock client first (only one instance can run at a time - a second one hands off to the first).

```powershell
bun install
bun patch.ts install        # build + install side-by-side copy + Start Menu entry "GLKVM (mod)"
bun patch.ts run            # launch it
bun patch.ts status         # what is installed, and whether the stock client changed underneath
bun patch.ts uninstall      # remove the copy + shortcut
```

Other forms: `bun patch.ts build` (only produce `build/app`), `bun patch.ts install --inplace` (write `resources\app` into the stock install - Electron prefers that dir over `app.asar`; needs an elevated shell), `--src <dir>` / `--dest <dir>` to override locations.

**After GLKVM updates itself**, run `bun patch.ts install` again - `status` warns when the stock `app.asar` no longer matches what the mod was built from. Every patch is anchored on unique snippets of the stock code and aborts loudly if an anchor moved, so an update can't produce a silently half-patched app.

## Settings

All three are in Settings → General → *Sessions (ui-mod)* (and the first two also in the tab right-click menu). They live in the client's own settings file `%APPDATA%\gl-kvm\GLKVM.json`:

| key | default | meaning |
|---|---|---|
| `remoteOpenMode` | `"tab"` | `"window"` = every device opens in its own window (Shift+click is then irrelevant) |
| `remotePasteSlow` | `false` | send `slow=1` to the device (longer inter-key delay) |
| `remotePasteHotkey` | `"Ctrl+Alt+V"` | accelerator-style, e.g. `"Ctrl+Shift+V"`, `"CmdOrCtrl+Alt+P"`, `"F9"` |

## What the client actually is (why these were the patchable bits)

The desktop client is a thin **Electron 34** wrapper (unminified `app.asar`, ASAR-integrity fuse off, `nodeIntegration: true`). The main process keeps **one** singleton "remote" `BrowserWindow`; opening any device just IPCs `openRemotePage` to that window, whose Vue renderer adds an antd tab containing an `<iframe src="https://<device>">` - i.e. the device's own web UI, exactly what you'd get in a browser. There is no clipboard logic in the client at all; "Paste" lives inside the device UI and is implemented (as on PiKVM, whose `kvmd` GL-iNet forked - [gl-inet/glkvm](https://github.com/gl-inet/glkvm)) by *typing* the text over USB HID via `POST /api/hid/print`.

So the mod:

* replaces the singleton with a small window manager (`src/inject/main-remote-windows.js`): tab window + N detached windows, a device→window map (re-opening a device focuses wherever it already lives), per-window webterm cleanup, session hooks registered once instead of per-window;
* intercepts the hotkey with `webContents.on("before-input-event")` in the main process (fires *before* the iframe's keyboard capture sees it), reads `clipboard.readText()`, and `POST`s it to `<device origin>/api/hid/print?limit=0` through the window's session (so the client's `auth_token` cookie and self-signed-cert allowance apply). Errors surface as Windows notifications;
* adds a `data-gl-device-id` to each tab + a `contextmenu` hook in the renderer, and a handful of tiny IPC helpers in the preload (`window.utils.glMoveDevice(deviceId, "window"|"tab")` is also callable from devtools/CDP for scripting).

Files: `patch.ts` (CLI), `src/patches.ts` (anchored replacements), `src/inject/main-remote-windows.js` (new main-process code), `src/inject/home-settings.js` (settings section).

This repository contains only the patch tooling and the injected code - no GL-iNet binaries or bundles are redistributed; the tool reads your locally installed client. Not affiliated with GL-iNet.

## Limits / honest notes

* **Paste = keystrokes.** Same physics as the built-in clipboard: text only, the target's keyboard layout must match kvmd's keymap (en-US unless you changed it on the device), typing takes time, don't switch focus on the target while it types. Speed control is what upstream issue [#112](https://github.com/gl-inet/glkvm/issues/112) asks for; the mod exposes kvmd's existing `slow` flag.
* **Remote → local clipboard is not possible** with a HID-only KVM. PiKVM does it with OCR (Tesseract) on the video frame; GL-iNet declined it for quality reasons. An agent on the target (or `ssh`) is the only real answer.
* Auth for paste relies on the client having logged into that device UI once (it stores the token and sets the cookie). If a device replies 401 you'll get a notification saying so - log in inside the session, then retry.
* Ctrl+Alt+V was chosen so Ctrl+Shift+V still reaches remote terminals. AltGr+V on layouts where that types a character will be swallowed - change `remotePasteHotkey` in that case.
* Tested against client 1.5.0 / Electron 34.5.8 on Windows 11 with an RM10 on firmware V1.10.0 (window management verified interactively; hotkey path verified to the network layer against a dead address, and `/api/hid/print` confirmed present on the device - do one real paste to confirm auth on your firmware).
