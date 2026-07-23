import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const options = parseArguments(process.argv.slice(2));
const rendererPort = options.port ?? "9347";
const mainPort = options["main-port"];
const cssPath = path.resolve(options.css ?? path.join(scriptDirectory, "theme.css"));
const artworkPath = path.resolve(options.wallpaper ?? options.artwork ?? path.join(scriptDirectory, "pokemon-onsen.jpg"));
const logoPath = path.resolve(options.logo ?? path.join(scriptDirectory, "pokeball-logo-white.png"));
const petNotificationsPath = path.resolve(
  options["pet-notifications"] ?? path.join(scriptDirectory, "pet-notifications.js"),
);
const oneShot = options.once === true;
const featureSettingsBinding = "__codexPlusProSettingsChanged";
const multiPipBinding = "__codexPlusProMultiPipRequest";

const [cssTemplate, artwork, logo, petNotificationsSource] = await Promise.all([
  fs.readFile(cssPath, "utf8"),
  fs.readFile(artworkPath),
  fs.readFile(logoPath),
  fs.readFile(petNotificationsPath, "utf8"),
]);

const artworkDataUri = `data:image/jpeg;base64,${artwork.toString("base64")}`;
const logoDataUri = `data:image/png;base64,${logo.toString("base64")}`;
const themeCss = cssTemplate
  .replaceAll("__WALLPAPER_DATA_URI__", artworkDataUri)
  .replaceAll("__POKEBALL_LOGO_DATA_URI__", logoDataUri);
const injectionSource = buildInjectionSource(themeCss) + "\n;\n" + petNotificationsSource;
const mainControllerSource = buildMainControllerSource();

if (options.check === true) {
  new Function(injectionSource);
  new Function(mainControllerSource);
  log("Renderer injection and window controller syntax are valid");
  process.exit(0);
}

const connections = new Map();
const attaching = new Set();
let mainConnection = null;
let mainAttaching = false;
let shuttingDown = false;
let missingServerTicks = 0;
let featureSettings = {
  theme: true,
  pet: true,
  pip: true,
  modelPicker: true,
  accent: "pokedex",
  wallpaperStrength: 72,
  wallpaperMode: "default",
  petMotion: "full",
  pipAlwaysOnTop: true,
  modelDensity: "compact",
};

process.on("SIGINT", shutDown);
process.on("SIGTERM", shutDown);

log(`Codex Plus Pro renderer injector starting on 127.0.0.1:${rendererPort}`);
if (mainPort) log(`Codex Plus Pro window controller starting on 127.0.0.1:${mainPort}`);

while (!shuttingDown) {
  let reachedDevTools = false;
  let appTargetCount = 0;

  try {
    const targets = await fetchJson(`http://127.0.0.1:${rendererPort}/json/list`, 1200);
    reachedDevTools = true;

    const appTargets = targets.filter((target) =>
      target.type === "page" &&
      target.webSocketDebuggerUrl &&
      (target.url.startsWith("app://") || target.title === "Codex")
    );
    appTargetCount = appTargets.length;

    for (const target of appTargets) {
      if (!connections.has(target.id) && !attaching.has(target.id)) {
        attaching.add(target.id);
        attachToTarget(target).catch((error) => {
          connections.delete(target.id);
          log(`Target ${target.id} attach failed: ${error.message}`);
        }).finally(() => {
          attaching.delete(target.id);
        });
      }
    }

    const liveIds = new Set(appTargets.map((target) => target.id));
    for (const [targetId, connection] of connections) {
      if (!liveIds.has(targetId)) {
        connection.close();
        connections.delete(targetId);
      }
    }

  } catch (error) {
    if (missingServerTicks === 0) log(`Waiting for Codex renderer DevTools: ${error.message}`);
  }

  if (mainPort && !mainConnection && !mainAttaching) {
    mainAttaching = true;
    try {
      const targets = await fetchJson(`http://127.0.0.1:${mainPort}/json/list`, 1200);
      reachedDevTools = true;
      const mainTarget = targets.find((target) => target.webSocketDebuggerUrl);
      if (mainTarget) await attachToMainTarget(mainTarget);
    } catch (error) {
      if (missingServerTicks === 0) log(`Waiting for Codex window controller: ${error.message}`);
    } finally {
      mainAttaching = false;
    }
  } else if (mainConnection) {
    reachedDevTools = true;
  }

  if (reachedDevTools) {
    missingServerTicks = 0;
  } else {
    missingServerTicks += 1;
    if (missingServerTicks >= 20) {
      log("Codex is no longer reachable; injector exiting.");
      break;
    }
  }

  if (oneShot && appTargetCount > 0 && (!mainPort || mainConnection)) {
    await delay(350);
    break;
  }

  await delay(900);
}

for (const connection of connections.values()) connection.close();
mainConnection?.close();
process.exit(0);

async function attachToTarget(target) {
  const cdp = await createCdpConnection(target.webSocketDebuggerUrl, () => {
    connections.delete(target.id);
  });
  connections.set(target.id, cdp);

  await cdp.send("Runtime.enable");
  cdp.on("Runtime.bindingCalled", async ({ name, payload }) => {
    if (name === featureSettingsBinding) {
      try {
        featureSettings = normalizeFeatureSettings(JSON.parse(payload));
        await syncMainFeatureSettings();
      } catch (error) {
        log(`Codex Plus Pro settings update failed: ${error.message}`);
      }
      return;
    }
    if (name !== multiPipBinding) return;
    void handleMultiPipRequest(cdp, payload);
  });
  await cdp.send("Runtime.addBinding", { name: featureSettingsBinding });
  await cdp.send("Runtime.addBinding", { name: multiPipBinding });
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: injectionSource });
  const result = await cdp.send("Runtime.evaluate", {
    expression: injectionSource,
    awaitPromise: true,
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      "Runtime injection failed"
    );
  }

  log(`Theme active in ${target.title || "Codex"} (${target.id.slice(0, 8)})`);
}

async function attachToMainTarget(target) {
  const cdp = await createCdpConnection(target.webSocketDebuggerUrl, () => {
    if (mainConnection === cdp) mainConnection = null;
  });
  mainConnection = cdp;

  await cdp.send("Runtime.enable");
  const result = await cdp.send("Runtime.evaluate", {
    expression: mainControllerSource,
    awaitPromise: true,
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    mainConnection.close();
    mainConnection = null;
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Window controller failed");
  }

  await syncMainFeatureSettings();
  log("Codex Plus Pro window controller active");
}

function normalizeFeatureSettings(value) {
  const accent = ["pokedex", "lagoon", "forest", "graphite"].includes(value?.accent)
    ? value.accent
    : "pokedex";
  const wallpaperStrength = Number.isFinite(Number(value?.wallpaperStrength))
    ? Math.max(0, Math.min(100, Math.round(Number(value.wallpaperStrength))))
    : 72;
  return {
    theme: value?.theme !== false,
    pet: value?.pet !== false,
    pip: value?.pip !== false,
    modelPicker: value?.modelPicker !== false,
    accent,
    wallpaperStrength,
    wallpaperMode: value?.wallpaperMode === "custom" ? "custom" : "default",
    petMotion: value?.petMotion === "reduced" ? "reduced" : "full",
    pipAlwaysOnTop: value?.pipAlwaysOnTop !== false,
    modelDensity: value?.modelDensity === "comfortable" ? "comfortable" : "compact",
  };
}

async function syncMainFeatureSettings() {
  if (!mainConnection) return;
  const expression = `globalThis.__codexPokedexPipWindowController?.setFeatures(${JSON.stringify(featureSettings)})`;
  const result = await mainConnection.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Window settings failed");
  }
}

async function evaluateMainController(method, ...argumentsList) {
  if (!mainConnection) throw new Error("Codex Plus Pro window controller is not connected");
  const expression = `globalThis.__codexPokedexPipWindowController?.[${JSON.stringify(method)}](...${JSON.stringify(argumentsList)})`;
  const result = await mainConnection.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Window operation failed");
  }
  return result.result?.value;
}

async function handleMultiPipRequest(cdp, rawPayload) {
  let requestId = "";
  let response;
  try {
    const request = JSON.parse(rawPayload);
    requestId = String(request?.requestId || "");
    const action = String(request?.action || "");
    const threadId = String(request?.threadId || "");
    if (!requestId) throw new Error("Picture-in-picture request is missing an id");

    if (action === "open-thread") {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) {
        throw new Error("Invalid task id");
      }
      const preparation = await evaluateMainController("beginOpenThread", threadId);
      if (preparation?.reused) {
        response = { ok: true, ...preparation };
      } else {
        try {
          const openResult = await cdp.send("Runtime.evaluate", {
            expression: `globalThis.__codexPlusProOpenOfficialPip?.(${JSON.stringify(threadId)})`,
            awaitPromise: true,
            returnByValue: true,
          });
          if (openResult.exceptionDetails) {
            throw new Error(openResult.exceptionDetails.exception?.description ?? openResult.exceptionDetails.text ?? "Official Popout service failed");
          }
          response = { ok: true, ...await evaluateMainController("finishOpenThread", threadId) };
        } catch (error) {
          await evaluateMainController("abortOpenThread").catch(() => {});
          throw error;
        }
      }
    } else if (action === "close-current") {
      response = { ok: true, ...await evaluateMainController("closeThread", threadId) };
    } else if (action === "toggle-pin-current") {
      response = { ok: true, ...await evaluateMainController("toggleThreadPin", threadId) };
    } else if (action === "get-current-state") {
      response = { ok: true, ...await evaluateMainController("getThreadState", threadId) };
    } else {
      throw new Error(`Unknown picture-in-picture action: ${action}`);
    }
  } catch (error) {
    response = { ok: false, error: error?.message || String(error) };
    log(`Codex Plus Pro multi-window operation failed: ${response.error}`);
  }

  if (!requestId) return;
  const callback = `globalThis.__codexPlusProResolveMultiPipRequest?.(${JSON.stringify(requestId)}, ${JSON.stringify(response)})`;
  await cdp.send("Runtime.evaluate", {
    expression: callback,
    awaitPromise: true,
    returnByValue: true,
  }).catch((error) => log(`Codex Plus Pro could not return a window result: ${error.message}`));
}

