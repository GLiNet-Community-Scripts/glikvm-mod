// Patch definitions for glikvm-mod.
// Every patch anchors on a piece of the stock (unminified) GLKVM bundle and
// fails loudly if the anchor is missing or ambiguous, so a client update that
// changes the code is detected instead of producing a half-patched app.
import fs from "node:fs";
import path from "node:path";

export const MOD_VERSION = "0.1.1";
export const REPO_URL = "https://github.com/emaspa/glikvm-mod";

export type Patch = {
  /** file inside the extracted asar, forward slashes */
  file: string;
  /** human description, printed while patching */
  what: string;
  apply: (src: string) => string;
};

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const inject = (name: string) => fs.readFileSync(path.join(here, "inject", name), "utf8");

function replaceOnce(src: string, anchor: string, replacement: string, label: string): string {
  const first = src.indexOf(anchor);
  if (first === -1) throw new Error(`[${label}] anchor not found:\n${anchor.slice(0, 200)}`);
  if (src.indexOf(anchor, first + 1) !== -1) throw new Error(`[${label}] anchor is not unique:\n${anchor.slice(0, 200)}`);
  return src.slice(0, first) + replacement + src.slice(first + anchor.length);
}

function replaceRange(src: string, startAnchor: string, endAnchor: string, replacement: string, label: string): string {
  const start = src.indexOf(startAnchor);
  if (start === -1 || src.indexOf(startAnchor, start + 1) !== -1) throw new Error(`[${label}] start anchor missing/ambiguous`);
  const end = src.indexOf(endAnchor, start);
  if (end === -1 || src.indexOf(endAnchor, end + 1) !== -1) throw new Error(`[${label}] end anchor missing/ambiguous`);
  return src.slice(0, start) + replacement + src.slice(end);
}

