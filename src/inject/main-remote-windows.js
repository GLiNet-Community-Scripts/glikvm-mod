let remoteWindow = null;
const REMOTE_DESKTOP_USER_AGENT = _isMacOS ? "MacDesktopApp" : "WinDesktopApp";
function appendUserAgentToken(userAgent, token) {
  const base = (userAgent || "").trim();
  if (!base) return token;
  if (base.includes(token)) return base;
  return `${base} ${token}`;
}
// ---------------------------------------------------------------------------
// glikvm-mod: multi-window sessions + direct clipboard paste
// (replaces the stock singleton `openRemoteWindow` / `closeRemoteWindow`)
// ---------------------------------------------------------------------------
const GL_MOD_VERSION = "__GL_MOD_VERSION__";
const GL_DEFAULT_PASTE_HOTKEY = "Ctrl+Alt+V";
const glRemoteWindows = new Set();
const glDeviceHost = new Map();
const glDeviceParams = new Map();
const glDeviceOrigins = new Set();
let glSessionHooksInstalled = false;
let glWindowSeq = 0;
let glPasteInFlight = false;
function glLog(...args) {
  logInfo("[glikvm-mod]", ...args);
}
function glWarn(...args) {
  logWarn("[glikvm-mod]", ...args);
}
function glOpenMode() {
  return store.get("remoteOpenMode") === "window" ? "window" : "tab";
}
function glPasteHotkey() {
  return store.get("remotePasteHotkey") || GL_DEFAULT_PASTE_HOTKEY;
}
function glOriginOf(channelIp) {
  try {
    return new URL(channelIp).origin;
  } catch {
    return null;
  }
}
function glFindRemoteWindowByWebContentsId(id) {
  for (const win of glRemoteWindows) {
    if (!win.isDestroyed() && win.webContents.id === id) return win;
  }
  return null;
}
function glNotify(body, title = "GLKVM") {
  glLog("notify:", body);
  try {
    new require$$0$2.Notification({ title, body, silent: true }).show();
  } catch (e) {
    glWarn("notification failed", String(e));
  }
}
function glInstallSessionHooks(ses) {
  ses.setCertificateVerifyProc((_2, callback) => {
    callback(0);
  });
  if (glSessionHooksInstalled) return;
  glSessionHooksInstalled = true;
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (glFindRemoteWindowByWebContentsId(details.webContentsId) && !details.url.startsWith("file://")) {
      const currentHeaderUserAgent = details.requestHeaders["User-Agent"] || details.requestHeaders["user-agent"] || "";
      details.requestHeaders["user-agent"] = appendUserAgentToken(String(currentHeaderUserAgent), REMOTE_DESKTOP_USER_AGENT);
    }
    callback({ requestHeaders: details.requestHeaders });
  });
  ses.webRequest.onBeforeRedirect((details) => {
    const { url, redirectURL, statusCode, method } = details;
    logInfo("[window] on before redirect: ", { url, redirectURL, statusCode, method });
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    const { statusCode, url } = details;
    const contentType = details.responseHeaders["Content-Type"] || details.responseHeaders["content-type"];
    const isTextHtml = contentType?.some((item) => item.includes("text/html"));
    const targetWindow = glFindRemoteWindowByWebContentsId(details.webContentsId);
    const urlMatchOrigin = [...glDeviceOrigins].some((origin) => url === origin + "/");
    const errorCodeAppeared = [401, 403].includes(statusCode) || statusCode === 404 && urlMatchOrigin;
    if (isTextHtml && errorCodeAppeared && !url.includes("/api/") && targetWindow) {
      logInfo("[window] remote control access denied and params is: ", { statusCode, url, contentType, isTextHtml, urlMatchOrigin, errorCodeAppeared });
      targetWindow.webContents.send("remoteAccessDenied", { url, statusCode });
    }
    const cookies2 = details.responseHeaders?.["Set-Cookie"] || details.responseHeaders?.["set-cookie"];
    if (cookies2) {
      details.responseHeaders["Set-Cookie"] = cookies2.map(
        (cookie) => cookie.replace("SameSite=Strict", "SameSite=None; Secure").replace("HttpOnly", "")
      );
    }
    callback({ responseHeaders: details.responseHeaders });
  });
}
function glGeometryFrom(win, offset) {
  try {
    if (!win || win.isDestroyed()) return null;
    const b = win.getNormalBounds();
    const geo = { width: b.width, height: b.height, maximized: win.isMaximized() };
    if (offset) {
      const area = require$$0$2.screen.getDisplayMatching(b).workArea;
      geo.x = Math.max(area.x, Math.min(b.x + offset, area.x + area.width - b.width));
      geo.y = Math.max(area.y, Math.min(b.y + offset, area.y + area.height - b.height));
    }
    return geo;
  } catch {
    return null;
  }
}
function glCreateRemoteWindow(kind, params, geometry) {
  setRemoteKeyBlockEnabled(false);
  const deviceId = params.device.id;
  const windowParams = kind === "window" ? { deviceId, n: String(++glWindowSeq) } : {};
  const geo = geometry || (kind === "window" ? glGeometryFrom(remoteWindow, 0) : null);
  glLog("create remote window", { kind, deviceId, mode: glOpenMode(), geo });
  const win = createWindow({
    windowName: "remote",
    params: windowParams,
    options: {
      show: false,
      width: geo?.width || 1280,
      height: geo?.height || 720,
      ...(geo && Number.isFinite(geo.x) ? { x: geo.x, y: geo.y } : {}),
      title: "Session Control"
    }
  });
  if (glRemoteWindows.has(win)) return win;
  win.__glKind = kind;
  win.__glDevices = new Set();
  win.__glReady = false;
  win.__glPending = [];
  win.__glCurrent = null;
  glRemoteWindows.add(win);
  if (kind === "tab") remoteWindow = win;
  win.webContents.setUserAgent(appendUserAgentToken(win.webContents.getUserAgent(), REMOTE_DESKTOP_USER_AGENT));
  glInstallSessionHooks(win.webContents.session);
  win.on("page-title-updated", (event) => event.preventDefault());
  win.on("closed", () => {
    glRemoteWindows.delete(win);
    for (const id of win.__glDevices) {
      if (glDeviceHost.get(id) === win) {
        glDeviceHost.delete(id);
        try {
          closeRemoteWebtermByDeviceId(id);
        } catch {
        }
      }
    }
    if (remoteWindow === win) remoteWindow = null;
    if (glRemoteWindows.size === 0) setRemoteKeyBlockEnabled(false);
    glLog("remote window closed", { kind, remaining: glRemoteWindows.size });
  });
  win.on("maximize", () => {
    store.set("remoteWindowMaximized", true);
  });
  win.on("unmaximize", () => {
    store.set("remoteWindowMaximized", false);
  });
  const defaultMaximized = geo ? !!geo.maximized : !!store.get("remoteWindowMaximized");
  if (defaultMaximized) {
    win.maximize();
  }
  win.once("ready-to-show", () => {
    win.__glReady = true;
    win.show();
    if (defaultMaximized) {
      win.webContents.send("maximize");
    }
    for (const pending of win.__glPending) win.webContents.send("openRemotePage", pending);
    win.__glPending = [];
  });
  win.webContents.on("before-input-event", (event, input) => glOnRemoteInput(win, event, input));
  return win;
}
function glDeliverOpenRemotePage(win, params) {
  const id = params.device.id;
  win.__glDevices.add(id);
  glDeviceHost.set(id, win);
  glDeviceParams.set(id, params);
  const origin = glOriginOf(params.channelIp);
  if (origin) glDeviceOrigins.add(origin);
  if (win.__glReady) {
    win.webContents.send("openRemotePage", params);
  } else {
    win.__glPending.push(params);
  }
}
function openRemoteWindow(rawParams, opts = {}) {
  const params = { ...rawParams };
  const forcedTarget = opts.target || (params.glNewWindow ? "window" : null);
  delete params.glNewWindow;
  const id = params?.device?.id;
  if (!id) {
    glWarn("openRemoteWindow called without device id");
    return null;
  }
  const host = glDeviceHost.get(id);
  if (host && !host.isDestroyed()) {
    glLog("device already open, focusing its window", id);
    if (host.isMinimized()) host.restore();
    host.show();
    host.focus();
    glDeliverOpenRemotePage(host, params);
    return host;
  }
  const target = forcedTarget || glOpenMode();
  let win;
  if (target === "window") {
    win = glCreateRemoteWindow("window", params, opts.geometry);
  } else if (remoteWindow && !remoteWindow.isDestroyed()) {
    win = remoteWindow;
  } else {
    win = glCreateRemoteWindow("tab", params, opts.geometry);
  }
  glDeliverOpenRemotePage(win, params);
  return win;
}
async function closeRemoteWindow() {
  const wins = getWindowsByName("remote");
  logInfo("[window] close remote window(s): " + wins.length);
  wins.forEach((win) => {
    try {
      win.close();
    } catch {
    }
  });
}
function glMoveDevice(deviceId, target) {
  const params = glDeviceParams.get(deviceId);
  if (!params) {
    glWarn("move: unknown device", deviceId);
    return;
  }
  const host = glDeviceHost.get(deviceId);
  let geometry = null;
  if (host && !host.isDestroyed()) {
    const lastTab = host.__glDevices.size <= 1;
    geometry = glGeometryFrom(host, lastTab ? 0 : 40);
    host.__glDevices.delete(deviceId);
    glDeviceHost.delete(deviceId);
    host.webContents.send("glDetachTab", deviceId);
  }
  glLog("move device", { deviceId, target, geometry });
  openRemoteWindow(params, { target, geometry });
}
function glOnTabClosed(event, deviceId) {
  const win = require$$0$2.BrowserWindow.fromWebContents(event.sender);
  if (!win || !glRemoteWindows.has(win)) return;
  if (glDeviceHost.get(deviceId) === win) {
    glDeviceHost.delete(deviceId);
    win.__glDevices.delete(deviceId);
  }
}
function glSetCurrentDevice(event, cfg) {
  const win = require$$0$2.BrowserWindow.fromWebContents(event.sender);
  if (!win || !glRemoteWindows.has(win)) return;
  win.__glCurrent = cfg || null;
  const name = cfg?.device?.deviceName;
  try {
    win.setTitle(name ? `${name} - GLKVM` : "Session Control");
  } catch {
  }
}
function glParseHotkey(spec) {
  const parts = String(spec || "").split("+").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const hk = { control: false, alt: false, shift: false, meta: false, key: "" };
  for (const p of parts) {
    if (p === "ctrl" || p === "control") hk.control = true;
    else if (p === "alt" || p === "option") hk.alt = true;
    else if (p === "shift") hk.shift = true;
    else if (p === "meta" || p === "cmd" || p === "command" || p === "super" || p === "win") hk.meta = true;
    else if (p === "cmdorctrl" || p === "commandorcontrol") {
      if (_isMacOS) hk.meta = true;
      else hk.control = true;
    } else hk.key = p;
  }
  return hk.key ? hk : null;
}
function glMatchHotkey(input, hk) {
  if (!hk) return false;
  const key = String(input.key || "").toLowerCase();
  const code = String(input.code || "").toLowerCase();
  const keyMatch = key === hk.key || code === hk.key || code === "key" + hk.key || code === "digit" + hk.key;
  return keyMatch && !!input.control === hk.control && !!input.alt === hk.alt && !!input.shift === hk.shift && !!input.meta === hk.meta;
}
function glOnRemoteInput(win, event, input) {
  if (input.type !== "keyDown" || input.isAutoRepeat) return;
  if (glMatchHotkey(input, glParseHotkey(glPasteHotkey()))) {
    event.preventDefault();
    glPasteClipboardToRemote(win);
  }
}
function glResolvePasteTarget(win, deviceId) {
  if (deviceId) return glDeviceParams.get(deviceId) || null;
  if (win.__glCurrent?.channelIp) return win.__glCurrent;
  if (win.__glDevices?.size === 1) return glDeviceParams.get([...win.__glDevices][0]) || null;
  return null;
}
async function glPasteClipboardToRemote(win, deviceId) {
  const cfg = glResolvePasteTarget(win, deviceId);
  if (!cfg) {
    glNotify("Can't tell which session is active - click inside the session and try again.");
    return;
  }
  const text = require$$0$2.clipboard.readText();
  if (!text) {
    glNotify("Local clipboard is empty (only text can be pasted).");
    return;
  }
  if (glPasteInFlight) {
    glNotify("A previous paste is still being typed - wait for it to finish.");
    return;
  }
  const origin = glOriginOf(cfg.channelIp);
  if (!origin) {
    glNotify("Bad device URL: " + cfg.channelIp);
    return;
  }
  const slow = !!store.get("remotePasteSlow");
  const url = `${origin}/api/hid/print?limit=0${slow ? "&slow=1" : ""}`;
  const name = cfg.device?.deviceName || origin;
  glLog("paste", { chars: text.length, target: origin, slow });
  glPasteInFlight = true;
  const startedAt = Date.now();
  try {
    if (text.length > 400) glNotify(`Typing ${text.length} characters into "${name}"...`);
    const res = await win.webContents.session.fetch(url, {
      method: "POST",
      body: text,
      credentials: "include",
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
    if (res.status === 401 || res.status === 403) {
      glNotify(`"${name}" refused the paste (HTTP ${res.status}). Log in to the session first, then retry.`);
    } else if (!res.ok) {
      const body = await res.text().catch(() => "");
      glNotify(`Paste to "${name}" failed: HTTP ${res.status} ${body.slice(0, 120)}`);
    } else {
      glLog("paste done", { ms: Date.now() - startedAt });
    }
  } catch (e) {
    glWarn("paste error", String(e));
    glNotify(`Paste to "${name}" failed: ${e?.message || e}`);
  } finally {
    glPasteInFlight = false;
  }
}
function glShowTabMenu(event, payload) {
  const win = require$$0$2.BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const { deviceId, tabCount } = payload || {};
  const params = glDeviceParams.get(deviceId);
  const name = params?.device?.deviceName || deviceId;
  const kind = win.__glKind || "tab";
  const template = [
    {
      label: `Move "${name}" to its own window`,
      enabled: kind === "tab" && tabCount > 1,
      click: () => glMoveDevice(deviceId, "window")
    },
    {
      label: `Move "${name}" back to the main session window`,
      enabled: kind === "window",
      click: () => glMoveDevice(deviceId, "tab")
    },
    { type: "separator" },
    {
      label: `Paste local clipboard into "${name}"  (${glPasteHotkey()})`,
      click: () => glPasteClipboardToRemote(win, deviceId)
    },
    { type: "separator" },
    {
      label: "Always open sessions in a new window",
      type: "checkbox",
      checked: glOpenMode() === "window",
      click: (item) => store.set("remoteOpenMode", item.checked ? "window" : "tab")
    },
    {
      label: "Slow paste (more reliable on flaky targets)",
      type: "checkbox",
      checked: !!store.get("remotePasteSlow"),
      click: (item) => store.set("remotePasteSlow", !!item.checked)
    },
    { type: "separator" },
    { label: `ui-mod ${GL_MOD_VERSION} - about / source`, click: () => require$$0$2.shell.openExternal("__GL_REPO_URL__") }
  ];
  require$$0$2.Menu.buildFromTemplate(template).popup({ window: win });
}
// --- single-instance conflict with the stock client -------------------------
// Both builds share %APPDATA%\gl-kvm, so only one can run. Stock behaviour is to
// hand off to whichever is running and quit silently, which makes launching the
// mod while the stock client sits in the tray look like "the mod is not patched".
function glListGlkvmProcesses() {
  try {
    const out = require$$0$3.execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='GLKVM.exe' or Name='win-key-blocker.exe'\" | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.ExecutablePath + '|' + $_.CommandLine }"
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15e3 }
    );
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [pid, exe, ...rest] = l.split("|");
      return { pid: Number(pid), exe: exe || "", cmd: rest.join("|") };
    });
  } catch (e) {
    glWarn("process list failed", String(e));
    return [];
  }
}
function glHandleInstanceConflict() {
  const app = require$$0$2.app;
  app.whenReady().then(() => {
    const me = process.execPath.toLowerCase();
    const procs = glListGlkvmProcesses();
    const foreignMains = procs.filter(
      (p) => p.pid !== process.pid && p.exe && /glkvm\.exe$/i.test(p.exe) && p.exe.toLowerCase() !== me && !/--type=/.test(p.cmd)
    );
    if (!foreignMains.length) {
      app.quit();
      return;
    }
    const otherDir = require$$2.dirname(foreignMains[0].exe);
    const choice = require$$0$2.dialog.showMessageBoxSync({
      type: "question",
      title: "GLKVM ui-mod",
      message: "Another GLKVM is already running",
      detail: `The GLKVM in\n${otherDir}\nis running (probably the stock client in the tray). Both share the same profile, so only one can run at a time.\n\nClose it and start GLKVM ui-mod instead? Sessions open in the other client will be closed.`,
      buttons: ["Close it and start ui-mod", "Cancel"],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (choice !== 0) {
      app.quit();
      return;
    }
    const otherDirLower = otherDir.toLowerCase();
    const victims = procs.filter((p) => p.pid !== process.pid && p.exe && require$$2.dirname(p.exe).toLowerCase() === otherDirLower);
    for (const v of victims) {
      try {
        process.kill(v.pid);
      } catch (e) {
        glWarn("could not stop process", v.pid, String(e));
      }
    }
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 1500);
  });
}