function buildInjectionSource(css) {
  return `(() => {
    const STYLE_ID = "codex-pokedex-theme-style";
    const THEME_ATTRIBUTE = "data-codex-pokedex-theme";
    const OVERLAY_ATTRIBUTE = "data-codex-pokedex-avatar-overlay";
    const HOME_ATTRIBUTE = "data-codex-pokedex-home";
    const HOME_PANEL_ATTRIBUTE = "data-codex-pokedex-home-panel";
    const TASK_RUNNING_ATTRIBUTE = "data-codex-pokedex-task-running";
    const PIP_WINDOW_ATTRIBUTE = "data-codex-pokedex-pip-window";
    const PIP_COMPOSER_ATTRIBUTE = "data-codex-pokedex-pip-composer";
    const PIP_COMPOSER_OPEN_ATTRIBUTE = "data-codex-pokedex-pip-composer-open";
    const PIP_THREAD_ID_ATTRIBUTE = "data-codex-plus-pip-thread-id";
    const FLAT_PICKER_ATTRIBUTE = "data-codex-pokedex-flat-picker";
    const FLAT_PICKER_SURFACE_ATTRIBUTE = "data-codex-pokedex-flat-picker-surface";
    const FLAT_PICKER_FALLBACK_ATTRIBUTE = "data-codex-pokedex-flat-picker-fallback";
    const FLAT_PICKER_FAILURE_ATTRIBUTE = "data-codex-pokedex-flat-picker-failures";
    const FLAT_PICKER_VERSION = "1.7.2";
    const ACTIVITY_CHANNEL_NAME = "codex-pokedex-pet-activity-v1";
    const SETTINGS_STORAGE_KEY = "codex-plus-pro-settings-v1";
    const CUSTOM_WALLPAPER_STORAGE_KEY = "codex-plus-pro-wallpaper-v1";
    const SETTINGS_CHANNEL_NAME = "codex-plus-pro-settings-v1";
    const SETTINGS_BINDING = "__codexPlusProSettingsChanged";
    const MULTI_PIP_BINDING = "__codexPlusProMultiPipRequest";
    const SETTINGS_UI_VERSION = "4";
    const FEATURE_ATTRIBUTES = {
      theme: "data-codex-plus-theme",
      pet: "data-codex-plus-pet",
      pip: "data-codex-plus-pip",
      modelPicker: "data-codex-plus-model-picker",
    };
    const initialRoute = new URL(location.href).searchParams.get("initialRoute") || "";
    const initialThreadId = initialRoute.match(new RegExp("^/hotkey-window/thread/([0-9a-f-]{36})", "i"))?.[1] || "";
    const isAvatarOverlay = initialRoute === "/avatar-overlay";
    const isHotkeyWindow = initialRoute.startsWith("/hotkey-window");
    const css = ${JSON.stringify(css)};
    const previousRuntimeCleanup = window.__codexPlusProRuntimeCleanup;
    if (typeof previousRuntimeCleanup === "function") {
      previousRuntimeCleanup();
    } else {
      window.__codexPokedexThemeObserver?.disconnect();
      window.__codexPlusProSettingsUiCleanup?.();
      window.__codexPokedexPipHoverCleanup?.();
      const previousActivityChannel = window.__codexPokedexActivityChannel;
      window.__codexPokedexActivityChannel = null;
      if (previousActivityChannel) {
        window.setTimeout(() => {
          try { previousActivityChannel.close(); } catch {}
        }, 250);
      }
      try { window.__codexPlusProSettingsChannel?.close(); } catch {}
      window.__codexPlusProSettingsChannel = null;
    }
    document.querySelector(".codex-plus-pro-settings-button")?.remove();
    document.querySelector(".codex-plus-pro-settings-popover")?.remove();
    document.querySelector(".codex-plus-pro-settings-backdrop")?.remove();
    for (const element of document.querySelectorAll(".codex-pokedex-flat-picker, .codex-pokedex-pip-row-button, .codex-pokedex-pip-composer-handle, .codex-pokedex-pip-stop-proxy, .codex-pokedex-pip-pin-toggle")) {
      element.remove();
    }
    const PIP_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 9V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"/><rect width="10" height="7" x="12" y="13" rx="2"/></svg>';
    const MESSAGE_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>';
    const STOP_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="12" height="12" x="6" y="6" rx="1"/></svg>';
    const PIN_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M5 17h14"/><path d="M6 17v-5l2-2V5h8v5l2 2v5"/></svg>';
    const SETTINGS_ICON = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="4" y1="21" y2="14"/><line x1="4" x2="4" y1="10" y2="3"/><line x1="12" x2="12" y1="21" y2="12"/><line x1="12" x2="12" y1="8" y2="3"/><line x1="20" x2="20" y1="21" y2="16"/><line x1="20" x2="20" y1="12" y2="3"/><line x1="1" x2="7" y1="14" y2="14"/><line x1="9" x2="15" y1="8" y2="8"/><line x1="17" x2="23" y1="16" y2="16"/></svg>';
    const DEFAULT_MODEL_OPTIONS = ["5.6 Sol", "5.6 Terra", "5.6 Luna", "5.5", "5.3 Codex Spark"];
    const DEFAULT_EFFORT_OPTIONS = ["Light", "Medium", "High", "Extra High", "Max", "Ultra"];
    const EFFORT_LABEL_BY_CODE = {
      minimal: "Light",
      low: "Light",
      medium: "Medium",
      high: "High",
      xhigh: "Extra High",
      max: "Max",
      ultra: "Ultra",
    };
    const DEFAULT_FEATURE_SETTINGS = {
      theme: true,
      pet: true,
      pip: true,
      modelPicker: true,
      accent: "pokedex",
      wallpaperStrength: 72,
      wallpaperMode: "default",
      petMotion: "full",
      pipAlwaysOnTop: true,
      modelDensity: "compact",
    };
    const ACCENT_OPTIONS = {
      pokedex: { label: "图鉴红", color: "#b61f31", dark: "#751522", highlight: "#d29a18" },
      lagoon: { label: "海湾青", color: "#277d91", dark: "#175263", highlight: "#d29a18" },
      forest: { label: "常青绿", color: "#3f7f59", dark: "#28533b", highlight: "#d29a18" },
      graphite: { label: "石墨黑", color: "#4b4f55", dark: "#2e3135", highlight: "#c5902b" },
    };
    const normalizeFeatureSettings = (value) => {
      const accent = Object.hasOwn(ACCENT_OPTIONS, value?.accent) ? value.accent : "pokedex";
      const wallpaperStrength = Number.isFinite(Number(value?.wallpaperStrength))
        ? Math.max(0, Math.min(100, Math.round(Number(value.wallpaperStrength))))
        : 72;
      return {
        theme: value?.theme !== false,
        pet: value?.pet !== false,
        pip: value?.pip !== false,
        modelPicker: value?.modelPicker !== false,
        accent,
        wallpaperStrength,
        wallpaperMode: value?.wallpaperMode === "custom" ? "custom" : "default",
        petMotion: value?.petMotion === "reduced" ? "reduced" : "full",
        pipAlwaysOnTop: value?.pipAlwaysOnTop !== false,
        modelDensity: value?.modelDensity === "comfortable" ? "comfortable" : "compact",
      };
    };
    const readFeatureSettings = () => {
      try {
        const value = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY) || "null");
        return normalizeFeatureSettings(value || DEFAULT_FEATURE_SETTINGS);
      } catch {
        return { ...DEFAULT_FEATURE_SETTINGS };
      }
    };
    const readCustomWallpaper = () => {
      try {
        const value = localStorage.getItem(CUSTOM_WALLPAPER_STORAGE_KEY) || "";
        return value.startsWith("data:image/") ? value : "";
      } catch {
        return "";
      }
    };
    const prepareWallpaper = (file) => new Promise((resolve, reject) => {
      if (!file?.type?.startsWith("image/")) {
        reject(new Error("请选择图片文件"));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("无法读取图片"));
      reader.onload = () => {
        const image = new Image();
        image.onerror = () => reject(new Error("无法解析图片"));
        image.onload = () => {
          const maxWidth = 2560;
          const maxHeight = 1600;
          const ratio = Math.min(1, maxWidth / image.naturalWidth, maxHeight / image.naturalHeight);
          const width = Math.max(1, Math.round(image.naturalWidth * ratio));
          const height = Math.max(1, Math.round(image.naturalHeight * ratio));
          const canvas = document.createElement("canvas");
          canvas.width = width;
          canvas.height = height;
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) {
            reject(new Error("无法处理图片"));
            return;
          }
          context.fillStyle = "#fff8e9";
          context.fillRect(0, 0, width, height);
          context.drawImage(image, 0, 0, width, height);
          resolve(canvas.toDataURL("image/jpeg", 0.86));
        };
        image.src = String(reader.result || "");
      };
      reader.readAsDataURL(file);
    });
    let featureSettings = readFeatureSettings();
    let hotkeyServicesPromise = null;
    let refreshFrame = 0;
    let pipCloseTimer = 0;
    let pipThreadId = sessionStorage.getItem("codex-plus-pro-pip-thread-id") || initialThreadId;
    let pipWindowPinned = null;
    let nextPipRequestId = 1;
    const pendingPipRequests = new Map();

    const resolveMultiPipRequest = (requestId, response) => {
      const pending = pendingPipRequests.get(String(requestId));
      if (!pending) return;
      pendingPipRequests.delete(String(requestId));
      window.clearTimeout(pending.timer);
      if (response?.ok === false) pending.reject(new Error(response.error || "画中画操作失败"));
      else pending.resolve(response || { ok: true });
    };
    window.__codexPlusProResolveMultiPipRequest = resolveMultiPipRequest;

    const requestMultiPip = (action, threadId = pipThreadId) => new Promise((resolve, reject) => {
      if (typeof window[MULTI_PIP_BINDING] !== "function") {
        reject(new Error("Codex Plus Pro 多窗口控制器尚未连接"));
        return;
      }
      const requestId = Date.now().toString(36) + "-" + (nextPipRequestId++).toString(36);
      const timer = window.setTimeout(() => {
        pendingPipRequests.delete(requestId);
        reject(new Error("画中画操作超时"));
      }, 15000);
      pendingPipRequests.set(requestId, { resolve, reject, timer });
      try {
        window[MULTI_PIP_BINDING](JSON.stringify({ requestId, action, threadId }));
      } catch (error) {
        window.clearTimeout(timer);
        pendingPipRequests.delete(requestId);
        reject(error);
      }
    });

    const setPipWindowState = (state = {}) => {
      if (state.threadId) {
        pipThreadId = String(state.threadId);
        try { sessionStorage.setItem("codex-plus-pro-pip-thread-id", pipThreadId); } catch {}
        document.documentElement?.setAttribute(PIP_THREAD_ID_ATTRIBUTE, pipThreadId);
      }
      if (typeof state.pinned === "boolean") {
        pipWindowPinned = state.pinned;
        document.documentElement?.setAttribute("data-codex-plus-pip-always-on-top", state.pinned ? "on" : "off");
      }
      const pinToggle = document.querySelector(".codex-pokedex-pip-pin-toggle");
      if (pinToggle) {
        const pinned = pipWindowPinned ?? featureSettings.pipAlwaysOnTop;
        pinToggle.setAttribute("aria-pressed", pinned ? "true" : "false");
        pinToggle.setAttribute("aria-label", pinned ? "Disable always on top" : "Keep window on top");
        pinToggle.title = pinned ? "取消置顶" : "窗口置顶";
      }
      return { threadId: pipThreadId, pinned: pipWindowPinned };
    };
    window.__codexPlusProSetPipWindowState = setPipWindowState;
    const previousFlatPickerState = window.__codexPokedexFlatPickerState;
    if (previousFlatPickerState?.probeTimer) window.clearTimeout(previousFlatPickerState.probeTimer);
    const flatPickerState = previousFlatPickerState?.version === FLAT_PICKER_VERSION
      ? previousFlatPickerState
      : {
          version: FLAT_PICKER_VERSION,
          modelOptions: [...DEFAULT_MODEL_OPTIONS],
          effortOptions: [...DEFAULT_EFFORT_OPTIONS],
          availableEfforts: [],
          operationActive: false,
        };
    flatPickerState.operationActive = false;
    flatPickerState.effortOptions = [...DEFAULT_EFFORT_OPTIONS];
    window.__codexPokedexFlatPickerState = flatPickerState;

    const SETTINGS_SECTIONS = [
      { key: "theme", label: "主题", feature: "theme" },
      { key: "pet", label: "宠物", feature: "pet" },
      { key: "pip", label: "画中画", feature: "pip" },
      { key: "modelPicker", label: "模型栏", feature: "modelPicker" },
    ];
    const BOOLEAN_SETTINGS = new Set(["theme", "pet", "pip", "modelPicker", "pipAlwaysOnTop"]);

    const settingValueFromAttribute = (setting, rawValue) => (
      BOOLEAN_SETTINGS.has(setting) ? rawValue === "true" : rawValue
    );

    const createChoiceControl = (setting, options, extraClass = "") => {
      const control = document.createElement("div");
      control.className = "codex-plus-pro-settings-choices" + (extraClass ? " " + extraClass : "");
      for (const option of options) {
        const choice = document.createElement("button");
        choice.type = "button";
        choice.className = "codex-plus-pro-settings-choice";
        choice.setAttribute("data-codex-plus-setting", setting);
        choice.setAttribute("data-setting-value", String(option.value));
        choice.setAttribute("aria-pressed", "false");
        if (option.color) {
          choice.classList.add("codex-plus-pro-settings-color-choice");
          choice.style.setProperty("--settings-choice-color", option.color);
          const swatch = document.createElement("span");
          swatch.className = "codex-plus-pro-settings-swatch";
          swatch.setAttribute("aria-hidden", "true");
          choice.appendChild(swatch);
        }
        const label = document.createElement("span");
        label.textContent = option.label;
        choice.appendChild(label);
        choice.addEventListener("click", (event) => {
          event.stopPropagation();
          applyFeatureSettings({
            ...featureSettings,
            [setting]: settingValueFromAttribute(setting, String(option.value)),
          });
        });
        control.appendChild(choice);
      }
      return control;
    };

    const createSettingsRow = (labelText, control) => {
      const row = document.createElement("div");
      row.className = "codex-plus-pro-settings-row";
      const label = document.createElement("div");
      label.className = "codex-plus-pro-settings-label";
      label.textContent = labelText;
      row.append(label, control);
      return row;
    };

    const activateSettingsSection = (popover, sectionKey) => {
      for (const tab of popover.querySelectorAll("[data-settings-section-target]")) {
        const selected = tab.getAttribute("data-settings-section-target") === sectionKey;
        tab.setAttribute("aria-selected", selected ? "true" : "false");
        tab.tabIndex = selected ? 0 : -1;
      }
      for (const panel of popover.querySelectorAll("[data-settings-section]")) {
        panel.hidden = panel.getAttribute("data-settings-section") !== sectionKey;
      }
    };

    const updateSettingsPanel = () => {
      const button = document.querySelector(".codex-plus-pro-settings-button");
      const popover = document.querySelector(".codex-plus-pro-settings-popover");
      for (const choice of popover?.querySelectorAll("[data-codex-plus-setting]") || []) {
        const setting = choice.getAttribute("data-codex-plus-setting");
        const selected = String(featureSettings[setting]) === choice.getAttribute("data-setting-value");
        choice.setAttribute("aria-pressed", selected ? "true" : "false");
        choice.setAttribute("data-selected", selected ? "true" : "false");
      }
      for (const tab of popover?.querySelectorAll("[data-settings-feature]") || []) {
        const enabled = featureSettings[tab.getAttribute("data-settings-feature")] !== false;
        tab.setAttribute("data-enabled", enabled ? "true" : "false");
      }
      for (const panel of popover?.querySelectorAll("[data-settings-feature-panel]") || []) {
        const enabled = featureSettings[panel.getAttribute("data-settings-feature-panel")] !== false;
        panel.setAttribute("data-enabled", enabled ? "true" : "false");
      }
      const wallpaperRange = popover?.querySelector('[data-codex-plus-range="wallpaperStrength"]');
      if (wallpaperRange) wallpaperRange.value = String(featureSettings.wallpaperStrength);
      const wallpaperValue = popover?.querySelector('[data-codex-plus-range-value="wallpaperStrength"]');
      if (wallpaperValue) wallpaperValue.textContent = featureSettings.wallpaperStrength + "%";
      const customWallpaper = readCustomWallpaper();
      const customWallpaperChoice = popover?.querySelector('[data-codex-plus-setting="wallpaperMode"][data-setting-value="custom"]');
      if (customWallpaperChoice) customWallpaperChoice.disabled = !customWallpaper;
      const wallpaperPreview = popover?.querySelector(".codex-plus-pro-settings-wallpaper-preview");
      if (wallpaperPreview) {
        wallpaperPreview.style.backgroundImage = customWallpaper ? 'url(' + JSON.stringify(customWallpaper) + ')' : "";
        wallpaperPreview.setAttribute("data-has-wallpaper", customWallpaper ? "true" : "false");
      }
      if (popover) {
        const activeTab = popover.querySelector('[data-settings-section-target][aria-selected="true"]');
        if (!activeTab) activateSettingsSection(popover, "theme");
      }
      if (button && popover) button.setAttribute("aria-expanded", popover.hidden ? "false" : "true");
      const backdrop = document.querySelector(".codex-plus-pro-settings-backdrop");
      if (backdrop && popover) backdrop.hidden = popover.hidden;
    };

    const closeSettingsPopover = () => {
      const popover = document.querySelector(".codex-plus-pro-settings-popover");
      if (!popover || popover.hidden) return;
      popover.hidden = true;
      updateSettingsPanel();
      document.querySelector(".codex-plus-pro-settings-button")?.focus({ preventScroll: true });
    };

    const ensureSettingsPopover = () => {
      let popover = document.querySelector(".codex-plus-pro-settings-popover");
      if (popover && popover.getAttribute("data-settings-ui-version") !== SETTINGS_UI_VERSION) {
        popover.remove();
        document.querySelector(".codex-plus-pro-settings-backdrop")?.remove();
        popover = null;
      }
      if (popover) return popover;

      const backdrop = document.createElement("div");
      backdrop.className = "codex-plus-pro-settings-backdrop";
      backdrop.setAttribute("aria-hidden", "true");
      backdrop.hidden = true;
      popover = document.createElement("div");
      popover.className = "codex-plus-pro-settings-popover";
      popover.setAttribute("role", "dialog");
      popover.setAttribute("aria-modal", "true");
      popover.setAttribute("aria-label", "Codex Plus Pro 设置");
      popover.setAttribute("data-settings-ui-version", SETTINGS_UI_VERSION);
      popover.hidden = true;

      const header = document.createElement("div");
      header.className = "codex-plus-pro-settings-header";
      const heading = document.createElement("div");
      const title = document.createElement("div");
      title.className = "codex-plus-pro-settings-title";
      title.textContent = "Codex Plus Pro";
      const subtitle = document.createElement("div");
      subtitle.className = "codex-plus-pro-settings-subtitle";
      subtitle.textContent = "个性化";
      heading.append(title, subtitle);
      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "codex-plus-pro-settings-close";
      closeButton.setAttribute("aria-label", "关闭设置");
      closeButton.title = "关闭";
      closeButton.textContent = "×";
      closeButton.addEventListener("click", closeSettingsPopover);
      header.append(heading, closeButton);

      const body = document.createElement("div");
      body.className = "codex-plus-pro-settings-body";
      const navigation = document.createElement("div");
      navigation.className = "codex-plus-pro-settings-navigation";
      navigation.setAttribute("role", "tablist");
      navigation.setAttribute("aria-label", "设置分区");
      const content = document.createElement("div");
      content.className = "codex-plus-pro-settings-content";

      for (const item of SETTINGS_SECTIONS) {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "codex-plus-pro-settings-navigation-item";
        tab.id = "codex-plus-settings-tab-" + item.key;
        tab.setAttribute("role", "tab");
        tab.setAttribute("data-settings-section-target", item.key);
        tab.setAttribute("data-settings-feature", item.feature);
        tab.setAttribute("aria-controls", "codex-plus-settings-panel-" + item.key);
        tab.setAttribute("aria-selected", item.key === "theme" ? "true" : "false");
        tab.tabIndex = item.key === "theme" ? 0 : -1;
        const status = document.createElement("span");
        status.className = "codex-plus-pro-settings-status";
        status.setAttribute("aria-hidden", "true");
        const tabLabel = document.createElement("span");
        tabLabel.textContent = item.label;
        tab.append(status, tabLabel);
        tab.addEventListener("click", () => activateSettingsSection(popover, item.key));
        navigation.appendChild(tab);

        const panel = document.createElement("section");
        panel.className = "codex-plus-pro-settings-section";
        panel.id = "codex-plus-settings-panel-" + item.key;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", tab.id);
        panel.setAttribute("data-settings-section", item.key);
        panel.setAttribute("data-settings-feature-panel", item.feature);
        panel.hidden = item.key !== "theme";
        const panelTitle = document.createElement("h2");
        panelTitle.textContent = item.label;
        panel.appendChild(panelTitle);

        if (item.key === "theme") {
          panel.append(
            createSettingsRow("状态", createChoiceControl("theme", [
              { value: true, label: "启用" }, { value: false, label: "关闭" },
            ])),
            createSettingsRow("主题色", createChoiceControl("accent", Object.entries(ACCENT_OPTIONS).map(([value, option]) => ({
              value, label: option.label, color: option.color,
            })), "codex-plus-pro-settings-color-choices")),
          );
          const wallpaperControl = document.createElement("div");
          wallpaperControl.className = "codex-plus-pro-settings-wallpaper-control";
          const wallpaperPreview = document.createElement("div");
          wallpaperPreview.className = "codex-plus-pro-settings-wallpaper-preview";
          wallpaperPreview.setAttribute("aria-hidden", "true");
          const wallpaperActions = document.createElement("div");
          wallpaperActions.className = "codex-plus-pro-settings-wallpaper-actions";
          wallpaperActions.appendChild(createChoiceControl("wallpaperMode", [
            { value: "default", label: "默认壁纸" }, { value: "custom", label: "自定义壁纸" },
          ]));
          const uploadButton = document.createElement("button");
          uploadButton.type = "button";
          uploadButton.className = "codex-plus-pro-settings-upload";
          uploadButton.textContent = "上传图片";
          const wallpaperInput = document.createElement("input");
          wallpaperInput.type = "file";
          wallpaperInput.accept = "image/*";
          wallpaperInput.className = "codex-plus-pro-settings-file-input";
          const wallpaperStatus = document.createElement("span");
          wallpaperStatus.className = "codex-plus-pro-settings-wallpaper-status";
          wallpaperStatus.setAttribute("aria-live", "polite");
          uploadButton.addEventListener("click", () => wallpaperInput.click());
          wallpaperInput.addEventListener("change", async () => {
            const file = wallpaperInput.files?.[0];
            if (!file) return;
            wallpaperStatus.textContent = "处理中";
            try {
              const wallpaper = await prepareWallpaper(file);
              localStorage.setItem(CUSTOM_WALLPAPER_STORAGE_KEY, wallpaper);
              wallpaperStatus.textContent = "已更新";
              applyFeatureSettings({ ...featureSettings, wallpaperMode: "custom" });
            } catch (error) {
              wallpaperStatus.textContent = error?.message || "上传失败";
            } finally {
              wallpaperInput.value = "";
            }
          });
          wallpaperActions.append(uploadButton, wallpaperInput, wallpaperStatus);
          wallpaperControl.append(wallpaperPreview, wallpaperActions);
          panel.appendChild(createSettingsRow("壁纸", wallpaperControl));
          const rangeControl = document.createElement("div");
          rangeControl.className = "codex-plus-pro-settings-range-control";
          const range = document.createElement("input");
          range.type = "range";
          range.min = "0";
          range.max = "100";
          range.step = "1";
          range.setAttribute("aria-label", "壁纸强度");
          range.setAttribute("data-codex-plus-range", "wallpaperStrength");
          const output = document.createElement("output");
          output.setAttribute("data-codex-plus-range-value", "wallpaperStrength");
          range.addEventListener("input", (event) => {
            applyFeatureSettings({ ...featureSettings, wallpaperStrength: Number(event.currentTarget.value) });
          });
          rangeControl.append(range, output);
          panel.appendChild(createSettingsRow("壁纸强度", rangeControl));
        } else if (item.key === "pet") {
          panel.append(
            createSettingsRow("状态", createChoiceControl("pet", [
              { value: true, label: "显示" }, { value: false, label: "隐藏" },
            ])),
            createSettingsRow("动画", createChoiceControl("petMotion", [
              { value: "full", label: "完整" }, { value: "reduced", label: "减少" },
            ])),
          );
        } else if (item.key === "pip") {
          panel.append(
            createSettingsRow("状态", createChoiceControl("pip", [
              { value: true, label: "启用" }, { value: false, label: "关闭" },
            ])),
            createSettingsRow("窗口层级", createChoiceControl("pipAlwaysOnTop", [
              { value: true, label: "始终置顶" }, { value: false, label: "普通窗口" },
            ])),
          );
        } else {
          panel.append(
            createSettingsRow("状态", createChoiceControl("modelPicker", [
              { value: true, label: "显示" }, { value: false, label: "隐藏" },
            ])),
            createSettingsRow("控件密度", createChoiceControl("modelDensity", [
              { value: "compact", label: "紧凑" }, { value: "comfortable", label: "舒展" },
            ])),
          );
        }
        content.appendChild(panel);
      }
      body.append(navigation, content);

      const footer = document.createElement("div");
      footer.className = "codex-plus-pro-settings-footer";
      const resetButton = document.createElement("button");
      resetButton.type = "button";
      resetButton.className = "codex-plus-pro-settings-reset";
      resetButton.textContent = "恢复默认";
      resetButton.addEventListener("click", () => applyFeatureSettings({ ...DEFAULT_FEATURE_SETTINGS }));
      footer.appendChild(resetButton);
      popover.append(header, body, footer);
      document.body.append(backdrop, popover);
      updateSettingsPanel();
      return popover;
    };

    const decorateSettingsButton = () => {
      if (isAvatarOverlay || isHotkeyWindow) return;
      const searchButton = document.querySelector('button[aria-label="Search"]');
      const searchWrapper = searchButton?.parentElement;
      const host = searchWrapper?.parentElement;
      if (!searchButton || !searchWrapper || !host) return;
      host.setAttribute("data-codex-plus-pro-settings-host", "on");
      let button = host.querySelector(":scope > .codex-plus-pro-settings-button");
      if (button && button.getAttribute("data-settings-ui-version") !== SETTINGS_UI_VERSION) {
        button.remove();
        button = null;
      }
      if (!button) {
        button = document.createElement("button");
        button.type = "button";
        button.className = searchButton.className;
        button.classList.remove("ml-auto");
        button.classList.add("codex-plus-pro-settings-button");
        button.setAttribute("aria-label", "Codex Plus Pro 设置");
        button.setAttribute("aria-haspopup", "dialog");
        button.setAttribute("aria-expanded", "false");
        button.setAttribute("data-settings-ui-version", SETTINGS_UI_VERSION);
        button.title = "Codex Plus Pro";
        button.innerHTML = SETTINGS_ICON;
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          const popover = ensureSettingsPopover();
          popover.hidden = !popover.hidden;
          updateSettingsPanel();
          if (!popover.hidden) {
            window.requestAnimationFrame(() => popover.querySelector('[role="tab"][aria-selected="true"]')?.focus());
          }
        });
        host.insertBefore(button, searchWrapper);
      }
      ensureSettingsPopover();
      updateSettingsPanel();
    };

    window.__codexPlusProSettingsUiCleanup?.();
    const handleSettingsPointerDown = (event) => {
      if (
        event.target.closest?.(".codex-plus-pro-settings-popover") ||
        event.target.closest?.(".codex-plus-pro-settings-button")
      ) return;
      closeSettingsPopover();
    };
    const handleSettingsKeyDown = (event) => {
      if (event.key === "Escape") closeSettingsPopover();
    };
    document.addEventListener("pointerdown", handleSettingsPointerDown, true);
    document.addEventListener("keydown", handleSettingsKeyDown, true);
    window.__codexPlusProSettingsUiCleanup = () => {
      document.removeEventListener("pointerdown", handleSettingsPointerDown, true);
      document.removeEventListener("keydown", handleSettingsKeyDown, true);
    };

    const decorateHome = () => {
      const homeIcon = document.querySelector('[data-testid="home-icon"]');
      if (!homeIcon) return;
      const main = homeIcon.closest('[role="main"]');
      const panel = homeIcon.parentElement?.parentElement?.parentElement;
      main?.setAttribute(HOME_ATTRIBUTE, "on");
      panel?.setAttribute(HOME_PANEL_ATTRIBUTE, "on");
    };

    const extractPersistedThreadId = (row) => {
      const rawId = row.getAttribute("data-app-action-sidebar-thread-id") || "";
      if (rawId.includes("client-new-thread:")) return null;
      return rawId.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1] || null;
    };

    const findActionBar = (row) => {
      const reference = Array.from(row.querySelectorAll("button")).find((button) => {
        const label = (button.getAttribute("aria-label") || "").toLowerCase();
        return label.includes("pin") || label.includes("archive");
      });
      if (!reference) return null;

      let candidate = reference.parentElement;
      while (candidate && candidate !== row) {
        const directButtons = Array.from(candidate.children).filter((child) => child.tagName === "BUTTON");
        if (directButtons.length >= 2 || candidate.classList.contains("absolute")) {
          return { actionBar: candidate, reference };
        }
        candidate = candidate.parentElement;
      }
      return null;
    };

    const findHotkeyServices = (moduleNamespace) => {
      const queue = [{ value: moduleNamespace, depth: 0 }];
      const seen = new Set();
      while (queue.length > 0) {
        const { value, depth } = queue.shift();
        if ((typeof value !== "object" && typeof value !== "function") || value == null || seen.has(value)) continue;
        seen.add(value);
        if (typeof value.hotkeyWindowHotkeys?.open === "function") return value;
        if (depth >= 2) continue;
        let nestedValues = [];
        try {
          nestedValues = Object.values(value);
        } catch {
          continue;
        }
        for (const nested of nestedValues) queue.push({ value: nested, depth: depth + 1 });
      }
      return null;
    };

    const loadHotkeyServices = async () => {
      if (window.__codexPokedexHotkeyServices?.hotkeyWindowHotkeys?.open) {
        return window.__codexPokedexHotkeyServices;
      }
      if (hotkeyServicesPromise) return hotkeyServicesPromise;

      hotkeyServicesPromise = (async () => {
        const scriptUrls = Array.from(document.scripts, (script) => script.src).filter(Boolean);
        const resourceUrls = performance.getEntriesByType("resource").map((entry) => entry.name);
        const entryUrl = [...scriptUrls, ...resourceUrls].find((url) => /\\/assets\\/index-[^/]+\\.js(?:\\?|$)/.test(url));
        if (!entryUrl) throw new Error("Codex entry module was not found");

        const entrySource = await fetch(entryUrl).then((response) => {
          if (!response.ok) throw new Error("Unable to read Codex entry module");
          return response.text();
        });
        const modulePaths = Array.from(entrySource.matchAll(/["'](\\.\\/[^"']+\\.js)["']/g), (match) => match[1]);
        const likelyPaths = [...new Set(modulePaths.filter((modulePath) =>
          modulePath.toLowerCase().includes("app-initial") ||
          modulePath.includes("app-initial~avatarOverlayCompositionSurface~artifact-tab-content.electron~notebook-preview-~") ||
          modulePath.toLowerCase().includes("hotkey-window")
        ))];

        for (const modulePath of likelyPaths) {
          try {
            const namespace = await import(new URL(modulePath, entryUrl).href);
            const services = findHotkeyServices(namespace);
            if (services) {
              window.__codexPokedexHotkeyServices = services;
              return services;
            }
          } catch (error) {
            console.debug("Codex Plus Pro skipped a private module", modulePath, error);
          }
        }
        throw new Error("Codex Popout service was not found");
      })().catch((error) => {
        hotkeyServicesPromise = null;
        throw error;
      });

      return hotkeyServicesPromise;
    };

    const openOfficialPip = async (threadId) => {
      const services = await loadHotkeyServices();
      await services.hotkeyWindowHotkeys.open({ path: "/hotkey-window/thread/" + threadId });
      return { opened: true };
    };
    window.__codexPlusProOpenOfficialPip = openOfficialPip;

    const openThreadInPip = async (threadId) => {
      await requestMultiPip("open-thread", threadId);
    };

    const removeSidebarPipEnhancements = () => {
      for (const button of document.querySelectorAll(".codex-pokedex-pip-row-button")) button.remove();
      for (const actionBar of document.querySelectorAll("[data-codex-pokedex-pip-actions]")) {
        actionBar.removeAttribute("data-codex-pokedex-pip-actions");
      }
    };

    const decorateSidebarRows = () => {
      if (isAvatarOverlay || isHotkeyWindow || !featureSettings.pip) return;
      for (const row of document.querySelectorAll("[data-app-action-sidebar-thread-row]")) {
        const threadId = extractPersistedThreadId(row);
        if (!threadId || row.querySelector(":scope .codex-pokedex-pip-row-button")) continue;
        const actionElements = findActionBar(row);
        if (!actionElements) continue;

        const { actionBar, reference } = actionElements;
        const button = document.createElement("button");
        button.type = "button";
        button.className = reference.className;
        button.classList.add("codex-pokedex-pip-row-button");
        button.setAttribute("aria-label", "Open in picture-in-picture");
        button.title = "画中画监控";
        button.innerHTML = PIP_ICON;
        button.addEventListener("pointerdown", (event) => {
          event.preventDefault();
          event.stopPropagation();
        });
        button.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (button.getAttribute("aria-busy") === "true") return;
          button.setAttribute("aria-busy", "true");
          try {
            await openThreadInPip(threadId);
          } catch (error) {
            console.error("Codex Plus Pro could not open the task in picture-in-picture", error);
            button.setAttribute("data-codex-pokedex-pip-error", "on");
            button.title = "画中画打开失败，请重新启动 Codex Plus Pro";
            window.setTimeout(() => button.removeAttribute("data-codex-pokedex-pip-error"), 1800);
          } finally {
            button.removeAttribute("aria-busy");
          }
        });
        actionBar.setAttribute("data-codex-pokedex-pip-actions", "on");
        actionBar.insertBefore(button, actionBar.firstChild);
      }
    };

    const waitForPageCondition = (predicate, timeout = 1200) => new Promise((resolve, reject) => {
      const startedAt = performance.now();
      const check = () => {
        const result = predicate();
        if (result) {
          resolve(result);
          return;
        }
        if (performance.now() - startedAt >= timeout) {
          reject(new Error("Timed out waiting for Codex to update the model settings"));
          return;
        }
        window.setTimeout(check, 16);
      };
      check();
    });

    const modelLabelFromOption = (option) => {
      const label = String(option?.displayName || option?.model || "")
        .replace(/^GPT-/i, "")
        .replaceAll("-", " ")
        .replace(/\s+/g, " ")
        .trim();
      return label || String(option?.model || "");
    };

    const findModelPickerInterface = (trigger) => {
      const fiberKey = Object.keys(trigger || {}).find((key) => key.startsWith("__reactFiber$"));
      let fiber = fiberKey ? trigger[fiberKey] : null;
      for (let depth = 0; fiber && depth < 80; depth += 1, fiber = fiber.return) {
        const props = fiber.memoizedProps;
        if (
          Array.isArray(props?.models) &&
          typeof props.onSelectModel === "function" &&
          typeof props.onSelectReasoningEffort === "function"
        ) {
          return props;
        }
      }
      return null;
    };

    const syncFlatPickerOptions = (picker) => {
      if (!picker) return;
      const modelOptions = picker.models.map(modelLabelFromOption).filter(Boolean);
      if (modelOptions.length > 0) flatPickerState.modelOptions = modelOptions;
      const selectedModel = picker.models.find((option) => option.model === picker.model);
      flatPickerState.availableEfforts = (selectedModel?.supportedReasoningEfforts || [])
        .map((option) => EFFORT_LABEL_BY_CODE[option.reasoningEffort])
        .filter(Boolean);
    };

    const shortModelLabel = (model) => {
      if (model === "5.3 Codex Spark") return "Spark";
      if (model.startsWith("5.6 ")) return model.slice(4);
      return model;
    };

    const shortEffortLabel = (effort) => ({
      Light: "Light",
      Medium: "Med",
      High: "High",
      "Extra High": "XHigh",
      Max: "Max",
      Ultra: "Ultra",
    })[effort] || effort;

    const readPickerSelection = (trigger, picker = findModelPickerInterface(trigger)) => {
      if (picker) {
        const selectedModel = picker.models.find((option) => option.model === picker.model);
        const fastTier = picker.serviceTierOptions?.find((option) => option.iconKind === "fast");
        return {
          model: modelLabelFromOption(selectedModel) || picker.model,
          effort: EFFORT_LABEL_BY_CODE[picker.reasoningEffort] || picker.reasoningEffort,
          fast: fastTier != null && picker.selectedServiceTier === fastTier.value,
        };
      }
      const visibleContent = Array.from(trigger?.children || []).find((child) =>
        child.tagName !== "svg" && child.getAttribute("aria-hidden") !== "true"
      );
      const modelText = visibleContent
        ?.querySelector('[class*="ModelPickerTriggerModelText"]')
        ?.textContent
        ?.trim();
      const effortText = visibleContent
        ?.querySelector('[class*="ModelPickerTriggerEffortLabel"]')
        ?.textContent
        ?.trim();
      const visibleText = visibleContent?.textContent?.trim() || "";
      const knownModel = [...flatPickerState.modelOptions]
        .sort((left, right) => right.length - left.length)
        .find((model) => visibleText.startsWith(model));
      const effortCode = trigger?.getAttribute("data-selected-reasoning-effort") || "";
      return {
        model: modelText || knownModel || flatPickerState.modelOptions[0],
        effort: EFFORT_LABEL_BY_CODE[effortCode] || effortText || "",
        fast: Boolean(
          trigger?.querySelector('[class*="InlineFastIcon"]') ||
          visibleContent?.querySelector("svg")
        ),
      };
    };

    const createFlatPickerGroup = (kind, options) => {
      const group = document.createElement("div");
      group.className = "codex-pokedex-flat-picker-group";
      group.setAttribute("data-flat-picker-group", kind);

      const segments = document.createElement("div");
      segments.className = "codex-pokedex-flat-picker-segments";
      if (kind !== "speed") {
        segments.setAttribute("role", "radiogroup");
        segments.setAttribute("aria-label", kind === "model" ? "模型" : "思考强度");
      }

      for (const option of options) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "codex-pokedex-flat-picker-option";
        button.setAttribute("data-flat-picker-kind", kind);
        button.setAttribute("data-flat-picker-value", option);
        if (kind === "model") {
          button.textContent = shortModelLabel(option);
          button.title = "模型：" + option;
          button.setAttribute("role", "radio");
        } else if (kind === "effort") {
          button.textContent = shortEffortLabel(option);
          button.title = "思考强度：" + option;
          button.setAttribute("role", "radio");
        } else {
          const text = document.createElement("span");
          text.textContent = "Fast";
          const track = document.createElement("span");
          track.className = "codex-pokedex-flat-picker-switch-track";
          track.setAttribute("aria-hidden", "true");
          const thumb = document.createElement("span");
          thumb.className = "codex-pokedex-flat-picker-switch-thumb";
          track.appendChild(thumb);
          button.append(text, track);
          button.title = "快速模式";
          button.setAttribute("role", "switch");
          button.setAttribute("aria-label", "快速模式");
          button.setAttribute("aria-checked", "false");
        }
        segments.appendChild(button);
      }
      group.appendChild(segments);
      return group;
    };

    const renderFlatPickerStructure = (bar) => {
      const signature = JSON.stringify({
        models: flatPickerState.modelOptions,
        efforts: flatPickerState.effortOptions,
      });
      if (bar.getAttribute("data-flat-picker-signature") === signature) return;
      bar.replaceChildren(
        createFlatPickerGroup("model", flatPickerState.modelOptions),
        createFlatPickerGroup("effort", flatPickerState.effortOptions),
        createFlatPickerGroup("speed", ["Fast"]),
      );
      bar.setAttribute("data-flat-picker-signature", signature);
    };

    const updateFlatPicker = (bar, trigger, surface) => {
      if (!bar || !trigger || !surface) return;
      const picker = findModelPickerInterface(trigger);
      syncFlatPickerOptions(picker);
      renderFlatPickerStructure(bar);
      const selection = readPickerSelection(trigger, picker);
      const running = surface.querySelector('button[aria-label="Stop"]') != null;
      const globallyDisabled = running || trigger.disabled || flatPickerState.operationActive || picker == null;
      const fastTier = picker?.serviceTierOptions?.find((option) => option.iconKind === "fast");

      bar.setAttribute("data-flat-picker-model", selection.model);
      bar.setAttribute("data-flat-picker-effort", selection.effort);
      bar.setAttribute("data-flat-picker-fast", selection.fast ? "on" : "off");
      bar.setAttribute("data-flat-picker-disabled", globallyDisabled ? "on" : "off");
      bar.setAttribute("aria-busy", flatPickerState.operationActive ? "true" : "false");

      for (const button of bar.querySelectorAll("button[data-flat-picker-kind]")) {
        const kind = button.getAttribute("data-flat-picker-kind");
        const value = button.getAttribute("data-flat-picker-value");
        let selected = false;
        let unavailable = false;

        if (kind === "model") {
          selected = value === selection.model;
          button.setAttribute("aria-checked", selected ? "true" : "false");
        } else if (kind === "effort") {
          selected = value === selection.effort;
          unavailable = !flatPickerState.availableEfforts.includes(value) && !selected;
          button.setAttribute("aria-checked", selected ? "true" : "false");
          button.title = unavailable ? "当前模型不支持该思考强度" : "思考强度：" + value;
        } else {
          selected = selection.fast;
          unavailable = fastTier == null || typeof picker?.onSelectServiceTier !== "function";
          button.setAttribute("aria-checked", selected ? "true" : "false");
        }

        button.setAttribute("data-selected", selected ? "true" : "false");
        button.setAttribute("data-unavailable", unavailable ? "true" : "false");
        button.disabled = globallyDisabled || unavailable;
      }
    };

    const withModelPickerInterface = async (surface, callback) => {
      if (flatPickerState.operationActive) throw new Error("Another picker operation is active");
      flatPickerState.operationActive = true;
      const bar = surface.querySelector(".codex-pokedex-flat-picker");
      updateFlatPicker(bar, surface.querySelector('button[data-codex-intelligence-trigger="true"]'), surface);
      try {
        const trigger = surface.querySelector('button[data-codex-intelligence-trigger="true"]');
        const picker = findModelPickerInterface(trigger);
        if (!picker) throw new Error("Codex model settings interface was not found");
        return await callback(picker);
      } finally {
        flatPickerState.operationActive = false;
        const liveTrigger = surface.querySelector('button[data-codex-intelligence-trigger="true"]');
        updateFlatPicker(bar, liveTrigger, surface);
      }
    };

    const selectFlatPickerOption = async (surface, kind, value) => {
      await withModelPickerInterface(surface, async (picker) => {
        if (kind === "Model") {
          const target = picker.models.find((option) => modelLabelFromOption(option) === value);
          if (!target) throw new Error("Option unavailable: Model " + value);
          const supportedEfforts = target.supportedReasoningEfforts || [];
          const effort = supportedEfforts.some((option) => option.reasoningEffort === picker.reasoningEffort)
            ? picker.reasoningEffort
            : target.defaultReasoningEffort;
          picker.onSelectModel(target.model, effort);
          await waitForPageCondition(() => {
            const live = findModelPickerInterface(
              surface.querySelector('button[data-codex-intelligence-trigger="true"]')
            );
            return live?.model === target.model && live?.reasoningEffort === effort;
          });
          return;
        }

        if (kind === "Effort") {
          const model = picker.models.find((option) => option.model === picker.model);
          const target = model?.supportedReasoningEfforts?.find((option) =>
            EFFORT_LABEL_BY_CODE[option.reasoningEffort] === value
          );
          if (!target) throw new Error("Option unavailable: Effort " + value);
          picker.onSelectReasoningEffort(target.reasoningEffort);
          await waitForPageCondition(() => {
            const live = findModelPickerInterface(
              surface.querySelector('button[data-codex-intelligence-trigger="true"]')
            );
            return live?.reasoningEffort === target.reasoningEffort;
          });
          return;
        }

        const fastTier = picker.serviceTierOptions?.find((option) => option.iconKind === "fast");
        const standardTier = picker.serviceTierOptions?.find((option) => option.iconKind == null);
        if (!fastTier || typeof picker.onSelectServiceTier !== "function") {
          throw new Error("Option unavailable: Speed Fast");
        }
        const target = picker.selectedServiceTier === fastTier.value ? standardTier?.value ?? null : fastTier.value;
        picker.onSelectServiceTier(target);
        await waitForPageCondition(() => {
          const live = findModelPickerInterface(
            surface.querySelector('button[data-codex-intelligence-trigger="true"]')
          );
          return live?.selectedServiceTier === target;
        });
      });
    };

    const handleFlatPickerClick = async (event) => {
      const button = event.target.closest("button[data-flat-picker-kind]");
      if (!button || button.disabled) return;
      const bar = button.closest(".codex-pokedex-flat-picker");
      const surface = bar?.closest(".composer-surface-chrome");
      if (!surface) return;
      const kindValue = button.getAttribute("data-flat-picker-kind");
      const nativeKind = kindValue === "model" ? "Model" : kindValue === "effort" ? "Effort" : "Speed";
      const value = button.getAttribute("data-flat-picker-value");
      if (nativeKind !== "Speed" && button.getAttribute("data-selected") === "true") return;

      bar.setAttribute("data-flat-picker-working", "on");
      try {
        await selectFlatPickerOption(surface, nativeKind, value);
        surface.removeAttribute(FLAT_PICKER_FAILURE_ATTRIBUTE);
        const liveTrigger = surface.querySelector('button[data-codex-intelligence-trigger="true"]');
        updateFlatPicker(bar, liveTrigger, surface);
      } catch (error) {
        console.error("Codex Plus Pro flat picker operation failed", error);
        const message = String(error?.message || error);
        if (message.startsWith("Option unavailable:")) {
          const liveButton = Array.from(bar.querySelectorAll("button[data-flat-picker-kind]")).find((candidate) =>
            candidate.getAttribute("data-flat-picker-kind") === kindValue &&
            candidate.getAttribute("data-flat-picker-value") === value
          );
          if (liveButton) {
            liveButton.disabled = true;
            liveButton.setAttribute("data-unavailable", "true");
            liveButton.title = "当前模型不支持该选项";
          }
        } else if (message !== "Another picker operation is active") {
          const failures = Number(surface.getAttribute(FLAT_PICKER_FAILURE_ATTRIBUTE) || 0) + 1;
          surface.setAttribute(FLAT_PICKER_FAILURE_ATTRIBUTE, String(failures));
          bar.setAttribute("data-flat-picker-error", "on");
          window.setTimeout(() => bar.removeAttribute("data-flat-picker-error"), 900);
        }
      } finally {
        bar.removeAttribute("data-flat-picker-working");
      }
    };

    const decorateFlatPicker = () => {
      if (isAvatarOverlay || isHotkeyWindow || !featureSettings.modelPicker) return;
      for (const trigger of document.querySelectorAll('button[data-codex-intelligence-trigger="true"]')) {
        const surface = trigger.closest(".composer-surface-chrome");
        if (!surface) continue;
        surface.removeAttribute(FLAT_PICKER_FALLBACK_ATTRIBUTE);
        let bar = surface.querySelector(".codex-pokedex-flat-picker");
        if (bar && bar.getAttribute("data-flat-picker-version") !== FLAT_PICKER_VERSION) {
          bar.remove();
          bar = null;
        }
        if (!bar) {
          bar = document.createElement("div");
          bar.className = "codex-pokedex-flat-picker";
          bar.setAttribute("data-flat-picker-version", FLAT_PICKER_VERSION);
          bar.addEventListener("click", handleFlatPickerClick);
          surface.appendChild(bar);
        }
        document.documentElement.setAttribute(FLAT_PICKER_ATTRIBUTE, "on");
        surface.setAttribute(FLAT_PICKER_SURFACE_ATTRIBUTE, "on");
        updateFlatPicker(bar, trigger, surface);
      }
    };

    const removeFlatPicker = () => {
      document.documentElement.removeAttribute(FLAT_PICKER_ATTRIBUTE);
      for (const bar of document.querySelectorAll(".codex-pokedex-flat-picker")) bar.remove();
      for (const surface of document.querySelectorAll("[" + FLAT_PICKER_SURFACE_ATTRIBUTE + "]")) {
        surface.removeAttribute(FLAT_PICKER_SURFACE_ATTRIBUTE);
        surface.removeAttribute(FLAT_PICKER_FAILURE_ATTRIBUTE);
      }
    };

    const openPipComposer = (focusComposer = false) => {
      if (!featureSettings.pip) return;
      const root = document.documentElement;
      if (root.getAttribute(PIP_WINDOW_ATTRIBUTE) !== "thread") return;
      window.clearTimeout(pipCloseTimer);
      root.setAttribute(PIP_COMPOSER_OPEN_ATTRIBUTE, "on");
      if (focusComposer) {
        window.setTimeout(() => document.querySelector('[data-codex-composer="true"]')?.focus(), 80);
      }
    };

    const closePipComposer = (force = false) => {
      if (document.documentElement.getAttribute(PIP_WINDOW_ATTRIBUTE) !== "thread") return;
      window.clearTimeout(pipCloseTimer);
      pipCloseTimer = window.setTimeout(() => {
        const wrapper = document.querySelector("[" + PIP_COMPOSER_ATTRIBUTE + "]");
        if (!force && wrapper?.contains(document.activeElement)) return;
        document.documentElement.setAttribute(PIP_COMPOSER_OPEN_ATTRIBUTE, "off");
      }, force ? 0 : 180);
    };

    const ensurePipControls = (returnButton) => {
      if (!featureSettings.pip) return;
      if (!document.body) return;
      const titleActions = returnButton?.parentElement?.parentElement;
      let pinToggle = document.querySelector(".codex-pokedex-pip-pin-toggle");
      if (!pinToggle && titleActions) {
        pinToggle = document.createElement("button");
        pinToggle.type = "button";
        pinToggle.innerHTML = PIN_ICON;
        pinToggle.addEventListener("pointerover", (event) => event.stopPropagation());
        pinToggle.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (pinToggle.getAttribute("aria-busy") === "true") return;
          pinToggle.setAttribute("aria-busy", "true");
          try {
            setPipWindowState(await requestMultiPip("toggle-pin-current"));
          } catch (error) {
            console.error("Codex Plus Pro could not change this window's pin state", error);
          } finally {
            pinToggle.removeAttribute("aria-busy");
          }
        });
        titleActions.insertBefore(pinToggle, titleActions.firstChild);
      }
      if (pinToggle && titleActions) {
        if (pinToggle.parentElement !== titleActions) {
          titleActions.insertBefore(pinToggle, titleActions.firstChild);
        }
        pinToggle.className = returnButton.className;
        pinToggle.classList.add("codex-pokedex-pip-pin-toggle");
        const pinned = pipWindowPinned ?? featureSettings.pipAlwaysOnTop;
        pinToggle.setAttribute("aria-pressed", pinned ? "true" : "false");
        pinToggle.setAttribute("aria-label", pinned ? "Disable always on top" : "Keep window on top");
        pinToggle.title = pinned ? "取消置顶" : "窗口置顶";
      }

      let handle = document.querySelector(".codex-pokedex-pip-composer-handle");
      if (!handle) {
        handle = document.createElement("button");
        handle.type = "button";
        handle.className = "codex-pokedex-pip-composer-handle";
        handle.setAttribute("aria-label", "Write a follow-up");
        handle.title = "输入跟进";
        handle.innerHTML = MESSAGE_ICON;
        handle.addEventListener("pointerenter", () => openPipComposer(false));
        handle.addEventListener("click", () => openPipComposer(true));
        document.body.appendChild(handle);
      }

      let stopProxy = document.querySelector(".codex-pokedex-pip-stop-proxy");
      if (!stopProxy) {
        stopProxy = document.createElement("button");
        stopProxy.type = "button";
        stopProxy.className = "codex-pokedex-pip-stop-proxy";
        stopProxy.setAttribute("aria-label", "Stop task");
        stopProxy.title = "停止任务";
        stopProxy.innerHTML = STOP_ICON;
        stopProxy.addEventListener("click", () => {
          const originalStop = document.querySelector('[data-codex-pokedex-pip-composer] button[aria-label="Stop"]');
          originalStop?.click();
        });
        document.body.appendChild(stopProxy);
      }
    };

    const decoratePipWindow = () => {
      if (!featureSettings.pip || !isHotkeyWindow || !document.documentElement) return;
      const root = document.documentElement;
      const returnButton = document.querySelector('button[aria-label="Open in Main Window"]');
      const composer = document.querySelector('[data-codex-composer="true"]');
      const composerSurface = composer?.closest(".composer-surface-chrome");
      const composerWrapper = composerSurface?.parentElement;
      const isThreadPip = Boolean(returnButton && composerWrapper);

      if (!isThreadPip) {
        root.setAttribute(PIP_WINDOW_ATTRIBUTE, "home");
        root.setAttribute(PIP_COMPOSER_OPEN_ATTRIBUTE, "off");
        document.querySelectorAll("[" + PIP_COMPOSER_ATTRIBUTE + "]").forEach((element) => {
          element.removeAttribute(PIP_COMPOSER_ATTRIBUTE);
        });
        return;
      }

      root.setAttribute(PIP_WINDOW_ATTRIBUTE, "thread");
      if (!root.hasAttribute(PIP_COMPOSER_OPEN_ATTRIBUTE)) {
        root.setAttribute(PIP_COMPOSER_OPEN_ATTRIBUTE, "off");
      }
      document.querySelectorAll("[" + PIP_COMPOSER_ATTRIBUTE + "]").forEach((element) => {
        if (element !== composerWrapper) element.removeAttribute(PIP_COMPOSER_ATTRIBUTE);
      });
      composerWrapper.setAttribute(PIP_COMPOSER_ATTRIBUTE, "on");
      ensurePipControls(returnButton);
    };

    const removePipWindowEnhancements = () => {
      const root = document.documentElement;
      root.removeAttribute(PIP_WINDOW_ATTRIBUTE);
      root.removeAttribute(PIP_COMPOSER_OPEN_ATTRIBUTE);
      for (const element of document.querySelectorAll("[" + PIP_COMPOSER_ATTRIBUTE + "]")) {
        element.removeAttribute(PIP_COMPOSER_ATTRIBUTE);
      }
      document.querySelector(".codex-pokedex-pip-composer-handle")?.remove();
      document.querySelector(".codex-pokedex-pip-stop-proxy")?.remove();
      document.querySelector(".codex-pokedex-pip-pin-toggle")?.remove();
    };

    window.__codexPokedexPipHoverCleanup?.();
    const handlePipPointer = () => openPipComposer(false);
    const handlePipLeave = () => closePipComposer(false);
    const handlePipBlur = () => closePipComposer(true);
    window.addEventListener("pointerover", handlePipPointer, { passive: true });
    document.documentElement?.addEventListener("mouseleave", handlePipLeave);
    window.addEventListener("blur", handlePipBlur);
    window.__codexPokedexPipHoverCleanup = () => {
      window.removeEventListener("pointerover", handlePipPointer);
      document.documentElement?.removeEventListener("mouseleave", handlePipLeave);
      window.removeEventListener("blur", handlePipBlur);
    };

    window.__codexPokedexPipTitleCleanup?.();
    const handlePipTitleAction = (event) => {
      if (!isHotkeyWindow) return;
      const button = event.target.closest?.("button");
      if (button?.getAttribute("aria-label") !== "Dismiss Popout Window") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void requestMultiPip("close-current").catch((error) => {
        console.error("Codex Plus Pro could not close this Popout window", error);
      });
    };
    document.addEventListener("click", handlePipTitleAction, true);
    window.__codexPokedexPipTitleCleanup = () => {
      document.removeEventListener("click", handlePipTitleAction, true);
    };

    window.__codexPokedexActivityChannel?.close();
    const activityChannel = new BroadcastChannel(ACTIVITY_CHANNEL_NAME);
    window.__codexPokedexActivityChannel = activityChannel;
    window.__codexPlusProSettingsChannel?.close();
    const settingsChannel = new BroadcastChannel(SETTINGS_CHANNEL_NAME);
    window.__codexPlusProSettingsChannel = settingsChannel;
    const postChannelMessage = (channel, message) => {
      try {
        channel.postMessage(message);
        return true;
      } catch (error) {
        if (error?.name === "InvalidStateError") return false;
        throw error;
      }
    };

    const publishTaskState = () => {
      if (isAvatarOverlay) return;
      const running = document.querySelector('button[aria-label="Stop"]') != null;
      document.documentElement.setAttribute(TASK_RUNNING_ATTRIBUTE, running ? "on" : "off");
      postChannelMessage(activityChannel, { type: "task-state", running });
    };

    activityChannel.addEventListener("message", (event) => {
      if (event.data?.type === "task-state-request" && !isAvatarOverlay) {
        publishTaskState();
      } else if (event.data?.type === "task-state" && isAvatarOverlay) {
        document.documentElement.setAttribute(
          TASK_RUNNING_ATTRIBUTE,
          event.data.running ? "on" : "off",
        );
      }
    });

    const applyFeatureSettings = (nextSettings, options = {}) => {
      const { persist = true, broadcast = true, notify = true } = options;
      featureSettings = normalizeFeatureSettings(nextSettings);
      if (persist) {
        try {
          localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(featureSettings));
        } catch (error) {
          console.warn("Codex Plus Pro could not persist settings", error);
        }
      }
      if (!document.documentElement) return;
      const root = document.documentElement;
      for (const [key, attribute] of Object.entries(FEATURE_ATTRIBUTES)) {
        root.setAttribute(attribute, featureSettings[key] ? "on" : "off");
      }
      const accent = ACCENT_OPTIONS[featureSettings.accent] || ACCENT_OPTIONS.pokedex;
      const wallpaperRatio = featureSettings.wallpaperStrength / 100;
      root.setAttribute("data-codex-plus-accent", featureSettings.accent);
      root.setAttribute("data-codex-plus-pet-motion", featureSettings.petMotion);
      root.setAttribute("data-codex-plus-model-density", featureSettings.modelDensity);
      const effectivePipPinned = isHotkeyWindow && pipWindowPinned != null
        ? pipWindowPinned
        : featureSettings.pipAlwaysOnTop;
      root.setAttribute("data-codex-plus-pip-always-on-top", effectivePipPinned ? "on" : "off");
      if (isHotkeyWindow && pipThreadId) root.setAttribute(PIP_THREAD_ID_ATTRIBUTE, pipThreadId);
      root.style.setProperty("--codex-plus-accent", accent.color);
      root.style.setProperty("--codex-plus-accent-dark", accent.dark);
      root.style.setProperty("--codex-plus-highlight", accent.highlight);
      root.style.setProperty("--codex-plus-wallpaper-wash-start", String(1 - 0.015 * wallpaperRatio));
      root.style.setProperty("--codex-plus-wallpaper-wash-mid", String(1 - 0.06 * wallpaperRatio));
      root.style.setProperty("--codex-plus-wallpaper-wash-late", String(1 - 0.25 * wallpaperRatio));
      root.style.setProperty("--codex-plus-wallpaper-wash-end", String(1 - 0.49 * wallpaperRatio));
      const customWallpaper = featureSettings.wallpaperMode === "custom" ? readCustomWallpaper() : "";
      if (customWallpaper) {
        root.style.setProperty("--codex-pokedex-wallpaper", "url(" + JSON.stringify(customWallpaper) + ")");
      } else {
        root.style.removeProperty("--codex-pokedex-wallpaper");
      }
      if (!isAvatarOverlay && featureSettings.theme) {
        root.setAttribute(THEME_ATTRIBUTE, "on");
      } else {
        root.removeAttribute(THEME_ATTRIBUTE);
      }
      if (isAvatarOverlay && featureSettings.pet) root.setAttribute(OVERLAY_ATTRIBUTE, "on");
      else root.removeAttribute(OVERLAY_ATTRIBUTE);
      if (!isHotkeyWindow) {
        root.removeAttribute(PIP_WINDOW_ATTRIBUTE);
        root.removeAttribute(PIP_COMPOSER_OPEN_ATTRIBUTE);
      }
      let style = document.getElementById(STYLE_ID);
      if (!style) {
        style = document.createElement("style");
        style.id = STYLE_ID;
        (document.head || document.documentElement).appendChild(style);
      }
      if (style.textContent !== css) style.textContent = css;
      if (!isAvatarOverlay) {
        decorateSettingsButton();
        if (featureSettings.theme) decorateHome();
        else {
          document.querySelector("[" + HOME_ATTRIBUTE + "]")?.removeAttribute(HOME_ATTRIBUTE);
          document.querySelector("[" + HOME_PANEL_ATTRIBUTE + "]")?.removeAttribute(HOME_PANEL_ATTRIBUTE);
        }
        if (featureSettings.pip) {
          decorateSidebarRows();
          decoratePipWindow();
        } else {
          removeSidebarPipEnhancements();
          removePipWindowEnhancements();
        }
        if (featureSettings.modelPicker) decorateFlatPicker();
        else removeFlatPicker();
      }
      updateSettingsPanel();
      publishTaskState();
      window.__codexPlusProFeatureSettings = { ...featureSettings };
      window.__codexPlusProApplySettings = (value) => applyFeatureSettings(value, {
        persist: true,
        broadcast: false,
        notify: true,
      });
      if (broadcast) postChannelMessage(settingsChannel, featureSettings);
      if (notify && typeof window[SETTINGS_BINDING] === "function") {
        window[SETTINGS_BINDING](JSON.stringify(featureSettings));
      }
    };

    settingsChannel.addEventListener("message", (event) => {
      applyFeatureSettings(event.data, { persist: true, broadcast: false, notify: true });
    });

    const refreshDecorations = () => {
      refreshFrame = 0;
      if (!isAvatarOverlay) {
        decorateSettingsButton();
        if (featureSettings.theme) decorateHome();
        if (featureSettings.pip) {
          decorateSidebarRows();
          decoratePipWindow();
        }
        if (featureSettings.modelPicker) decorateFlatPicker();
      }
      publishTaskState();
    };

    const scheduleRefresh = () => {
      if (refreshFrame) return;
      refreshFrame = window.requestAnimationFrame(refreshDecorations);
    };

    applyFeatureSettings(featureSettings, { persist: false, broadcast: false, notify: true });
    window.__codexPokedexThemeObserver?.disconnect();
    window.__codexPokedexThemeObserver = new MutationObserver(() => {
      if (!document.getElementById(STYLE_ID)) {
        applyFeatureSettings(featureSettings, { persist: false, broadcast: false, notify: false });
      } else {
        scheduleRefresh();
      }
    });
    window.__codexPokedexThemeObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [THEME_ATTRIBUTE, OVERLAY_ATTRIBUTE, ...Object.values(FEATURE_ATTRIBUTES)],
    });
    if (isAvatarOverlay) postChannelMessage(activityChannel, { type: "task-state-request" });
    const cleanupRuntime = () => {
      if (refreshFrame) {
        window.cancelAnimationFrame(refreshFrame);
        refreshFrame = 0;
      }
      window.__codexPokedexThemeObserver?.disconnect();
      window.__codexPlusProSettingsUiCleanup?.();
      window.__codexPokedexPipHoverCleanup?.();
      window.__codexPokedexPipTitleCleanup?.();
      try { activityChannel.close(); } catch {}
      try { settingsChannel.close(); } catch {}
      document.querySelector(".codex-plus-pro-settings-button")?.remove();
      document.querySelector(".codex-plus-pro-settings-popover")?.remove();
      document.querySelector(".codex-plus-pro-settings-backdrop")?.remove();
      for (const element of document.querySelectorAll(".codex-pokedex-flat-picker, .codex-pokedex-pip-row-button, .codex-pokedex-pip-composer-handle, .codex-pokedex-pip-stop-proxy, .codex-pokedex-pip-pin-toggle")) {
        element.remove();
      }
      if (window.__codexPokedexActivityChannel === activityChannel) window.__codexPokedexActivityChannel = null;
      if (window.__codexPlusProSettingsChannel === settingsChannel) window.__codexPlusProSettingsChannel = null;
      for (const pending of pendingPipRequests.values()) {
        window.clearTimeout(pending.timer);
        pending.reject(new Error("Codex Plus Pro 画中画控制器已刷新"));
      }
      pendingPipRequests.clear();
      if (window.__codexPlusProResolveMultiPipRequest === resolveMultiPipRequest) delete window.__codexPlusProResolveMultiPipRequest;
      if (window.__codexPlusProOpenOfficialPip === openOfficialPip) delete window.__codexPlusProOpenOfficialPip;
      if (window.__codexPlusProSetPipWindowState === setPipWindowState) delete window.__codexPlusProSetPipWindowState;
      if (window.__codexPlusProRuntimeCleanup === cleanupRuntime) delete window.__codexPlusProRuntimeCleanup;
    };
    window.__codexPlusProRuntimeCleanup = cleanupRuntime;
    return {
      active: true,
      version: "1.7.2",
      avatarOverlay: isAvatarOverlay,
      hotkeyWindow: isHotkeyWindow,
    };
  })()`;
}