function replaceRegexOnce(src: string, re: RegExp, replacement: string, label: string): string {
  const matches = src.match(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"));
  if (!matches || matches.length !== 1) throw new Error(`[${label}] regex matched ${matches?.length ?? 0} times, expected 1`);
  return src.replace(re, replacement);
}

// ---------------------------------------------------------------------------
// main process
// ---------------------------------------------------------------------------
const mainPatches: Patch[] = [
  {
    file: "out/main/index.js",
    what: "main: replace singleton openRemoteWindow/closeRemoteWindow with multi-window implementation + clipboard paste",
    apply: (src) =>
      replaceRange(
        src,
        "let remoteWindow = null;\n",
        "function closeRemoteWebtermByDeviceId(deviceId) {",
        inject("main-remote-windows.js").replace("__GL_MOD_VERSION__", MOD_VERSION).replace("__GL_REPO_URL__", REPO_URL),
        "main.openRemoteWindow",
      ),
  },
  {
    file: "out/main/index.js",
    what: "main: register new IPC channels + track tab close for host map",
    apply: (src) => {
      src = replaceOnce(
        src,
        "    openRemoteWindow: (_2, params) => openRemoteWindow(params),\n",
        [
          "    openRemoteWindow: (_2, params) => openRemoteWindow(params),\n",
          "    glShowTabMenu: (event, payload) => glShowTabMenu(event, payload),\n",
          "    glMoveDevice: (_2, deviceId, target) => glMoveDevice(deviceId, target),\n",
          "    glNewSession: (event) => glShowNewSessionMenu(event),\n",
          "    glFitWindow: (event) => {\n",
          "      const win = require$$0$2.BrowserWindow.fromWebContents(event.sender);\n",
          "      if (win) glFitWindowToKvm(win, null, false);\n",
          "    },\n",
          "    glRemoteCurrentDevice: (event, cfg) => glSetCurrentDevice(event, cfg),\n",
          "    glPasteClipboard: (event) => {\n",
          "      const win = require$$0$2.BrowserWindow.fromWebContents(event.sender);\n",
          "      if (win) glPasteClipboardToRemote(win);\n",
          "    },\n",
        ].join(""),
        "main.ipc.on",
      );
      src = replaceOnce(
        src,
        "    closeRemoteWebtermByDeviceId: (_2, deviceId) => closeRemoteWebtermByDeviceId(deviceId),\n",
        [
          "    closeRemoteWebtermByDeviceId: (event, deviceId) => {\n",
          "      glOnTabClosed(event, deviceId);\n",
          "      closeRemoteWebtermByDeviceId(deviceId);\n",
          "    },\n",
        ].join(""),
        "main.ipc.closeWebterm",
      );
      return src;
    },
  },
  {
    file: "out/main/index.js",
    what: "main: offer to close the stock client instead of silently quitting on single-instance conflict",
    apply: (src) =>
      replaceOnce(
        src,
        [
          "const gotTheLock = require$$0$2.app.requestSingleInstanceLock();",
          "if (!gotTheLock) {",
          "  require$$0$2.app.quit();",
          "} else {",
          "",
        ].join("\n"),
        [
          "const gotTheLock = require$$0$2.app.requestSingleInstanceLock();",
          "if (!gotTheLock) {",
          "  glHandleInstanceConflict();",
          "} else {",
          "",
        ].join("\n"),
        "main.singleInstance",
      ),
  },
  {
    file: "out/main/index.js",
    what: "main: add store defaults (remoteOpenMode, remotePasteHotkey, remotePasteSlow)",
    apply: (src) =>
      replaceOnce(
        src,
        "    remoteWindowMaximized: false,\n    deviceImages: [],\n",
        [
          "    remoteWindowMaximized: false,\n",
          '    remoteOpenMode: "tab",\n',
          '    remotePasteHotkey: "Ctrl+Alt+V",\n',
          "    remotePasteSlow: false,\n",
          "    recentSessions: [],\n",
          "    remoteFitOnOpen: false,\n",
          '    startScreen: "remote",\n',
          "    deviceImages: [],\n",
        ].join(""),
        "main.store.defaults",
      ),
  },
];

// ---------------------------------------------------------------------------
// preload
// ---------------------------------------------------------------------------
const preloadPatches: Patch[] = [
  {
    file: "out/preload/index.js",
    what: "preload: shift-click tracking + new IPC helpers on window.utils",
    apply: (src) => {
      src = replaceOnce(
        src,
        "const invokeApis = {\n",
        [
          "// glikvm-mod: remember whether the last click had Shift held, so Shift+click on a device opens it in a new window\n",
          "let glModLastShiftAt = 0;\n",
          "window.addEventListener(\"mousedown\", (e) => { glModLastShiftAt = e.shiftKey ? Date.now() : 0; }, true);\n",
          "window.addEventListener(\"keydown\", (e) => { if (e.key === \"Enter\" || e.key === \" \") glModLastShiftAt = e.shiftKey ? Date.now() : 0; }, true);\n",
          "const glModShiftHeld = () => Date.now() - glModLastShiftAt < 15e3;\n",
          "const invokeApis = {\n",
        ].join(""),
        "preload.shift",
      );
      src = replaceOnce(
        src,
        '  openRemoteWindow: (config) => electron.ipcRenderer.send("openRemoteWindow", config),\n',
        [
          '  openRemoteWindow: (config) => electron.ipcRenderer.send("openRemoteWindow", { glNewWindow: glModShiftHeld(), ...config }),\n',
          '  glShowTabMenu: (payload) => electron.ipcRenderer.send("glShowTabMenu", payload),\n',
          '  glRemoteCurrentDevice: (cfg) => electron.ipcRenderer.send("glRemoteCurrentDevice", cfg),\n',
          '  glPasteClipboard: () => electron.ipcRenderer.send("glPasteClipboard"),\n',
          "  glOn: (channel, callback) => electron.ipcRenderer.on(channel, callback),\n",
          '  glMoveDevice: (deviceId, target) => electron.ipcRenderer.send("glMoveDevice", deviceId, target),\n',
          '  glNewSession: () => electron.ipcRenderer.send("glNewSession"),\n',
          '  glFitWindow: () => electron.ipcRenderer.send("glFitWindow"),\n',
        ].join(""),
        "preload.apis",
      );
      return src;
    },
  },
];

// ---------------------------------------------------------------------------
// renderer: remote (session) window
// ---------------------------------------------------------------------------
function findRemoteBundle(dir: string): string {
  const html = fs.readFileSync(path.join(dir, "out/renderer/view/remote/index.html"), "utf8");
  const m = html.match(/src="\.\.\/\.\.\/assets\/(remote-[^"]+\.js)"/);
  if (!m) throw new Error("cannot find remote bundle name in view/remote/index.html");
  return "out/renderer/assets/" + m[1];
}

