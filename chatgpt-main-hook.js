(() => {
  if (globalThis.__HIIRO_CLIPBOARD_HOOK__) return;
  globalThis.__HIIRO_CLIPBOARD_HOOK__ = true;

  let armedId = "";
  let armedUntil = 0;
  let interceptionReady = false;

  const capture = (text) => {
    if (!armedId || Date.now() > armedUntil || typeof text !== "string") return false;
    window.postMessage({ source: "HiiroSideChatMain", type: "clipboard-source", id: armedId, text }, "*");
    armedId = "";
    armedUntil = 0;
    return true;
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "HiiroSideChatBridge" || event.data?.type !== "arm-copy") return;
    armedId = String(event.data.id || "");
    armedUntil = Date.now() + 4000;
    window.postMessage({ source: "HiiroSideChatMain", type: "copy-armed", id: armedId, ready: interceptionReady }, "*");
  });

  try {
    const clipboard = navigator.clipboard;
    const prototype = clipboard && Object.getPrototypeOf(clipboard);
    const originalWriteText = prototype?.writeText;
    if (typeof originalWriteText === "function") {
      Object.defineProperty(prototype, "writeText", {
        configurable: true,
        value: function (text) {
          if (capture(String(text))) return Promise.resolve();
          return originalWriteText.call(this, text);
        }
      });
      interceptionReady = true;
    }

    const originalWrite = prototype?.write;
    if (typeof originalWrite === "function") {
      Object.defineProperty(prototype, "write", {
        configurable: true,
        value: async function (items) {
          if (armedId) {
            try {
              const item = [...items][0];
              const type = item?.types?.find((value) => value === "text/plain") || item?.types?.[0];
              const blob = type ? await item.getType(type) : null;
              const text = blob ? await blob.text() : "";
              if (capture(text)) return;
            } catch {}
          }
          return originalWrite.call(this, items);
        }
      });
      interceptionReady = true;
    }
  } catch {
    // DOM extraction remains available if Clipboard cannot be wrapped.
  }
})();
