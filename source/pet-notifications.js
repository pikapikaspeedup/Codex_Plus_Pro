(() => {
  "use strict";

  const RUNTIME_KEY = "__codexPlusProPetNotificationsCleanup";
  const DISMISSED_STORAGE_KEY = "codex-plus-pro-pet-dismissed-v1";
  const SNAPSHOT_STORAGE_KEY = "codex-plus-pro-pet-notification-snapshot-v1";
  const MAX_PERSISTED_NOTIFICATIONS = 240;
  const initialRoute = new URL(location.href).searchParams.get("initialRoute") || "";
  const isAvatarOverlay = initialRoute === "/avatar-overlay";

  window[RUNTIME_KEY]?.();

  let currentNotifications = [];
  let currentLocale = document.documentElement.lang || navigator.language || "en";
  let renderFrame = 0;
  let markReadInFlight = false;
  let officialServicesPromise = null;
  const dismissedThisSession = new Set();

  const readJson = (key, fallback) => {
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null");
      return value && typeof value === "object" ? value : fallback;
    } catch {
      return fallback;
    }
  };

  const notificationFingerprint = (notification) => {
    const turnKey = notification?.turnKey;
    if (turnKey != null && String(turnKey) !== "") return "turn:" + String(turnKey);
    const updatedAtMs = Number(notification?.updatedAtMs);
    if (Number.isFinite(updatedAtMs) && updatedAtMs > 0) return "updated:" + updatedAtMs;
    return "";
  };

  const compactNotification = (notification) => ({
    controlTarget: notification?.controlTarget ?? null,
    id: String(notification?.id || ""),
    isLoading: notification?.isLoading === true,
    kind: String(notification?.kind || ""),
    level: String(notification?.level || ""),
    localConversationId: notification?.localConversationId == null
      ? null
      : String(notification.localConversationId),
    source: String(notification?.source || ""),
    title: String(notification?.title || ""),
    turnKey: notification?.turnKey ?? null,
    updatedAtMs: Number(notification?.updatedAtMs) || 0,
  });

  const isCompletedNotification = (notification) =>
    Boolean(notification?.id) && notification.isLoading !== true;

  const isUnreadResult = (notification) =>
    isCompletedNotification(notification) && notification.level === "success";

  const persistDismissed = (notification) => {
    const id = String(notification?.id || "");
    const fingerprint = notificationFingerprint(notification);
    if (!id || !fingerprint) return false;

    const stored = readJson(DISMISSED_STORAGE_KEY, { entries: {} });
    const entries = stored.entries && typeof stored.entries === "object" ? stored.entries : {};
    entries[id] = {
      dismissedAt: Date.now(),
      fingerprint,
    };

    const trimmedEntries = Object.fromEntries(
      Object.entries(entries)
        .sort((left, right) => Number(right[1]?.dismissedAt || 0) - Number(left[1]?.dismissedAt || 0))
        .slice(0, MAX_PERSISTED_NOTIFICATIONS),
    );
    try {
      localStorage.setItem(DISMISSED_STORAGE_KEY, JSON.stringify({
        entries: trimmedEntries,
        version: 1,
      }));
      return true;
    } catch {
      return false;
    }
  };

  const wasPersistentlyDismissed = (notification) => {
    const id = String(notification?.id || "");
    const fingerprint = notificationFingerprint(notification);
    if (!id || !fingerprint) return false;
    const stored = readJson(DISMISSED_STORAGE_KEY, { entries: {} });
    return stored.entries?.[id]?.fingerprint === fingerprint;
  };

  const saveNotificationSnapshot = (notifications) => {
    const entries = {};
    for (const notification of notifications) {
      if (!notification?.id) continue;
      entries[String(notification.id)] = compactNotification(notification);
    }
    try {
      localStorage.setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify({
        entries,
        savedAt: Date.now(),
        version: 1,
      }));
    } catch {
      // The in-memory path remains available if app storage is temporarily unavailable.
    }
  };

  const readSnapshotNotification = (notificationId) => {
    const snapshot = readJson(SNAPSHOT_STORAGE_KEY, { entries: {} });
    return snapshot.entries?.[notificationId] ?? null;
  };

  const findReactNotification = (element) => {
    const matchesNotification = (value) =>
      value && typeof value === "object" && typeof value.id === "string" &&
      ("turnKey" in value || "localConversationId" in value) &&
      ("isLoading" in value || "level" in value);

    const searchValue = (value, depth, seen) => {
      if (matchesNotification(value)) return value;
      if (depth <= 0 || !value || typeof value !== "object" || seen.has(value)) return null;
      seen.add(value);
      for (const key of ["notification", "activity", "item", "children"]) {
        let nested;
        try {
          nested = value[key];
        } catch {
          continue;
        }
        if (Array.isArray(nested)) {
          for (const item of nested) {
            const found = searchValue(item, depth - 1, seen);
            if (found) return found;
          }
        } else {
          const found = searchValue(nested, depth - 1, seen);
          if (found) return found;
        }
      }
      return null;
    };

    for (let node = element; node instanceof Element; node = node.parentElement) {
      for (const key of Object.getOwnPropertyNames(node)) {
        if (!key.startsWith("__reactFiber$") && !key.startsWith("__reactInternalInstance$")) continue;
        let fiber;
        try {
          fiber = node[key];
        } catch {
          continue;
        }
        for (let depth = 0; fiber && depth < 30; depth += 1, fiber = fiber.return) {
          const found = searchValue(fiber.memoizedProps ?? fiber.pendingProps, 3, new WeakSet());
          if (found) return found;
        }
      }
    }
    return null;
  };

  const getDismissButtonEntries = () =>
    Array.from(document.querySelectorAll(
      '[data-avatar-overlay-chromium-overflow="true"] button',
    )).flatMap((button) => {
      if (button.closest(".codex-plus-pro-pet-notification-tools")) return [];
      const notification = findReactNotification(button);
      return notification ? [{ button, notification }] : [];
    });

  const getVisibleNotifications = () => {
    const byId = new Map();
    for (const notification of currentNotifications) {
      if (notification?.id) byId.set(String(notification.id), notification);
    }
    for (const { notification } of getDismissButtonEntries()) {
      if (notification?.id && !byId.has(String(notification.id))) {
        byId.set(String(notification.id), notification);
      }
    }
    return Array.from(byId.values());
  };

  const dispatchMessageFromView = (message) => {
    let forwardedViaBridge = false;
    try {
      if (typeof window.electronBridge?.sendMessageFromView === "function") {
        const pending = window.electronBridge.sendMessageFromView(message);
        pending?.catch?.((error) => {
          console.warn("Codex Plus Pro pet action failed", error);
        });
        forwardedViaBridge = true;
      }
    } catch (error) {
      console.warn("Codex Plus Pro could not reach the pet bridge", error);
    }

    const event = new CustomEvent("codex-message-from-view", { detail: message });
    if (forwardedViaBridge) event.__codexForwardedViaBridge = true;
    window.dispatchEvent(event);
  };

  const dismissNotification = (notification, { persist = true } = {}) => {
    if (!isCompletedNotification(notification)) return false;
    if (persist) persistDismissed(notification);

    const id = String(notification.id);
    const fingerprint = notificationFingerprint(notification);
    const sessionKey = id + "\u0000" + fingerprint;
    if (dismissedThisSession.has(sessionKey)) return true;
    dismissedThisSession.add(sessionKey);

    const matchingEntry = getDismissButtonEntries().find(
      (entry) => String(entry.notification.id) === id,
    );
    if (matchingEntry) {
      matchingEntry.button.click();
    } else {
      dispatchMessageFromView({
        action: {
          notificationId: id,
          type: "dismiss-notification",
        },
        type: "avatar-overlay-composition-action",
      });
    }
    return true;
  };

  const autoDismissPersistedNotifications = () => {
    if (!isAvatarOverlay) return;
    for (const notification of getVisibleNotifications()) {
      if (isCompletedNotification(notification) && wasPersistentlyDismissed(notification)) {
        dismissNotification(notification, { persist: false });
      }
    }
  };

  const locateOfficialModuleUrls = async () => {
    const moduleUrls = new Set(
      performance.getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((url) => /\/assets\/app-initial-[^/]+\.js(?:\?|$)/.test(url)),
    );
    const entryUrl = [
      ...Array.from(document.scripts, (script) => script.src).filter(Boolean),
      ...performance.getEntriesByType("resource").map((entry) => entry.name),
    ].find((url) => /\/assets\/index-[^/]+\.js(?:\?|$)/.test(url));

    if (entryUrl) {
      const entrySource = await fetch(entryUrl).then((response) => {
        if (!response.ok) throw new Error("Unable to read the Codex entry module");
        return response.text();
      });
      for (const match of entrySource.matchAll(/["'](\.\/app-initial-[^"']+\.js)["']/g)) {
        moduleUrls.add(new URL(match[1], entryUrl).href);
      }
    }
    return Array.from(moduleUrls);
  };

  const loadOfficialServices = async () => {
    if (officialServicesPromise) return officialServicesPromise;
    officialServicesPromise = (async () => {
      const moduleUrls = await locateOfficialModuleUrls();
      for (const moduleUrl of moduleUrls) {
        try {
          const source = await fetch(moduleUrl).then((response) => {
            if (!response.ok) throw new Error("Unable to read a Codex app module");
            return response.text();
          });
          if (!source.includes("mark-conversation-as-read")) continue;

          const namespace = await import(moduleUrl);
          const requestAlias = source.match(/\bRf as ([A-Za-z_$][\w$]*)/)?.[1];
          const apiAlias = source.match(/\bQh as ([A-Za-z_$][\w$]*)/)?.[1];
          const request = requestAlias && typeof namespace[requestAlias] === "function"
            ? namespace[requestAlias]
            : Object.values(namespace).find(
              (value) => typeof value === "function" && value.name === "Rf",
            );
          const cloudApi = apiAlias && typeof namespace[apiAlias]?.safePost === "function"
            ? namespace[apiAlias]
            : Object.values(namespace).find(
              (value) => value && typeof value === "object" &&
                typeof value.safePost === "function" && typeof value.safeGet === "function",
            );
          if (typeof request === "function") return { cloudApi, request };
        } catch (error) {
          console.debug("Codex Plus Pro skipped a private notification module", moduleUrl, error);
        }
      }
      throw new Error("Codex mark-as-read service was not found");
    })().catch((error) => {
      officialServicesPromise = null;
      throw error;
    });
    return officialServicesPromise;
  };

  const markNotificationRead = async (notification, services) => {
    if (notification.localConversationId) {
      await services.request("mark-conversation-as-read", {
        conversationId: notification.localConversationId,
      });
      return;
    }

    const controlTarget = notification.controlTarget;
    if (controlTarget?.type === "cloud-task" && controlTarget.taskId) {
      if (typeof services.cloudApi?.safePost !== "function") {
        throw new Error("Codex cloud mark-as-read service was not found");
      }
      await services.cloudApi.safePost("/wham/tasks/{task_id}/mark_read", {
        parameters: {
          path: {
            task_id: controlTarget.taskId,
          },
        },
      });
      return;
    }
    throw new Error("This notification has no readable task target");
  };

  const setToolbarStatus = (message, isError = false) => {
    const toolbar = document.querySelector(".codex-plus-pro-pet-notification-tools");
    if (!toolbar) return;
    toolbar.dataset.status = isError ? "error" : message ? "busy" : "ready";
    toolbar.title = message;
    const status = toolbar.querySelector(".codex-plus-pro-pet-notification-status");
    if (status && status.textContent !== message) status.textContent = message;
  };

  const markAllRead = async () => {
    if (markReadInFlight) return;
    const unread = getVisibleNotifications().filter(isUnreadResult);
    if (unread.length === 0) return;

    markReadInFlight = true;
    renderToolbar();
    const isChinese = /^zh\b/i.test(currentLocale);
    setToolbarStatus(isChinese ? "正在标记为已读…" : "Marking as read…");
    try {
      const services = await loadOfficialServices();
      const completed = [];
      const failures = [];
      for (const notification of unread) {
        try {
          await markNotificationRead(notification, services);
          completed.push(notification);
        } catch (error) {
          failures.push(error);
        }
      }
      for (const notification of completed) dismissNotification(notification);
      if (failures.length > 0) {
        throw new Error(
          isChinese
            ? `${failures.length} 条通知未能标记为已读`
            : `${failures.length} notification(s) could not be marked as read`,
        );
      }
      setToolbarStatus("");
    } catch (error) {
      console.error("Codex Plus Pro could not mark pet notifications as read", error);
      setToolbarStatus(error?.message || String(error), true);
    } finally {
      markReadInFlight = false;
      scheduleRender();
    }
  };

  const clearUnread = () => {
    for (const notification of getVisibleNotifications().filter(isUnreadResult)) {
      dismissNotification(notification);
    }
    scheduleRender();
  };

  const createToolbarButton = (className, onClick) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    button.addEventListener("pointerdown", (event) => event.stopPropagation());
    return button;
  };

  const ensureToolbar = () => {
    if (!isAvatarOverlay) return null;
    let toolbar = document.querySelector(".codex-plus-pro-pet-notification-tools");
    if (toolbar) return toolbar;

    toolbar = document.createElement("div");
    toolbar.className = "codex-plus-pro-pet-notification-tools no-drag";
    toolbar.setAttribute("data-avatar-overlay-hit-region", "notification-tools");
    toolbar.setAttribute("role", "toolbar");

    const markReadButton = createToolbarButton(
      "codex-plus-pro-pet-mark-read",
      () => void markAllRead(),
    );
    const clearButton = createToolbarButton(
      "codex-plus-pro-pet-clear-unread",
      clearUnread,
    );
    const unreadCount = document.createElement("span");
    unreadCount.className = "codex-plus-pro-pet-unread-count";
    unreadCount.setAttribute("aria-hidden", "true");
    const status = document.createElement("span");
    status.className = "codex-plus-pro-pet-notification-status";
    status.setAttribute("aria-live", "polite");

    toolbar.append(unreadCount, markReadButton, clearButton, status);
    (document.body || document.documentElement).append(toolbar);
    return toolbar;
  };

  function renderToolbar() {
    if (!isAvatarOverlay) return;
    const unreadCount = getVisibleNotifications().filter(isUnreadResult).length;
    const toolbar = ensureToolbar();
    if (!toolbar) return;

    const isChinese = /^zh\b/i.test(currentLocale) ||
      getVisibleNotifications().some((notification) =>
        /[\u3400-\u9fff]/u.test(String(notification?.title || "")),
      );
    const unreadCountBadge = toolbar.querySelector(".codex-plus-pro-pet-unread-count");
    const markReadButton = toolbar.querySelector(".codex-plus-pro-pet-mark-read");
    const clearButton = toolbar.querySelector(".codex-plus-pro-pet-clear-unread");
    const hasUnread = unreadCount > 0;
    toolbar.hidden = !hasUnread;
    toolbar.setAttribute(
      "aria-label",
      isChinese
        ? `${unreadCount} 条宠物未读通知`
        : `${unreadCount} unread pet notification${unreadCount === 1 ? "" : "s"}`,
    );
    if (unreadCountBadge.textContent !== String(unreadCount)) {
      unreadCountBadge.textContent = String(unreadCount);
    }
    const markReadLabel = isChinese ? "全部已读" : "Read all";
    const clearLabel = isChinese ? "清除" : "Clear";
    if (markReadButton.textContent !== markReadLabel) markReadButton.textContent = markReadLabel;
    if (clearButton.textContent !== clearLabel) clearButton.textContent = clearLabel;
    markReadButton.title = isChinese
      ? "把这些任务标记为已读，并收起通知"
      : "Mark these tasks as read and dismiss their notifications";
    clearButton.title = isChinese
      ? "仅收起悬浮通知，任务仍保持未读"
      : "Dismiss the floating notifications without marking the tasks as read";
    markReadButton.disabled = markReadInFlight || !hasUnread;
    clearButton.disabled = markReadInFlight || !hasUnread;
  }

  function scheduleRender() {
    if (!isAvatarOverlay || renderFrame) return;
    renderFrame = window.requestAnimationFrame(() => {
      renderFrame = 0;
      autoDismissPersistedNotifications();
      renderToolbar();
    });
  }

  const handleMessageFromView = (event) => {
    const message = event.detail;
    if (!message || typeof message !== "object") return;

    if (message.type === "avatar-overlay-composition-changed" && isAvatarOverlay) {
      const contentState = message.state?.contentState;
      currentNotifications = Array.isArray(contentState?.activities)
        ? contentState.activities.map((activity) => activity?.notification).filter(Boolean)
        : [];
      currentLocale = contentState?.locale || currentLocale;
      saveNotificationSnapshot(currentNotifications);
      scheduleRender();
      return;
    }

    if (
      message.type === "avatar-overlay-composition-action" &&
      message.action?.type === "dismiss-notification"
    ) {
      const notificationId = String(message.action.notificationId || "");
      const notification = currentNotifications.find(
        (candidate) => String(candidate?.id || "") === notificationId,
      ) || readSnapshotNotification(notificationId);
      if (notification) persistDismissed(notification);
    }
  };

  const handleDismissClick = (event) => {
    const button = event.target.closest?.(
      '[data-avatar-overlay-chromium-overflow="true"] button',
    );
    if (!button || button.closest(".codex-plus-pro-pet-notification-tools")) return;
    const notification = findReactNotification(button);
    if (notification && isCompletedNotification(notification)) persistDismissed(notification);
  };

  window.addEventListener("codex-message-from-view", handleMessageFromView);
  document.addEventListener("click", handleDismissClick, true);

  const observer = new MutationObserver(scheduleRender);
  if (isAvatarOverlay) {
    observer.observe(document.documentElement, { childList: true, subtree: true });
    scheduleRender();
  }

  window[RUNTIME_KEY] = () => {
    if (renderFrame) window.cancelAnimationFrame(renderFrame);
    observer.disconnect();
    window.removeEventListener("codex-message-from-view", handleMessageFromView);
    document.removeEventListener("click", handleDismissClick, true);
    document.querySelector(".codex-plus-pro-pet-notification-tools")?.remove();
    if (window[RUNTIME_KEY]) delete window[RUNTIME_KEY];
  };
})();