function buildMainControllerSource() {
  return `(async () => {
    const CONTROLLER_KEY = "__codexPokedexPipWindowController";
    const previous = globalThis[CONTROLLER_KEY];
    if (previous?.timer) clearInterval(previous.timer);
    try { previous?.abortOpenThread?.(); } catch {}

    const electron = process.mainModule?.require?.("electron");
    if (!electron?.BrowserWindow) throw new Error("Electron BrowserWindow is unavailable");

    const controlledWindowIds = new Set(previous?.controlledWindowIds || []);
    const petWindowVisibility = previous?.petWindowVisibility instanceof Map
      ? previous.petWindowVisibility
      : new Map();
    const threadWindowIds = previous?.threadWindowIds instanceof Map
      ? previous.threadWindowIds
      : new Map();
    const windowThreadIds = previous?.windowThreadIds instanceof Map
      ? previous.windowThreadIds
      : new Map();
    const windowPinStates = previous?.windowPinStates instanceof Map
      ? previous.windowPinStates
      : new Map();
    const managedWindowIds = new Set(previous?.managedWindowIds || []);
    const orphanedWindowIds = new Set(previous?.orphanedWindowIds || []);
    const detachedLifecycleWindowIds = new Set(previous?.detachedLifecycleWindowIds || []);
    const windowOrder = Array.isArray(previous?.windowOrder) ? [...previous.windowOrder] : [];
    const controller = {
      active: true,
      version: "1.7.2",
      controlledWindowIds,
      petWindowVisibility,
      threadWindowIds,
      windowThreadIds,
      windowPinStates,
      managedWindowIds,
      orphanedWindowIds,
      detachedLifecycleWindowIds,
      windowOrder,
      officialThreadWindowId: Number(previous?.officialThreadWindowId) || null,
      pendingOpen: null,
      maxThreadWindows: 4,
      features: {
        pip: previous?.features?.pip !== false,
        pet: previous?.features?.pet !== false,
        pipAlwaysOnTop: previous?.features?.pipAlwaysOnTop !== false,
      },
      lastAppliedAt: null,
      timer: null,
    };

    const getInitialRoute = (window) => {
      try {
        const url = window.webContents?.getURL?.() || "";
        return new URL(url).searchParams.get("initialRoute") || "";
      } catch {
        return "";
      }
    };

    const getWindow = (id) => {
      const window = electron.BrowserWindow.fromId(Number(id));
      return window && !window.isDestroyed() ? window : null;
    };

    const extractThreadId = (value) => String(value || "")
      .match(new RegExp("/hotkey-window/thread/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", "i"))?.[1] || "";

    const getRendererState = async (window) => {
      try {
        return await window.webContents.executeJavaScript(
          "({kind:document.documentElement?.getAttribute('data-codex-pokedex-pip-window')||'',threadId:document.documentElement?.getAttribute('data-codex-plus-pip-thread-id')||sessionStorage.getItem('codex-plus-pro-pip-thread-id')||''})",
          true,
        );
      } catch {
        return { kind: "", threadId: "" };
      }
    };

    const removeWindowMapping = (windowId) => {
      const threadId = windowThreadIds.get(windowId);
      if (threadId && threadWindowIds.get(threadId) === windowId) threadWindowIds.delete(threadId);
      windowThreadIds.delete(windowId);
      windowPinStates.delete(windowId);
      managedWindowIds.delete(windowId);
      controlledWindowIds.delete(windowId);
      const orderIndex = windowOrder.indexOf(windowId);
      if (orderIndex >= 0) windowOrder.splice(orderIndex, 1);
    };

    const cleanDeadWindows = () => {
      const liveIds = new Set(electron.BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).map((window) => window.id));
      for (const windowId of [...windowThreadIds.keys()]) {
        if (!liveIds.has(windowId)) removeWindowMapping(windowId);
      }
      for (const [threadId, windowId] of [...threadWindowIds]) {
        if (!liveIds.has(windowId) || windowThreadIds.get(windowId) !== threadId) threadWindowIds.delete(threadId);
      }
      for (const windowId of [...orphanedWindowIds]) {
        if (!liveIds.has(windowId)) orphanedWindowIds.delete(windowId);
      }
      for (const windowId of [...detachedLifecycleWindowIds]) {
        if (!liveIds.has(windowId)) detachedLifecycleWindowIds.delete(windowId);
      }
      for (let index = windowOrder.length - 1; index >= 0; index -= 1) {
        if (!liveIds.has(windowOrder[index])) windowOrder.splice(index, 1);
      }
      if (controller.officialThreadWindowId && !liveIds.has(controller.officialThreadWindowId)) {
        controller.officialThreadWindowId = null;
      }
      return liveIds;
    };

    const collectThreadWindows = async () => {
      cleanDeadWindows();
      const entries = [];
      for (const window of electron.BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue;
        const route = getInitialRoute(window);
        if (!route.startsWith("/hotkey-window")) continue;
        const rendererState = await getRendererState(window);
        const threadId = extractThreadId(route) || String(rendererState.threadId || "");
        const isThread = Boolean(threadId) || rendererState.kind === "thread";
        if (!isThread) continue;
        entries.push({ window, route, rendererState, threadId });
        if (threadId) {
          const previousWindowId = threadWindowIds.get(threadId);
          if (!previousWindowId || !getWindow(previousWindowId) || previousWindowId === window.id) {
            threadWindowIds.set(threadId, window.id);
            windowThreadIds.set(window.id, threadId);
            managedWindowIds.add(window.id);
            if (!windowOrder.includes(window.id)) windowOrder.push(window.id);
            detachOfficialSingletonLifecycle(window);
          }
        }
      }
      if (!getWindow(controller.officialThreadWindowId)) {
        const candidates = entries.filter((entry) => !orphanedWindowIds.has(entry.window.id));
        const current = (candidates.length ? candidates : entries).sort((left, right) => right.window.id - left.window.id)[0];
        controller.officialThreadWindowId = current?.window.id || null;
      }
      return entries;
    };

    const markThreadWindow = async (window, threadId, pinned) => {
      if (!window || window.isDestroyed()) return false;
      const state = { threadId, pinned: Boolean(pinned) };
      const source = "(() => { const state = " + JSON.stringify(state) + "; try { sessionStorage.setItem('codex-plus-pro-pip-thread-id', state.threadId); } catch {} document.documentElement?.setAttribute('data-codex-plus-pip-thread-id', state.threadId); document.documentElement?.setAttribute('data-codex-plus-pip-always-on-top', state.pinned ? 'on' : 'off'); return globalThis.__codexPlusProSetPipWindowState?.(state) || state; })()";
      try {
        await window.webContents.executeJavaScript(source, true);
        return true;
      } catch {
        return false;
      }
    };

    const restorePendingOverride = () => {
      const pending = controller.pendingOpen;
      const override = pending?.override;
      if (override?.window) {
        try {
          if (override.hadOwnProperty) Object.defineProperty(override.window, "isDestroyed", override.descriptor);
          else delete override.window.isDestroyed;
        } catch (error) {
          console.warn("Codex Plus Pro could not restore the official Popout window", error);
        }
      }
      if (pending) pending.override = null;
    };

    const detachOfficialSingletonLifecycle = (window) => {
      if (!window || window.isDestroyed() || detachedLifecycleWindowIds.has(window.id)) return;
      const listenerNeedles = [
        ["blur", "handleHotkeyWindowBlurred"],
        ["resize", "this.threadSize="],
        ["closed", "configuredWindowIds.delete"],
      ];
      for (const [eventName, needle] of listenerNeedles) {
        for (const listener of window.listeners(eventName)) {
          if (String(listener).includes(needle)) window.removeListener(eventName, listener);
        }
      }
      detachedLifecycleWindowIds.add(window.id);
    };

    const positionNewThreadWindow = (window) => {
      if (!electron.screen || !window || window.isDestroyed()) return;
      const anchorId = [...windowOrder].reverse().find((windowId) => windowId !== window.id && getWindow(windowId));
      const anchor = getWindow(anchorId);
      if (!anchor) return;
      try {
        const anchorBounds = anchor.getBounds();
        const bounds = window.getBounds();
        const workArea = electron.screen.getDisplayMatching(anchorBounds).workArea;
        let x = anchorBounds.x + 28;
        let y = anchorBounds.y + 28;
        if (x + bounds.width > workArea.x + workArea.width - 12 || y + bounds.height > workArea.y + workArea.height - 12) {
          x = workArea.x + 24;
          y = workArea.y + 52;
        }
        x = Math.max(workArea.x + 12, Math.min(x, workArea.x + workArea.width - bounds.width - 12));
        y = Math.max(workArea.y + 12, Math.min(y, workArea.y + workArea.height - bounds.height - 12));
        window.setPosition(Math.round(x), Math.round(y), false);
      } catch (error) {
        console.warn("Codex Plus Pro could not position the new Popout window", error);
      }
    };

    controller.beginOpenThread = async (threadId) => {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(threadId || ""))) {
        throw new Error("Invalid task id");
      }
      if (controller.pendingOpen) throw new Error("Another Popout window is still opening");
      const entries = await collectThreadWindows();
      const existingWindow = getWindow(threadWindowIds.get(threadId));
      if (existingWindow) {
        if (!existingWindow.isVisible()) existingWindow.show();
        existingWindow.focus();
        existingWindow.moveTop();
        return { reused: true, threadId, windowId: existingWindow.id, pinned: windowPinStates.get(existingWindow.id) ?? controller.features.pipAlwaysOnTop };
      }
      if (threadWindowIds.size >= controller.maxThreadWindows) {
        throw new Error("最多同时打开 4 个画中画窗口");
      }

      const currentWindow = getWindow(controller.officialThreadWindowId);
      const shouldForceNewWindow = Boolean(currentWindow && managedWindowIds.has(currentWindow.id));
      const pending = {
        threadId,
        beforeWindowIds: entries.map((entry) => entry.window.id),
        previousOfficialWindowId: currentWindow?.id || null,
        forceNewWindow: shouldForceNewWindow,
        override: null,
      };
      if (shouldForceNewWindow) {
        const descriptor = Object.getOwnPropertyDescriptor(currentWindow, "isDestroyed");
        pending.override = {
          window: currentWindow,
          descriptor,
          hadOwnProperty: Object.prototype.hasOwnProperty.call(currentWindow, "isDestroyed"),
        };
        Object.defineProperty(currentWindow, "isDestroyed", {
          configurable: true,
          writable: true,
          value: () => true,
        });
      }
      controller.pendingOpen = pending;
      return { reused: false, forceNewWindow: shouldForceNewWindow };
    };

    controller.finishOpenThread = async (threadId) => {
      const pending = controller.pendingOpen;
      if (!pending || pending.threadId !== threadId) throw new Error("Popout window preparation was lost");
      restorePendingOverride();
      const beforeIds = new Set(pending.beforeWindowIds);
      const readyDeadline = Date.now() + 6000;
      let entries = [];
      let newEntries = [];
      let selected = null;
      while (!selected && Date.now() < readyDeadline) {
        entries = await collectThreadWindows();
        newEntries = entries.filter((entry) => !beforeIds.has(entry.window.id));
        selected = newEntries.find((entry) => entry.threadId === threadId) || newEntries[0];
        if (!selected) selected = entries.find((entry) => entry.threadId === threadId);
        if (!selected && !pending.forceNewWindow) {
          selected = entries.find((entry) => entry.window.id === controller.officialThreadWindowId)
            || entries.toSorted((left, right) => right.window.id - left.window.id)[0];
        }
        if (!selected) await new Promise((resolve) => setTimeout(resolve, 80));
      }
      if (!selected) {
        controller.pendingOpen = null;
        throw new Error("The official Popout window did not finish opening");
      }

      const window = selected.window;
      if (pending.forceNewWindow) {
        const previousOfficialWindow = getWindow(pending.previousOfficialWindowId);
        if (previousOfficialWindow && previousOfficialWindow.id !== window.id) {
          detachOfficialSingletonLifecycle(previousOfficialWindow);
          orphanedWindowIds.add(previousOfficialWindow.id);
        }
      }
      controller.officialThreadWindowId = window.id;
      orphanedWindowIds.delete(window.id);
      removeWindowMapping(window.id);
      threadWindowIds.set(threadId, window.id);
      windowThreadIds.set(window.id, threadId);
      managedWindowIds.add(window.id);
      detachOfficialSingletonLifecycle(window);
      if (!windowOrder.includes(window.id)) windowOrder.push(window.id);
      const pinned = windowPinStates.has(window.id)
        ? windowPinStates.get(window.id)
        : controller.features.pipAlwaysOnTop;
      windowPinStates.set(window.id, pinned);
      await markThreadWindow(window, threadId, pinned);
      if (pending.forceNewWindow && newEntries.some((entry) => entry.window.id === window.id)) positionNewThreadWindow(window);
      controller.pendingOpen = null;
      await controller.apply();
      if (!window.isVisible()) window.show();
      window.focus();
      window.moveTop();
      return { reused: false, threadId, windowId: window.id, pinned, count: threadWindowIds.size };
    };

    controller.abortOpenThread = () => {
      restorePendingOverride();
      controller.pendingOpen = null;
      return { aborted: true };
    };

    controller.closeThread = async (threadId) => {
      await collectThreadWindows();
      const window = getWindow(threadWindowIds.get(threadId));
      if (!window) throw new Error("This Popout window is no longer available");
      const windowId = window.id;
      removeWindowMapping(windowId);
      orphanedWindowIds.delete(windowId);
      if (controller.officialThreadWindowId === windowId) controller.officialThreadWindowId = null;
      window.close();
      return { closed: true, threadId, windowId };
    };

    controller.toggleThreadPin = async (threadId) => {
      await collectThreadWindows();
      const window = getWindow(threadWindowIds.get(threadId));
      if (!window) throw new Error("This Popout window is no longer available");
      const pinned = !(windowPinStates.get(window.id) ?? controller.features.pipAlwaysOnTop);
      windowPinStates.set(window.id, pinned);
      await markThreadWindow(window, threadId, pinned);
      await controller.apply();
      if (pinned && window.isVisible()) window.moveTop();
      return { threadId, windowId: window.id, pinned };
    };

    controller.getThreadState = async (threadId) => {
      await collectThreadWindows();
      const window = getWindow(threadWindowIds.get(threadId));
      if (!window) return { threadId, available: false };
      return {
        threadId,
        windowId: window.id,
        available: true,
        pinned: windowPinStates.get(window.id) ?? controller.features.pipAlwaysOnTop,
      };
    };

    const releasePopoutWindow = (window) => {
      try {
        if (window.isAlwaysOnTop()) window.setAlwaysOnTop(false);
        window.setVisibleOnAllWorkspaces(false, {
          visibleOnFullScreen: false,
          skipTransformProcessType: true,
        });
      } catch (error) {
        console.warn("Codex Plus Pro could not release Popout window policy", error);
      }
      controlledWindowIds.delete(window.id);
    };

    let applyInFlight = null;

    const applyWindowPolicy = async () => {
      if (applyInFlight) return applyInFlight;
      applyInFlight = (async () => {
      await collectThreadWindows();
      const livePopoutIds = new Set();
      const livePetIds = new Set();
      for (const window of electron.BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue;
        const initialRoute = getInitialRoute(window);
        const id = window.id;

        if (initialRoute === "/avatar-overlay") {
          livePetIds.add(id);
          if (!controller.features.pet) {
            if (!petWindowVisibility.has(id)) petWindowVisibility.set(id, window.isVisible());
            if (window.isVisible()) window.hide();
          } else if (petWindowVisibility.has(id)) {
            const shouldRestore = petWindowVisibility.get(id);
            petWindowVisibility.delete(id);
            if (shouldRestore && !window.isVisible()) window.showInactive();
          }
          continue;
        }

        if (!initialRoute.startsWith("/hotkey-window")) continue;
        const rendererState = await getRendererState(window);
        const mappedThreadId = windowThreadIds.get(id);
        if (!mappedThreadId && rendererState.kind !== "thread" && !extractThreadId(initialRoute)) {
          releasePopoutWindow(window);
          continue;
        }
        if (!controller.features.pip) {
          releasePopoutWindow(window);
          continue;
        }
        const pinned = windowPinStates.has(id)
          ? windowPinStates.get(id)
          : controller.features.pipAlwaysOnTop;
        if (!pinned) {
          releasePopoutWindow(window);
          continue;
        }

        const isNewWindow = !controlledWindowIds.has(id);
        livePopoutIds.add(id);
        try {
          if (!window.isAlwaysOnTop()) window.setAlwaysOnTop(true, "floating");
          if (isNewWindow) {
            window.setVisibleOnAllWorkspaces(true, {
              visibleOnFullScreen: true,
              skipTransformProcessType: true,
            });
            if (window.isVisible()) window.moveTop();
          }
        } catch (error) {
          console.warn("Codex Plus Pro could not apply Popout window policy", error);
        }
      }
      for (const id of controlledWindowIds) {
        if (!livePopoutIds.has(id)) controlledWindowIds.delete(id);
      }
      for (const id of petWindowVisibility.keys()) {
        if (!livePetIds.has(id)) petWindowVisibility.delete(id);
      }
      for (const id of livePopoutIds) controlledWindowIds.add(id);
      controller.lastAppliedAt = Date.now();
      return controlledWindowIds.size;
      })();
      try {
        return await applyInFlight;
      } finally {
        applyInFlight = null;
      }
    };

    controller.apply = applyWindowPolicy;
    controller.setFeatures = async (next) => {
      const nextAlwaysOnTop = next?.pipAlwaysOnTop !== false;
      const globalPinChanged = nextAlwaysOnTop !== controller.features.pipAlwaysOnTop;
      controller.features = {
        pip: next?.pip !== false,
        pet: next?.pet !== false,
        pipAlwaysOnTop: nextAlwaysOnTop,
      };
      if (globalPinChanged) {
        for (const [windowId, threadId] of windowThreadIds) {
          windowPinStates.set(windowId, nextAlwaysOnTop);
          const window = getWindow(windowId);
          if (window) await markThreadWindow(window, threadId, nextAlwaysOnTop);
        }
      }
      return {
        ...controller.features,
        controlled: await applyWindowPolicy(),
      };
    };
    controller.timer = setInterval(() => void applyWindowPolicy(), 500);
    globalThis[CONTROLLER_KEY] = controller;
    const controlled = await applyWindowPolicy();
    return { active: true, version: controller.version, controlled };
  })()`;
}

