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
  let renderFrame = 0;
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

  function scheduleRender() {
    if (!isAvatarOverlay || renderFrame) return;
    renderFrame = window.requestAnimationFrame(() => {
      renderFrame = 0;
      autoDismissPersistedNotifications();
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
    if (!button) return;
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
    if (window[RUNTIME_KEY]) delete window[RUNTIME_KEY];
  };
})();
