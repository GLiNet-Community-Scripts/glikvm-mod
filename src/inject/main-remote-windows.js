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
let glPendingHost = null;
const GL_RECENT_MAX = 12;
function glRecentSessions() {
  const list = store.get("recentSessions");
  return Array.isArray(list) ? list.filter((p) => p && p.device && p.device.id && p.channelIp) : [];
}
function glRememberSession(params) {
  try {
    const entry = {
      channelIp: params.channelIp,
      accessMode: params.accessMode,
      device: { id: params.device.id, deviceName: params.device.deviceName, version: params.device.version }
    };
    const rest = glRecentSessions().filter((p) => p.device.id !== entry.device.id);
    store.set("recentSessions", [entry, ...rest].slice(0, GL_RECENT_MAX));
  } catch (e) {
    glWarn("could not remember session", String(e));
  }
}
function glShowHomeWindow() {
  const home = getMainWindow();
  if (home && !home.isDestroyed()) {
    if (home.isMinimized()) home.restore();
    home.show();
    home.focus();
    return;
  }
  createWindow({ windowName: "home" });
}
function glDeviceLabel(p) {
  const name = p.device?.deviceName || p.device?.id;
  if (p.accessMode === "local") {
    const origin = glOriginOf(p.channelIp) || p.channelIp;
    return `${name}  (${String(origin).replace(/^https?:\/\//, "")})`;
  }
  return `${name}  (cloud)`;
}
// --- resize the window so the KVM video is shown 1:1 ---------------------------
function glFindDeviceFrame(win, cfg) {
  const origin = glOriginOf(cfg?.channelIp);
  if (!origin) return null;
  try {
    return win.webContents.mainFrame.framesInSubtree.find((f) => {
      try {
        return f !== win.webContents.mainFrame && new URL(f.url).origin === origin;
      } catch {
        return false;
      }
    }) || null;
  } catch {
    return null;
  }
}
// The device UI runs the stream in "fixed-scale" mode: the <video> stays at its native
// size inside a scrolling container, so it never letterboxes. We size the window so that
// scroll container becomes exactly the native video size. Chrome (header/footer/side panel)
// = iframe viewport minus that container. Runs entirely inside the device frame.
const GL_MEASURE = `(() => {
  const v = document.querySelector("video");
  if (!v || !v.videoWidth) return null;
  // nearest ancestor that actually clips/scrolls the video area (skip wrappers sized to the video)
  let vp = v.parentElement;
  while (vp && vp !== document.body) {
    const o = getComputedStyle(vp);
    if (/(auto|scroll|hidden|clip)/.test(o.overflow + o.overflowX + o.overflowY)) break;
    vp = vp.parentElement;
  }
  if (!vp || vp === document.body || vp === document.documentElement) vp = v.parentElement;
  const r = vp.getBoundingClientRect();
  const vw2 = Math.max(r.width, vp.clientWidth);
  const vh2 = Math.max(r.height, vp.clientHeight);
  return { vw: v.videoWidth, vh: v.videoHeight, vpw: Math.round(vw2), vph: Math.round(vh2), iw: window.innerWidth, ih: window.innerHeight };
})()`;
async function glMeasureVideo(win, cfg) {
  const frame = glFindDeviceFrame(win, cfg);
  if (!frame) return null;
  try {
    const m = await frame.executeJavaScript(GL_MEASURE, true);
    if (!m || m.iw < 50 || m.ih < 50 || m.vpw < 1 || m.vph < 1) return null;
    // chrome = the fixed device UI around the video area (header/footer/side panels)
    const cx = Math.max(0, m.iw - m.vpw);
    const cy = Math.max(0, m.ih - m.vph);
    if (cx > 1200 || cy > 800) {
      glWarn("chrome looks wrong", { cx, cy, m });
      return null;
    }
    return { vw: m.vw, vh: m.vh, iw: m.iw, ih: m.ih, cx, cy };
  } catch (e) {
    glWarn("measure failed", String(e));
    return null;
  }
}
async function glFitWindowToKvm(win, deviceId, quiet) {
  if (!win || win.isDestroyed()) return false;
  const cfg = glResolvePasteTarget(win, deviceId);
  if (!cfg) {
    if (!quiet) glNotify("Can't tell which session is active - click inside the session and try again.");
    return false;
  }
  // Chrome can only be read reliably while the window is smaller than the native video
  // (so the stream's scroll container fills the viewport instead of hugging the 1:1 content).
  let m = await glMeasureVideo(win, cfg);
  let [cw, ch] = win.getContentSize();
  const needShrink = !m || cw >= m.vw || ch >= m.vh;
  if (needShrink) {
    if (win.isMaximized()) win.unmaximize();
    if (win.isFullScreen()) win.setFullScreen(false);
    glSuppressMoves(win);
    win.setContentSize(Math.min(cw, 1000), Math.min(ch, 640));
    await new Promise((r) => setTimeout(r, 200));
    m = await glMeasureVideo(win, cfg);
    [cw, ch] = win.getContentSize();
  }
  if (!m) {
    if (!quiet) glNotify("No video stream yet in this session - try again once the remote screen is showing.");
    return false;
  }
  const wrapX = Math.max(0, cw - m.iw);
  const wrapY = Math.max(0, ch - m.ih);
  const chromeX = m.cx;
  const chromeY = m.cy;
  let targetW = Math.round(m.vw + chromeX + wrapX);
  let targetH = Math.round(m.vh + chromeY + wrapY);
  const bounds = win.getBounds();
  const area = require$$0$2.screen.getDisplayMatching(bounds).workArea;
  const frameW = bounds.width - cw;
  const frameH = bounds.height - ch;
  const maxW = area.width - frameW;
  const maxH = area.height - frameH;
  let fits = true;
  if (targetW > maxW || targetH > maxH) {
    fits = false;
    const scale = Math.min(maxW / targetW, maxH / targetH);
    targetW = Math.floor(targetW * scale);
    targetH = Math.floor(targetH * scale);
  }
  glLog("fit window to kvm", { device: cfg.device?.deviceName, video: `${m.vw}x${m.vh}`, chrome: { x: chromeX + wrapX, y: chromeY + wrapY }, target: `${targetW}x${targetH}`, fits });
  try {
    const sizes = Object.assign({}, store.get("remoteFitSizes") || {});
    sizes[cfg.device.id] = { width: targetW, height: targetH };
    store.set("remoteFitSizes", sizes);
  } catch {
  }
  if (win.isMaximized()) win.unmaximize();
  if (win.isFullScreen()) win.setFullScreen(false);
  glSuppressMoves(win);
  win.setContentSize(targetW, targetH);
  const nb = win.getBounds();
  const nx = Math.max(area.x, Math.min(nb.x, area.x + area.width - nb.width));
  const ny = Math.max(area.y, Math.min(nb.y, area.y + area.height - nb.height));
  if (nx !== nb.x || ny !== nb.y) win.setPosition(nx, ny);
  if (!quiet && !fits) glNotify(`${m.vw}x${m.vh} does not fit on this screen; the window was sized to the largest matching aspect ratio.`);
  return true;
}
// Adds a "1:1" item next to the fullscreen button inside the device UI (cross-origin
// iframe, so this runs from the main process via webFrameMain.executeJavaScript).
const GL_FIT_BUTTON_INJECT = `(() => {
  if (window.__glModFitInjected) return "already";
  window.__glModFitInjected = true;
  const ensure = () => {
    if (document.getElementById("gl-mod-fit")) return;
    const use = Array.from(document.querySelectorAll("use")).find((u) => (u.getAttribute("xlink:href") || u.getAttribute("href")) === "#gl-kvm-fullscreen");
    if (!use) return;
    const item = use.closest(".action-item");
    const wrap = item && item.parentElement;
    if (!wrap) return;
    const clone = wrap.cloneNode(true);
    clone.id = "gl-mod-fit";
    const span = clone.querySelector("span");
    if (span) {
      // SVG built in the SVG namespace; the original icon attributes are copied so the scoped .gl-icon CSS applies
      const NS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(NS, "svg");
      const orig = span.querySelector("svg");
      if (orig) for (const a of Array.from(orig.attributes)) svg.setAttribute(a.name, a.value); // keeps class + Vue scope attrs, so the scoped .gl-icon sizing applies
      svg.setAttribute("class", "gl-icon");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      svg.style.width = "1em";
      svg.style.height = "1em";
      // rounded square with two diagonal arrows (expand), thin strokes like the fullscreen glyph
      const shapes = [
        ["rect", { x: "3.25", y: "3.25", width: "17.5", height: "17.5", rx: "3.5" }],
        ["path", { d: "M12.8 11.2L17.4 6.6M13.4 6.6h4v4" }],
        ["path", { d: "M11.2 12.8L6.6 17.4M6.6 13.4v4h4" }]
      ];
      for (const [tag, attrs] of shapes) {
        const el = document.createElementNS(NS, tag);
        for (const k in attrs) el.setAttribute(k, attrs[k]);
        el.setAttribute("fill", "none");
        el.setAttribute("stroke", "currentColor");
        el.setAttribute("stroke-width", "1.5");
        el.setAttribute("stroke-linecap", "round");
        el.setAttribute("stroke-linejoin", "round");
        el.style.fill = "none";
        svg.appendChild(el);
      }
      span.textContent = "";
      span.appendChild(svg);
    }
    const btn = clone.querySelector(".action-item") || clone;
    btn.title = "Resize window to KVM resolution (1:1)";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.parent.postMessage(JSON.stringify({ glMod: "fit" }), "*");
    });
    wrap.insertAdjacentElement("afterend", clone);
  };
  ensure();
  new MutationObserver(() => ensure()).observe(document.documentElement, { childList: true, subtree: true });
  return "injected";
})()`;
function glInjectFitButton(frameProcessId, frameRoutingId) {
  try {
    const frame = require$$0$2.webFrameMain.fromId(frameProcessId, frameRoutingId);
    if (!frame) return;
    const origin = new URL(frame.url).origin;
    if (!glDeviceOrigins.has(origin)) return;
    frame.executeJavaScript(GL_FIT_BUTTON_INJECT, true).then((r) => glLog("fit button", r, origin)).catch((e) => glWarn("fit button inject failed", String(e)));
  } catch {
  }
}
function glScheduleFitOnOpen(win, deviceId) {
  if (!store.get("remoteFitOnOpen")) return;
  let tries = 0;
  const tick = async () => {
    if (win.isDestroyed()) return;
    if (glDeviceHost.get(deviceId) !== win) return;
    tries += 1;
    const cur = win.__glCurrent?.device?.id;
    if (cur && cur !== deviceId) return;
    const ok = await glFitWindowToKvm(win, deviceId, true);
    if (!ok && tries < 40) setTimeout(tick, 1000);
  };
  setTimeout(tick, 1500);
}
function glShowNewSessionMenu(event) {
  const win = require$$0$2.BrowserWindow.fromWebContents(event.sender);
  if (!win || !glRemoteWindows.has(win)) return;
  const open = new Set(win.__glDevices);
  const listed = new Set();
  const items = [];
  const recents = glRecentSessions();
  for (const p of recents) {
    if (open.has(p.device.id)) continue;
    listed.add(p.device.id);
    items.push({ label: glDeviceLabel(p), click: () => openRemoteWindow(p, { host: win }) });
  }
  const locals = store.get("localAccessDevices");
  const localItems = [];
  for (const d of Array.isArray(locals) ? locals : []) {
    if (!d || !d.id || !d.host || open.has(d.id) || listed.has(d.id)) continue;
    const raw = String(d.host).trim();
    const channelIp = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const params = { channelIp, accessMode: "local", device: { id: d.id, deviceName: d.name, version: d.version } };
    localItems.push({ label: glDeviceLabel(params), click: () => openRemoteWindow(params, { host: win }) });
  }
  if (items.length && localItems.length) items.push({ type: "separator" });
  items.push(...localItems);
  if (items.length) items.push({ type: "separator" });
  items.push({
    label: "Choose from device list...",
    click: () => {
      glPendingHost = { win, until: Date.now() + 90e3 };
      glShowHomeWindow();
    }
  });
  require$$0$2.Menu.buildFromTemplate(items).popup({ window: win });
}
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
  let geo = geometry || (kind === "window" ? glGeometryFrom(remoteWindow, 0) : null);
  if (store.get("remoteFitOnOpen")) {
    // always-1:1: start straight at the last known 1:1 size for this device (the fit corrects it if the resolution changed)
    const known = (store.get("remoteFitSizes") || {})[deviceId];
    if (known && known.width && known.height) geo = { ...(geo || {}), width: known.width, height: known.height, maximized: false };
  }
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
  win.on("move", () => {
    if (win.__glMoveTimer) clearTimeout(win.__glMoveTimer);
    win.__glMoveTimer = setTimeout(() => glOnWindowMoved(win), 260);
  });
  glSuppressMoves(win, 2e3);
  win.webContents.on("did-frame-finish-load", (_event, isMainFrame, frameProcessId, frameRoutingId) => {
    if (!isMainFrame) glInjectFitButton(frameProcessId, frameRoutingId);
  });
  return win;
}
function glDeliverOpenRemotePage(win, params) {
  const id = params.device.id;
  win.__glDevices.add(id);
  glDeviceHost.set(id, win);
  glDeviceParams.set(id, params);
  const origin = glOriginOf(params.channelIp);
  if (origin) glDeviceOrigins.add(origin);
  glRememberSession(params);
  if (win.__glReady) {
    win.webContents.send("openRemotePage", params);
  } else {
    win.__glPending.push(params);
  }
  glScheduleFitOnOpen(win, id);
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
  // "+" button flow: a specific session window asked for the next session
  let requested = opts.host || null;
  if (!requested && !forcedTarget && glPendingHost && glPendingHost.until > Date.now() && !glPendingHost.win.isDestroyed()) {
    requested = glPendingHost.win;
  }
  glPendingHost = null;
  if (requested && !requested.isDestroyed() && glRemoteWindows.has(requested) && !forcedTarget && glOpenMode() === "window") {
    // "+" pressed while "always open sessions in a new window" is on: honour the mode,
    // sized like the window the request came from
    glLog("opening in a new window (mode=window) for requesting window", id);
    const win2 = glCreateRemoteWindow("window", params, glGeometryFrom(requested, 40));
    glDeliverOpenRemotePage(win2, params);
    return win2;
  }
  if (requested && !requested.isDestroyed() && glRemoteWindows.has(requested)) {
    glLog("opening in requesting window", id);
    if (requested.isMinimized()) requested.restore();
    requested.show();
    requested.focus();
    glDeliverOpenRemotePage(requested, params);
    return requested;
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
// best existing session window to receive tabs (not `exclude`): the main tab window if
// alive, else the remote window holding the most sessions
function glTabTargetFor(exclude) {
  if (remoteWindow && !remoteWindow.isDestroyed() && remoteWindow !== exclude && glRemoteWindows.has(remoteWindow)) return remoteWindow;
  let best = null;
  for (const w of glRemoteWindows) {
    if (w === exclude || w.isDestroyed()) continue;
    if (!best || (w.__glDevices?.size || 0) > (best.__glDevices?.size || 0)) best = w;
  }
  return best;
}
function glDetachFromHost(host, deviceId) {
  if (!host || host.isDestroyed()) return;
  host.__glDevices.delete(deviceId);
  if (glDeviceHost.get(deviceId) === host) glDeviceHost.delete(deviceId);
  host.webContents.send("glDetachTab", deviceId);
}
function glAddTab(dst, params) {
  if (!remoteWindow || remoteWindow.isDestroyed()) {
    dst.__glKind = "tab";
    remoteWindow = dst;
  }
  const existed = dst.__glReady && dst.__glDevices.size > 0;
  glDeliverOpenRemotePage(dst, params);
  if (dst.isMinimized()) dst.restore();
  dst.show();
  dst.focus();
  // adding a tab to an already-showing window can leave the previous panel briefly
  // painted on top; nudge a clean re-render once the new tab has mounted
  if (existed) {
    setTimeout(() => {
      if (!dst.isDestroyed()) dst.webContents.send("glRepaint");
    }, 250);
  }
}
function glMoveDevice(deviceId, target) {
  const params = glDeviceParams.get(deviceId);
  if (!params) {
    glWarn("move: unknown device", deviceId);
    return;
  }
  const host = glDeviceHost.get(deviceId);
  if (target === "window") {
    let geometry = null;
    if (host && !host.isDestroyed()) {
      const lastTab = host.__glDevices.size <= 1;
      geometry = glGeometryFrom(host, lastTab ? 0 : 40);
      glDetachFromHost(host, deviceId);
    }
    glLog("move device to window", { deviceId, geometry });
    openRemoteWindow(params, { target: "window", geometry });
    return;
  }
  // move back into an existing session window as a tab
  const dst = glTabTargetFor(host);
  if (!dst) {
    glNotify("There is no other session window to merge into.");
    return;
  }
  glDetachFromHost(host, deviceId);
  glLog("move device into window as tab", { deviceId });
  glAddTab(dst, params);
}
// drag a session window onto another's tab strip to merge them into tabs
function glSuppressMoves(win, ms = 900) {
  win.__glSuppressMoveUntil = Date.now() + ms;
}
function glMergeWindows(src, dst) {
  if (!src || !dst || src === dst || src.isDestroyed() || dst.isDestroyed()) return;
  const ids = [...(src.__glDevices || [])];
  if (!ids.length) return;
  glLog("merge window into tabs", { count: ids.length });
  for (const id of ids) {
    const p = glDeviceParams.get(id);
    src.__glDevices.delete(id);
    if (glDeviceHost.get(id) === src) glDeviceHost.delete(id);
    if (p) glAddTab(dst, p);
  }
  try {
    src.close();
  } catch {
  }
}
// While a tab is being dragged, highlight the session window whose tab strip is under
// the cursor, so the user sees where it will dock.
const glDragHighlighted = new Set();
function glSetDragHighlight(target) {
  for (const w of glRemoteWindows) {
    const on = w === target;
    const was = glDragHighlighted.has(w);
    if (on && !was) {
      glDragHighlighted.add(w);
      if (!w.isDestroyed()) w.webContents.send("glDragHighlight", true);
    } else if (!on && was) {
      glDragHighlighted.delete(w);
      if (!w.isDestroyed()) w.webContents.send("glDragHighlight", false);
    }
  }
}
function glWindowUnderStrip(src, x, y) {
  const STRIP = 44;
  for (const dst of glRemoteWindows) {
    if (dst === src || dst.isDestroyed()) continue;
    const b = dst.getContentBounds();
    if (x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + STRIP) return dst;
  }
  return null;
}
// A small frameless pill that follows the cursor while a drag would tear a tab out into
// a new window, so the gesture reads even out over the desktop.
let glDragGhost = null;
let glDragGhostName = null;
function glGhostHtml(name) {
  const label = `New window · ${String(name || "").replace(/[<>&]/g, "")}`;
  return "data:text/html;charset=utf-8," + encodeURIComponent(
    '<meta charset="utf-8"><body style="margin:0;overflow:hidden;background:transparent">' +
    '<div style="display:inline-flex;align-items:center;gap:6px;font:600 12px/1 Inter,Segoe UI,system-ui,sans-serif;color:#fff;' +
    'background:rgba(28,30,36,.94);border:1px solid var(--b,#5b8cff);border-radius:8px;padding:7px 11px;white-space:nowrap;' +
    'box-shadow:0 6px 20px rgba(0,0,0,.45)">' +
    '<span style="font-size:14px">↗</span><span>' + label + "</span></div></body>"
  );
}
function glShowDragGhost(x, y, name) {
  if (!glDragGhost || glDragGhost.isDestroyed()) {
    glDragGhost = new require$$0$2.BrowserWindow({
      width: 260, height: 40, show: false, frame: false, transparent: true, hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, skipTaskbar: true,
      focusable: false, alwaysOnTop: true, acceptFirstMouse: false,
      webPreferences: { sandbox: true }
    });
    glDragGhost.setIgnoreMouseEvents(true);
    glDragGhostName = null;
  }
  if (glDragGhostName !== name) {
    glDragGhostName = name;
    glDragGhost.loadURL(glGhostHtml(name));
  }
  glDragGhost.setPosition(Math.round(x) + 14, Math.round(y) + 16);
  if (!glDragGhost.isVisible()) glDragGhost.showInactive();
}
function glHideDragGhost() {
  if (glDragGhost && !glDragGhost.isDestroyed() && glDragGhost.isVisible()) glDragGhost.hide();
}
function glDestroyDragGhost() {
  if (glDragGhost && !glDragGhost.isDestroyed()) glDragGhost.destroy();
  glDragGhost = null;
  glDragGhostName = null;
}
function glOnTabDragOver(event, payload) {
  const src = require$$0$2.BrowserWindow.fromWebContents(event.sender);
  if (!src) return;
  const x = Math.round(payload?.x);
  const y = Math.round(payload?.y);
  const target = glWindowUnderStrip(src, x, y);
  glSetDragHighlight(target);
  const sb = src.getContentBounds();
  const overOwnStrip = x >= sb.x && x <= sb.x + sb.width && y >= sb.y && y <= sb.y + 44;
  if (target || overOwnStrip || (src.__glDevices?.size || 0) <= 1) glHideDragGhost();
  else glShowDragGhost(x, y, payload?.name);
}
// A tab was dragged and dropped (renderer reports the screen-space drop point).
// Drop on another session window's tab strip -> move it there; drop elsewhere ->
// tear it out into its own window; a lone tab just moves its window.
function glOnTabDragEnd(event, payload) {
  const src = require$$0$2.BrowserWindow.fromWebContents(event.sender);
  if (!src || !glRemoteWindows.has(src)) return;
  const { deviceId } = payload || {};
  const x = Math.round(payload?.x);
  const y = Math.round(payload?.y);
  if (!deviceId || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const params = glDeviceParams.get(deviceId);
  if (!params) return;
  glSetDragHighlight(null);
  glDestroyDragGhost();
  const onto = glWindowUnderStrip(src, x, y);
  if (onto) {
    glDetachFromHost(src, deviceId);
    glLog("tab dragged into another window", { deviceId });
    glAddTab(onto, params);
    return;
  }
  // dropped back on its own strip -> ignore
  const sb = src.getContentBounds();
  if (x >= sb.x && x <= sb.x + sb.width && y >= sb.y && y <= sb.y + STRIP) return;
  // lone tab -> just move the window to the drop point
  if ((src.__glDevices?.size || 0) <= 1) {
    glSuppressMoves(src);
    src.setPosition(Math.max(0, x - 200), Math.max(0, y - 15));
    return;
  }
  // tear out into a new window at the drop point
  const base = glGeometryFrom(src, 0) || { width: 1280, height: 720, maximized: false };
  glDetachFromHost(src, deviceId);
  glLog("tab torn out to new window", { deviceId, at: [x, y] });
  openRemoteWindow(params, { target: "window", geometry: { width: base.width, height: base.height, maximized: false, x: Math.max(0, x - 200), y: Math.max(0, y - 15) } });
}
function glOnWindowMoved(win) {
  if (!win || win.isDestroyed()) return;
  if (Date.now() < (win.__glSuppressMoveUntil || 0)) return;
  if (!win.__glDevices || win.__glDevices.size === 0) return;
  const pt = require$$0$2.screen.getCursorScreenPoint();
  const STRIP = 44;
  for (const dst of glRemoteWindows) {
    if (dst === win || dst.isDestroyed()) continue;
    const b = dst.getContentBounds();
    if (pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + STRIP) {
      glMergeWindows(win, dst);
      return;
    }
  }
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
  const mergeTarget = glTabTargetFor(win);
  const template = [
    {
      label: `Move "${name}" to its own window`,
      enabled: tabCount > 1,
      click: () => glMoveDevice(deviceId, "window")
    },
    {
      label: `Move "${name}" into the main session window`,
      enabled: !!mergeTarget,
      click: () => glMoveDevice(deviceId, "tab")
    },
    { type: "separator" },
    {
      label: `Paste local clipboard into "${name}"  (${glPasteHotkey()})`,
      click: () => glPasteClipboardToRemote(win, deviceId)
    },
    {
      label: "Resize window to KVM resolution",
      click: () => glFitWindowToKvm(win, deviceId, false)
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
    {
      label: "Always open sessions at 1:1 (KVM resolution)",
      type: "checkbox",
      checked: !!store.get("remoteFitOnOpen"),
      click: (item) => store.set("remoteFitOnOpen", !!item.checked)
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