function createCdpConnection(url, onClose) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const pending = new Map();
    const eventListeners = new Map();
    let nextId = 1;
    let settled = false;

    const connection = {
      send(method, params = {}) {
        if (socket.readyState !== WebSocket.OPEN) {
          return Promise.reject(new Error("DevTools socket is not open"));
        }
        const id = nextId++;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolveRequest, rejectRequest) => {
          pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        });
      },
      on(method, listener) {
        let listeners = eventListeners.get(method);
        if (!listeners) {
          listeners = new Set();
          eventListeners.set(method, listeners);
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      },
    };

    socket.addEventListener("open", () => {
      settled = true;
      resolve(connection);
    }, { once: true });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) {
        for (const listener of eventListeners.get(message.method) || []) {
          Promise.resolve(listener(message.params)).catch((error) => {
            log(`DevTools event ${message.method} failed: ${error.message}`);
          });
        }
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });

    socket.addEventListener("error", () => {
      if (!settled) reject(new Error("Unable to open DevTools socket"));
    }, { once: true });

    socket.addEventListener("close", () => {
      for (const request of pending.values()) {
        request.reject(new Error("DevTools socket closed"));
      }
      pending.clear();
      onClose?.();
    });
  });
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function parseArguments(argumentsList) {
  const parsed = {};
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2);
    const next = argumentsList[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function shutDown() {
  shuttingDown = true;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function log(message) {
  const timestamp = new Date().toISOString();
  process.stdout.write(`[${timestamp}] ${message}\n`);
}
