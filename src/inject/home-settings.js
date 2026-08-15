// glikvm-mod: "Sessions (ui-mod)" section for the home window's General Settings page.
// Injected into the home renderer bundle right before the GeneralSettings component,
// so every identifier used here (defineComponent, ref, computed, createVNode, ...,
// useStorageRef, GlMenuItem, Wo, _sfc_main$19 = BaseDropdown, i18n) is the bundle's own.
const GL_MOD_DEFAULT_HOTKEY = "Ctrl+Alt+V";
const GL_MOD_I18N = {
  title: "Sessions (ui-mod __GL_MOD_VERSION__)",
  openIn: "Open sessions in",
  openInDesc: "Shift+click a device, or right-click a session tab, to override this per session",
  openTab: "Tabs in one session window",
  openWindow: "A separate window per session",
  hotkey: "Paste local clipboard hotkey",
  hotkeyDesc: "Types the local clipboard into the remote machine while a session window is focused",
  hotkeyRecording: "Press the key combination (Esc cancels)",
  hotkeyReset: "Reset",
  speed: "Paste speed",
  speedDesc: "Slow adds a delay between keys, for targets that drop characters",
  speedNormal: "Normal",
  speedSlow: "Slow",
  fit: "Always open sessions at 1:1 (KVM resolution)",
  fitDesc: "As soon as a session shows video, size its window so the remote screen is pixel-for-pixel; the 1:1 button next to fullscreen does the same on demand",
  fitOff: "Off",
  fitOn: "On",
  start: "Start screen",
  startDesc: "Which page the app opens on at startup",
  startRemote: "Remote Access",
  startLocal: "Local Access"
};
try {
  for (const loc of ["en", "zh"]) i18n.global.mergeLocaleMessage(loc, { uimod: GL_MOD_I18N });
} catch (e) {
  console.warn("[glikvm-mod] i18n merge failed", e);
}
const GlModSettings = /* @__PURE__ */ defineComponent({
  __name: "GlModSettings",
  setup() {
    const openMode = useStorageRef("remoteOpenMode", "tab");
    const pasteHotkey = useStorageRef("remotePasteHotkey", GL_MOD_DEFAULT_HOTKEY);
    const pasteSlowRaw = useStorageRef("remotePasteSlow");
    const pasteSpeed = computed({
      get: () => pasteSlowRaw.value ? "slow" : "normal",
      set: (v) => {
        pasteSlowRaw.value = v === "slow";
      }
    });
    const startScreen = useStorageRef("startScreen", "remote");
    const StartOptions = [new GlMenuItem("remote", "uimod.startRemote"), new GlMenuItem("local", "uimod.startLocal")];
    const fitRaw = useStorageRef("remoteFitOnOpen");
    const fitOnOpen = computed({
      get: () => fitRaw.value ? "on" : "off",
      set: (v) => {
        fitRaw.value = v === "on";
      }
    });
    const FitOptions = [new GlMenuItem("off", "uimod.fitOff"), new GlMenuItem("on", "uimod.fitOn")];
    const OpenModeOptions = [new GlMenuItem("tab", "uimod.openTab"), new GlMenuItem("window", "uimod.openWindow")];
    const PasteSpeedOptions = [new GlMenuItem("normal", "uimod.speedNormal"), new GlMenuItem("slow", "uimod.speedSlow")];
    const recording = ref(false);
    const MODIFIER_KEYS = /* @__PURE__ */ new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "NumLock", "ScrollLock", "OS"]);
    const onKeyDown = (e) => {
      if (!recording.value) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        recording.value = false;
        return;
      }
      if (MODIFIER_KEYS.has(e.key)) return;
      let name = "";
      if (/^Key[A-Z]$/.test(e.code)) name = e.code.slice(3);
      else if (/^Digit[0-9]$/.test(e.code)) name = e.code.slice(5);
      else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) name = e.code;
      else name = e.key.length === 1 ? e.key.toUpperCase() : e.key;
      const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Meta"].filter(Boolean);
      if (!mods.length && !/^F\d+$/.test(name)) return;
      pasteHotkey.value = [...mods, name].join("+");
      recording.value = false;
    };
    onMounted(() => window.addEventListener("keydown", onKeyDown, true));
    onBeforeUnmount(() => window.removeEventListener("keydown", onKeyDown, true));
    const startRecording = () => {
      recording.value = true;
    };
    const resetHotkey = () => {
      recording.value = false;
      pasteHotkey.value = GL_MOD_DEFAULT_HOTKEY;
    };
    return (_ctx) => {
      const BaseText = resolveComponent("BaseText");
      const t = (k) => _ctx.$t(k);
      const rowStyle = { padding: "6px 4px", minHeight: "52px", gap: "16px" };
      const row = (label, desc, control) => createVNode("div", { class: "info-container flex-btw", style: rowStyle }, [
        createVNode("div", { class: "flex flex-column items-start" }, [
          createVNode(BaseText, { type: "caption-r" }, { default: () => [createTextVNode(t(label))] }),
          createVNode(BaseText, { type: "caption-r", variant: "level3" }, { default: () => [createTextVNode(t(desc))] })
        ]),
        control
      ]);
      const dropdown = (model, options) => createVNode(_sfc_main$19, {
        value: model.value,
        "onUpdate:value": (v) => {
          model.value = v;
        },
        "show-icon": "",
        options
      }, {
        trigger: () => [
          createVNode("div", { class: "flex" }, [
            createVNode(BaseText, { class: "nowrap" }, {
              default: () => [createTextVNode(t(options.find((o) => o.key === model.value)?.label || ""))]
            })
          ])
        ]
      });
      const hotkeyControl = createVNode("div", { class: "flex", style: { gap: "12px", alignItems: "center" } }, [
        createVNode(BaseText, {
          class: "nowrap pointer",
          variant: recording.value ? "level3" : void 0,
          style: recording.value ? void 0 : { padding: "2px 8px", border: "1px solid var(--gl-color-line-border2)", borderRadius: "4px" },
          title: t("uimod.hotkeyRecording"),
          onClick: startRecording
        }, { default: () => [createTextVNode(recording.value ? t("uimod.hotkeyRecording") : pasteHotkey.value || GL_MOD_DEFAULT_HOTKEY)] }),
        createVNode(BaseText, { class: "nowrap pointer text-primary", type: "caption-r", onClick: resetHotkey }, {
          default: () => [createTextVNode(t("uimod.hotkeyReset"))]
        })
      ]);
      return createVNode("div", null, [
        createVNode("div", { class: "flex-start h-[20px] px-[4px] mt-[12px]" }, [
          createVNode(BaseText, { type: "caption-m", class: "font-[600]" }, { default: () => [createTextVNode(t("uimod.title"))] })
        ]),
        createVNode(Wo, { divider1: "", horizontal: "", gutter: 8 }),
        row("uimod.start", "uimod.startDesc", dropdown(startScreen, StartOptions)),
        row("uimod.openIn", "uimod.openInDesc", dropdown(openMode, OpenModeOptions)),
        row("uimod.hotkey", "uimod.hotkeyDesc", hotkeyControl),
        row("uimod.speed", "uimod.speedDesc", dropdown(pasteSpeed, PasteSpeedOptions)),
        row("uimod.fit", "uimod.fitDesc", dropdown(fitOnOpen, FitOptions))
      ]);
    };
  }
});