const rendererPatches = (dir: string): Patch[] => {
  const file = findRemoteBundle(dir);
  return [
    {
      file,
      what: "renderer: tag each tab with data-gl-device-id + tooltip",
      apply: (src) =>
        replaceRegexOnce(
          src,
          /createBaseVNode\("div", \{(\s*)class: normalizeClass\(\{(\s*)"device-tab flex-btw/,
          'createBaseVNode("div", {$1"data-gl-device-id": item.device.id,$1title: "Right-click: move to own window / paste local clipboard",$1class: normalizeClass({$2"device-tab flex-btw',
          "renderer.tabAttr",
        ),
    },
    {
      file,
      what: 'renderer: "+" (new session) button at the end of the tab strip',
      apply: (src) =>
        replaceOnce(
          src,
          '          }, 8, ["active-key"])\n        ]),\n        createBaseVNode("div", _hoisted_2, [\n',
          [
            '          }, 8, ["active-key"]),',
            '          createBaseVNode("div", {',
            '            class: "pointer",',
            '            title: "New session in this window",',
            '            style: { flex: "0 0 auto", width: "32px", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "20px", lineHeight: "1", opacity: "0.75", userSelect: "none", WebkitAppRegion: "no-drag" },',
            "            onClick: () => window.utils.glNewSession()",
            '          }, "+")',
            "        ]),",
            '        createBaseVNode("div", _hoisted_2, [',
            "",
          ].join("\n"),
          "renderer.newTabButton",
        ),
    },
    {
      file,
      what: "renderer: detach handler, current-device reporting, tab context menu",
      apply: (src) =>
        replaceOnce(
          src,
          '    useListener("openRemotePage", (params) => {\n',
          [
            "    // glikvm-mod ---------------------------------------------------------\n",
            '    window.utils.glOn("glDetachTab", (_e, id) => {\n',
            "      configList.value = configList.value.filter((item) => item.device.id !== id);\n",
            "      if (currentViewDeviceId.value === id) currentViewDeviceId.value = configList.value[0]?.device.id;\n",
            "      if (!configList.value.length) window.utils.closeWindow();\n",
            "    });\n",
            "    watch(\n",
            "      () => currentConfig.value,\n",
            "      (cfg) => {\n",
            "        try {\n",
            "          window.utils.glRemoteCurrentDevice(cfg ? JSON.parse(JSON.stringify(cfg)) : null);\n",
            "        } catch {\n",
            "        }\n",
            "      },\n",
            "      { immediate: true }\n",
            "    );\n",
            "    document.addEventListener(\n",
            '      "contextmenu",\n',
            "      (e) => {\n",
            '        const el = e.target && e.target.closest ? e.target.closest("[data-gl-device-id]") : null;\n',
            "        if (!el) return;\n",
            '        const id = el.getAttribute("data-gl-device-id");\n',
            "        if (!configList.value.find((c) => c.device.id === id)) return;\n",
            "        e.preventDefault();\n",
            "        e.stopPropagation();\n",
            "        window.utils.glShowTabMenu({ deviceId: id, tabCount: configList.value.length });\n",
            "      },\n",
            "      true\n",
            "    );\n",
            "    window.addEventListener(\"message\", (e) => {\n",
            "      try {\n",
            '        const d = typeof e.data === "string" ? JSON.parse(e.data) : e.data;\n',
            '        if (d && d.glMod === "fit") window.utils.glFitWindow();\n',
            "      } catch {\n",
            "      }\n",
            "    });\n",
            "    // ---------------------------------------------------------------------\n",
            '    useListener("openRemotePage", (params) => {\n',
          ].join(""),
          "renderer.page",
        ),
    },
  ];
};

// ---------------------------------------------------------------------------
// renderer: home window - stamp the displayed version (the copy used for the
// update check is left alone so the updater keeps behaving)
// ---------------------------------------------------------------------------
function findHomeBundle(dir: string): string {
  const html = fs.readFileSync(path.join(dir, "out/renderer/view/home/index.html"), "utf8");
  const m = html.match(/src="\.\.\/\.\.\/assets\/(home-[^"]+\.js)"/);
  if (!m) throw new Error("cannot find home bundle name in view/home/index.html");
  return "out/renderer/assets/" + m[1];
}

const homePatches = (dir: string): Patch[] => [
  {
    file: findHomeBundle(dir),
    what: "home: start screen setting (Remote Access / Local Access) via a one-shot router guard",
    apply: (src) =>
      replaceOnce(
        src,
        "router.beforeEach((to) => {\n  if (to.meta.auth) {\n",
        [
          "// glikvm-mod: honour the 'start screen' setting on the very first navigation only",
          "let glModStartHandled = false;",
          "router.beforeEach(async (to, from) => {",
          "  if (glModStartHandled || from.matched.length !== 0) return true;",
          "  glModStartHandled = true;",
          "  try {",
          "    const info = await window.utils.getStoreInfo();",
          "    const startScreen = info && info.startScreen;",
          '    window.__glModBackTarget = startScreen === "local" ? "/localAccess" : "/deviceList";',
          '    window.utils.logInfo("[glikvm-mod] first navigation", to.fullPath, "startScreen=" + startScreen);',
          '    if (to.path !== "/" && to.path !== "/deviceList") return true;',
          '    if (startScreen === "local") return "/localAccess";',
          "  } catch {",
          "  }",
          "  return true;",
          "});",
          "// glikvm-mod: remember which access page was shown last, so Back from Settings returns there",
          "router.afterEach((to) => {",
          '  if (to.path === "/deviceList" || to.path === "/localAccess") window.__glModBackTarget = to.fullPath;',
          "});",
          "router.beforeEach((to) => {",
          "  if (to.meta.auth) {",
          "",
        ].join("\n"),
        "home.startScreen",
      ),
  },
  {
    file: findHomeBundle(dir),
    what: "home: Back from Settings returns to the access page shown last (not always Remote Access)",
    apply: (src) =>
      replaceOnce(
        src,
        "      router2.push({ name: route.meta.backPathName });\n    };\n    const handleGoToSettings = () => {\n",
        [
          '      if (route.path.startsWith("/personalCenter") && window.__glModBackTarget) {',
          "        router2.push(window.__glModBackTarget);",
          "        return;",
          "      }",
          "      router2.push({ name: route.meta.backPathName });",
          "    };",
          "    const handleGoToSettings = () => {",
          "",
        ].join("\n"),
        "home.backButton",
      ),
  },
  {
    file: findHomeBundle(dir),
    what: "home: add 'Sessions (ui-mod)' section to General Settings (open mode, paste hotkey, paste speed)",
    apply: (src) => {
      src = replaceOnce(
        src,
        'const _sfc_main$c = /* @__PURE__ */ defineComponent({\n  __name: "GeneralSettings",\n',
        inject("home-settings.js").replace("__GL_MOD_VERSION__", MOD_VERSION) +
          'const _sfc_main$c = /* @__PURE__ */ defineComponent({\n  __name: "GeneralSettings",\n',
        "home.settings.component",
      );
      // mount it as the last child of the settings content, right after the "when close window" row
      src = replaceOnce(
        src,
        '            }, 8, ["value", "options"])\n          ])\n        ])\n      ]);\n    };\n  }\n});\nconst GeneralSettings = ',
        '            }, 8, ["value", "options"])\n          ]),\n          createVNode(GlModSettings)\n        ])\n      ]);\n    };\n  }\n});\nconst GeneralSettings = ',
        "home.settings.mount",
      );
      return src;
    },
  },
  {
    file: findHomeBundle(dir),
    what: "home: About page shows the mod + link to the GitHub repo",
    apply: (src) =>
      replaceRegexOnce(
        src,
        /(createTextVNode\(" Copyright \d{4} GL [^"]*"\)\n\s*\]\)\),\n\s*_: 1\n\s*\}\)\n\s*\]\)\n\s*\]\),\n)/,
        "$1" +
          [
            '          createBaseVNode("div", { class: "h-[20px] mt-[12px] flex-start" }, [',
            '            createVNode(_component_BaseText, { type: "footnote-m", variant: "level2" }, {',
            `              default: withCtx(() => [createTextVNode("ui-mod ${MOD_VERSION} installed \u00a0\u00b7")]),`,
            "              _: 1",
            "            }),",
            `            createVNode(_component_BaseText, { class: "text-primary pointer", variant: "level2", style: { marginLeft: "6px" }, onClick: () => window.open("${REPO_URL}") }, {`,
            `              default: withCtx(() => [createTextVNode("${REPO_URL.replace("https://", "")}")]),`,
            "              _: 1",
            "            })",
            "          ]),",
            "",
          ].join("\n"),
        "home.about",
      ),
  },
  {
    file: findHomeBundle(dir),
    what: `home: show "ui-mod ${MOD_VERSION}" next to the client version`,
    apply: (src) =>
      replaceOnce(
        src,
        "createTextVNode(toDisplayString(unref(CURRENT_VERSION)), 1)",
        `createTextVNode(toDisplayString(unref(CURRENT_VERSION) + " \\u00b7 ui-mod ${MOD_VERSION}"), 1)`,
        "home.versionStamp",
      ),
  },
];

export function allPatches(extractedDir: string): Patch[] {
  return [...mainPatches, ...preloadPatches, ...rendererPatches(extractedDir), ...homePatches(extractedDir)];
}
