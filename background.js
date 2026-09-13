const DEBUGGER_PROTOCOL_VERSION = "1.3";
const CHATGPT_HOME = "https://chatgpt.com/";
const chatRenderPumps = new Map();

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.url?.startsWith(CHATGPT_HOME)) return;
  const stored = await chrome.storage.local.get([
    "chatgptTabId_chat", "chatgptTabId_work", "chatgptPdfKey_chat", "chatgptPdfKey_work",
    "chatgptProjectUrl_chat", "chatgptProjectUrl_work", "pdfConversations"
  ]);
  if (stored.chatgptTabId_chat === tabId) {
    await chrome.storage.local.set({ chatgptConversationUrl_chat: tab.url });
    await savePdfConversation(stored.chatgptPdfKey_chat, "chat", tab.url, stored.chatgptProjectUrl_chat);
  }
  if (stored.chatgptTabId_work === tabId) {
    await chrome.storage.local.set({ chatgptConversationUrl_work: tab.url });
    await savePdfConversation(stored.chatgptPdfKey_work, "work", tab.url, stored.chatgptProjectUrl_work);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "capture_pdf_context":
      return { context: await capturePdfContext() };
    case "chatgpt_send":
      return await sendToChatGpt(message.payload);
    case "chatgpt_poll":
      return await wakeChatGptStream(message.requestId, message.backend || "chat", message.payload || null);
    case "prewarm_chatgpt": {
      const tab = await ensureChatGptTab(message.backend || "chat", message.pdfKey || "", message.projectUrl || "");
      await waitForTab(tab.id);
      return { tabId: tab.id, ready: true };
    }
    case "prepare_project_source":
      return await prepareProjectSource(message.projectUrl, message.pdfFile);
    case "list_chatgpt_projects":
      return { projects: await listChatGptProjects() };
    case "chatgpt_set_reasoning_effort":
      if (!sender?.tab?.id || !sender.tab.url?.startsWith(CHATGPT_HOME)) {
        throw new Error("推理強度只能由專用 ChatGPT 分頁調整。");
      }
      await setReasoningEffortWithKeyboard(sender.tab.id, message.targetIndex);
      return {};
    case "chatgpt_set_reasoning_pointer":
      if (!sender?.tab?.id || !sender.tab.url?.startsWith(CHATGPT_HOME)) {
        throw new Error("推理強度只能由專用 ChatGPT 分頁調整。");
      }
      await setReasoningEffortWithPointer(
        sender.tab.id,
        message.targetIndex,
        message.itemCount,
        message.rect,
        message.menuFallback
      );
      return {};
    case "chatgpt_stream":
      if (message.done) await stopChatRenderPump(message.backend || "chat");
      return {};
    case "chatgpt_quota":
      await stopChatRenderPump(message.backend || "chat");
      return {};
    case "open_chatgpt": {
      const tab = await ensureChatGptTab(message.backend || "chat", message.pdfKey, message.projectUrl);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return { tabId: tab.id };
    }
    case "reset_chatgpt": {
      const stored = await chrome.storage.local.get(["chatgptTabId_chat", "chatgptTabId_work"]);
      for (const tabId of [stored.chatgptTabId_chat, stored.chatgptTabId_work].filter(Boolean)) {
        try {
          await chrome.tabs.remove(tabId);
        } catch {
          // The tab may already be gone.
        }
      }
      await chrome.storage.local.remove([
        "chatgptTabId_chat",
        "chatgptTabId_work",
        "chatgptConversationUrl_chat",
        "chatgptConversationUrl_work",
        "chatgptProjectUrl_chat",
        "chatgptProjectUrl_work"
      ]);
      return {};
    }
    default:
      throw new Error("Unknown extension message.");
  }
}

async function setReasoningEffortWithKeyboard(tabId, targetIndex) {
  const index = Number(targetIndex);
  if (!Number.isInteger(index) || index < 0 || index > 3) {
    throw new Error("無效的推理強度檔位。");
  }

  const debuggee = { tabId };
  let attachedHere = false;
  if (!chatRenderPumps.has(tabId)) {
    await chrome.debugger.attach(debuggee, DEBUGGER_PROTOCOL_VERSION);
    attachedHere = true;
  }

  try {
    await dispatchKey(debuggee, "Home", "Home", 36);
    for (let step = 0; step < index; step += 1) {
      await dispatchKey(debuggee, "ArrowRight", "ArrowRight", 39);
    }
  } finally {
    if (attachedHere) await chrome.debugger.detach(debuggee).catch(() => {});
  }
}

async function dispatchKey(debuggee, key, code, virtualKeyCode) {
  const common = {
    key,
    code,
    windowsVirtualKeyCode: virtualKeyCode,
    nativeVirtualKeyCode: virtualKeyCode
  };
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...common });
  await chrome.debugger.sendCommand(debuggee, "Input.dispatchKeyEvent", { type: "keyUp", ...common });
}

async function setReasoningEffortWithPointer(tabId, targetIndex, itemCount, rect, menuFallback) {
  const index = Number(targetIndex);
  const count = Math.max(2, Math.min(6, Number(itemCount) || 4));
  const box = rect || {};
  if (!Number.isInteger(index) || index < 0 || index >= count ||
      ![box.left, box.top, box.width, box.height].every(Number.isFinite)) {
    throw new Error("無效的推理強度滑桿位置。");
  }

  const padding = menuFallback ? Math.max(14, box.width * .07) : Math.max(2, Math.min(14, box.width * .04));
  const usableWidth = Math.max(1, box.width - padding * 2);
  const x = box.left + padding + usableWidth * index / (count - 1);
  const y = menuFallback ? box.top + box.height * .72 : box.top + box.height / 2;
  const debuggee = { tabId };
  let attachedHere = false;
  if (!chatRenderPumps.has(tabId)) {
    await chrome.debugger.attach(debuggee, DEBUGGER_PROTOCOL_VERSION);
    attachedHere = true;
  }
  try {
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1
    });
    await chrome.debugger.sendCommand(debuggee, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1
    });
  } finally {
    if (attachedHere) await chrome.debugger.detach(debuggee).catch(() => {});
  }
}

async function wakeChatGptStream(requestId, backend, payload = null) {
  const key = `chatgptTabId_${backend === "work" ? "work" : "chat"}`;
  const stored = await chrome.storage.local.get(key);
  if (!stored[key]) return { awake: false };
  try {
    await forceChatRender(stored[key]);
    const bridgeMessage = payload ? {
      type: "bridge_resume_stream",
      payload: { ...payload, requestId, backend }
    } : { type: "bridge_wake_stream", requestId };
    try {
      await chrome.tabs.sendMessage(stored[key], bridgeMessage);
    } catch {
      // A full project -> /c/... navigation can briefly miss manifest content
      // script injection.  Reinstall the idempotent bridge in the new document
      // instead of leaving the sidebar waiting until its timeout wall.
      await chrome.scripting.executeScript({ target: { tabId: stored[key] }, files: ["chatgpt-bridge.js"] });
      await chrome.tabs.sendMessage(stored[key], bridgeMessage);
    }
    return { awake: true };
  } catch {
    return { awake: false };
  }
}

async function listChatGptProjects() {
  const sendBridge = async (tabId, message) => {
    let response;
    try {
      response = await chrome.tabs.sendMessage(tabId, message);
    } catch {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["chatgpt-bridge.js"] });
      response = await chrome.tabs.sendMessage(tabId, message);
    }
    if (!response?.ok) throw new Error(response?.error || "ChatGPT 沒有回傳專案資料。");
    return response;
  };
  const directoryUrl = `${CHATGPT_HOME}projects`;
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: directoryUrl, active: false });
    await waitForTabAtUrl(tab.id, (url) => new URL(url).pathname === "/projects", 30000);
    const listing = await sendBridge(tab.id, { type: "bridge_list_project_rows" });
    const names = Array.isArray(listing.rows) ? listing.rows : [];
    const projects = [];

    for (const name of names) {
      await waitForTabAtUrl(tab.id, (url) => new URL(url).pathname === "/projects", 15000);
      await sendBridge(tab.id, { type: "bridge_open_project_row", name });
      const opened = await waitForTabAtUrl(tab.id, (url) => Boolean(validProjectUrl(url)), 15000);
      const url = validProjectUrl(opened.url || "");
      if (url) projects.push({ name, url });
      if (projects.length < names.length) {
        await chrome.tabs.update(tab.id, { url: directoryUrl });
        await waitForTabAtUrl(tab.id, (nextUrl) => new URL(nextUrl).pathname === "/projects", 15000);
        const refreshed = await sendBridge(tab.id, { type: "bridge_list_project_rows" });
        if (!Array.isArray(refreshed.rows) || !refreshed.rows.includes(names[projects.length])) {
          throw new Error(`專案列表重新載入後找不到：${names[projects.length] || "未命名"}`);
        }
      }
    }
    return projects;
  } finally {
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function prepareProjectSource(projectUrl, pdfFile, backend = "chat", pdfKey = "") {
  const project = validProjectUrl(projectUrl);
  if (!project) throw new Error("請先選擇一個 ChatGPT 專案。");
  if (!pdfFile?.dataUrl || !pdfFile?.name || !pdfFile?.sourceUrl) throw new Error("沒有可上傳的 PDF。");

  const sourcesUrl = new URL(project);
  sourcesUrl.searchParams.set("tab", "sources");
  let tab = null;
  try {
    // Strictly in the background: active: false!
    tab = await ensureChatGptTab(backend || "chat", pdfKey || "", projectUrl);
    await chrome.tabs.update(tab.id, { url: sourcesUrl.href, active: false });
    await waitForTabAtUrl(tab.id, (url) => {
      try {
        const parsed = new URL(url);
        return Boolean(validProjectUrl(`${parsed.origin}${parsed.pathname}`)) && parsed.searchParams.get("tab") === "sources";
      } catch {
        return false;
      }
    }, 30000);

    const sendSourceBridge = async (message) => {
      try {
        return await chrome.tabs.sendMessage(tab.id, message);
      } catch {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["chatgpt-bridge.js"] });
        return await chrome.tabs.sendMessage(tab.id, message);
      }
    };

    const probe = await sendSourceBridge({
      type: "bridge_probe_project_source",
      filename: pdfFile.name
    });
    if (!probe?.ok) throw new Error(probe?.error || "無法檢查專案資料來源。");

    let alreadyExisted = Boolean(probe.exists);
    if (!alreadyExisted) {
      await setProjectSourceFile(tab.id, pdfFile.sourceUrl);
      const response = await sendSourceBridge({
        type: "bridge_wait_project_source",
        filename: pdfFile.name
      });
      if (!response?.ok || !response.exists) throw new Error(response?.error || "無法加入專案資料來源。");
    }

    return {
      sourceReady: true,
      alreadyExisted,
      filename: pdfFile.name
    };
  } finally {
    if (tab?.id) {
      // Quietly navigate back to ?tab=chats in the background
      const chatsUrl = new URL(project);
      chatsUrl.searchParams.set("tab", "chats");
      await chrome.tabs.update(tab.id, { url: chatsUrl.href, active: false }).catch(() => {});
      await chrome.storage.local.set({
        [`chatgptConversationUrl_${backend}`]: chatsUrl.href
      });
    }
  }
}

async function setProjectSourceFile(tabId, sourceUrl) {
  const filePath = localPathFromFileUrl(sourceUrl);
  if (!filePath) throw new Error("專案資料來源目前只支援本地 file:// PDF。");
  const debuggee = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, DEBUGGER_PROTOCOL_VERSION);
    attached = true;
    await chrome.debugger.sendCommand(debuggee, "Runtime.enable");
    await chrome.debugger.sendCommand(debuggee, "DOM.enable");

    const expression = `(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      
      const triggerClick = (el) => {
        if (!el) return;
        el.focus?.();
        const opts = { bubbles: true, cancelable: true, view: window };
        try { el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' })); } catch {}
        try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch {}
        try { el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' })); } catch {}
        try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch {}
        el.click();
      };

      const findFileInput = () => {
        const inputs = [...document.querySelectorAll('input[type="file"]')];
        // 1. Prioritize input inside dialog, tabpanel, or sources container
        const targeted = inputs.find(node =>
          node.closest('[role="dialog"], [role="tabpanel"], [data-testid*="source"], [aria-label*="來源"], [aria-label*="Sources"]')
        );
        if (targeted) return targeted;

        // 2. Otherwise any input not inside composer form
        return inputs.find(node =>
          !node.closest('form[data-type="unified-composer"]') &&
          !node.closest('#prompt-textarea') &&
          !node.closest('form')
        ) || inputs.find(node => !node.closest('form')) || null;
      };

      const ensureSourcesTab = () => {
        const tabs = [...document.querySelectorAll('[role="tab"], button, a')];
        const sourcesTab = tabs.find(el => {
          const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim();
          return /^(資料來源|数据源|sources)$/i.test(text);
        });
        if (sourcesTab) {
          const isSelected = sourcesTab.getAttribute('aria-selected') === 'true' ||
                             sourcesTab.getAttribute('data-state') === 'active' ||
                             sourcesTab.classList.contains('active');
          if (!isSelected) {
            triggerClick(sourcesTab);
            return true;
          }
        }
        return false;
      };

      const findAddButton = () => {
        const candidates = [...document.querySelectorAll('button, [role="button"], a, [role="menuitem"]')].filter(n => !n.disabled);
        for (const el of candidates) {
          const text = \`\${el.innerText || ''} \${el.textContent || ''} \${el.getAttribute('aria-label') || ''} \${el.getAttribute('title') || ''}\`.replace(/\\s+/g, ' ').trim().toLowerCase();
          if (/(新增資料來源|添加数据源|新增來源|添加来源|新增檔案|添加文件|上傳檔案|上传文件|add\\s*(?:a\\s*)?(?:project\\s*)?source|add\\s*files?|upload\\s*files?)/i.test(text)) {
            return el;
          }
        }
        return null;
      };

      // Ensure we are visibly on the Sources tab in React
      ensureSourcesTab();

      let input = findFileInput();
      if (input) return input;

      // Poll until the Add Source button is rendered
      let addBtn = null;
      for (let i = 0; i < 25; i++) {
        ensureSourcesTab();
        input = findFileInput();
        if (input) return input;

        addBtn = findAddButton();
        if (addBtn) break;
        await wait(250);
      }

      if (addBtn) {
        triggerClick(addBtn);

        // Wait for file input or submenu option to appear
        for (let i = 0; i < 30; i++) {
          await wait(250);
          input = findFileInput();
          if (input) return input;

          const menuItems = [...document.querySelectorAll('[role="menuitem"], [role="option"], button, a, div, span')];
          const uploadFromComputer = menuItems.find(node => {
            if (node.children.length > 2) return false;
            const t = \`\${node.innerText || ''} \${node.textContent || ''} \${node.getAttribute('aria-label') || ''}\`.toLowerCase();
            return /(從電腦上傳|从电脑上传|本機|本机|upload from computer|from computer|local files?)/i.test(t);
          });
          if (uploadFromComputer) {
            triggerClick(uploadFromComputer);
            await wait(300);
            input = findFileInput();
            if (input) return input;
          }
        }
      }

      input = findFileInput();
      if (input) return input;

      const visibleButtons = [...document.querySelectorAll('button, [role="tab"]')].map(b => (b.innerText || b.textContent || '').trim()).filter(Boolean).slice(0, 10);
      throw new Error(\`找不到專案資料來源檔案上傳欄位。頁面按鈕: [\${visibleButtons.join(', ')}]，網址: \${location.href}\`);
    })()`;

    const evaluated = await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression,
      returnByValue: false,
      awaitPromise: true
    });
    const objectId = evaluated?.result?.objectId;
    if (!objectId) {
      const errorMsg = evaluated?.result?.description || evaluated?.exceptionDetails?.exception?.description || "找不到專案資料來源的檔案上傳欄位。";
      throw new Error(errorMsg);
    }

    await chrome.debugger.sendCommand(debuggee, "DOM.setFileInputFiles", {
      files: [filePath],
      objectId
    });

    await chrome.debugger.sendCommand(debuggee, "Runtime.evaluate", {
      expression: `(() => {
        const inputs = [...document.querySelectorAll('input[type="file"]')];
        const input = inputs.find(n => !n.closest('form[data-type="unified-composer"]'));
        if (input) {
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      })()`,
      returnByValue: true
    }).catch(() => {});

  } finally {
    if (attached) await chrome.debugger.detach(debuggee).catch(() => {});
  }
}

function localPathFromFileUrl(value = "") {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return "";
    let pathname = decodeURIComponent(url.pathname);
    if (/^\/[A-Za-z]:\//.test(pathname)) pathname = pathname.slice(1);
    return pathname.replaceAll("/", "\\");
  } catch {
    return "";
  }
}

async function waitForTabAtUrl(tabId, predicate, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    try {
      if (tab.status === "complete" && tab.url && predicate(tab.url)) return tab;
    } catch {
      // Keep waiting while a navigation is between URLs.
    }
    await delay(150);
  }
  throw new Error("等待 ChatGPT 專案頁載入逾時。");
}

async function startChatRenderPump(tabId, backend) {
  if (chatRenderPumps.has(tabId)) return;
  const debuggee = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, DEBUGGER_PROTOCOL_VERSION);
    attached = true;
    chatRenderPumps.set(tabId, backend);
    await chrome.debugger.sendCommand(debuggee, "Page.enable");
    await chrome.debugger.sendCommand(debuggee, "Page.setWebLifecycleState", { state: "active" }).catch(() => {});
    await chrome.debugger.sendCommand(debuggee, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
  } catch {
    chatRenderPumps.delete(tabId);
    if (attached) await chrome.debugger.detach(debuggee).catch(() => {});
  }
}

async function forceChatRender(tabId) {
  if (!chatRenderPumps.has(tabId)) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
      format: "jpeg",
      quality: 1,
      fromSurface: true,
      optimizeForSpeed: true,
      captureBeyondViewport: false
    });
  } catch {
    chatRenderPumps.delete(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

async function stopChatRenderPump(backend) {
  const entries = [...chatRenderPumps.entries()].filter(([, value]) => value === backend);
  for (const [tabId] of entries) {
    chatRenderPumps.delete(tabId);
    try {
      await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: false });
    } catch {}
    try {
      await chrome.debugger.detach({ tabId });
    } catch {}
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("找不到目前分頁。");
  return tab;
}

function looksLikePdf(tab) {
  const url = tab.url || "";
  return /\.pdf(?:$|[?#])/i.test(url) || /^file:\/\//i.test(url) && /\.pdf(?:$|[?#])/i.test(url);
}

async function capturePdfContext() {
  const tab = await getActiveTab();
  if (!looksLikePdf(tab)) {
    throw new Error("目前分頁看起來不是 PDF。請先切回 Chrome 內建 PDF Viewer。");
  }

  const debuggee = { tabId: tab.id };
  let attached = false;
  let pageState = null;
  let debuggerError = null;
  const childSessions = [];
  const executionContexts = [];
  const sessionSetup = [];
  const onDebuggerEvent = (source, method, params) => {
    if (source.tabId !== tab.id) return;
    if (method === "Runtime.executionContextCreated" && params?.context?.id) {
      executionContexts.push({
        session: source.sessionId ? { tabId: tab.id, sessionId: source.sessionId } : { tabId: tab.id },
        contextId: params.context.id,
        info: {
          type: "execution-context",
          url: params.context.origin || params.context.name || ""
        }
      });
      return;
    }
    if (method === "Target.attachedToTarget" && params?.sessionId) {
      const session = { tabId: tab.id, sessionId: params.sessionId };
      childSessions.push({ session, info: params.targetInfo || {} });
      sessionSetup.push(
        chrome.debugger.sendCommand(session, "Runtime.enable").catch(() => {}),
        chrome.debugger.sendCommand(session, "Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "iframe", exclude: false }]
        }).catch(() => {})
      );
    }
  };

  try {
    chrome.debugger.onEvent.addListener(onDebuggerEvent);
    await chrome.debugger.attach(debuggee, DEBUGGER_PROTOCOL_VERSION);
    attached = true;
    await chrome.debugger.sendCommand(debuggee, "Runtime.enable");
    await chrome.debugger.sendCommand(debuggee, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }]
    });

    // Chrome renders its built-in PDF viewer in an isolated extension iframe.
    // Evaluate the root plus every related debugger session instead of only the
    // outer file:// document.
    await delay(450);
    await Promise.allSettled(sessionSetup);
    await delay(150);
    const candidates = [
      { session: debuggee, info: { type: "page", url: tab.url } },
      ...childSessions,
      ...executionContexts
    ].sort((a, b) => pdfTargetScore(b.info, tab.url) - pdfTargetScore(a.info, tab.url));
    for (const candidate of candidates) {
      try {
        const state = await evaluatePdfViewer(candidate.session, candidate.contextId);
        if (state?.found) {
          pageState = state;
          break;
        }
      } catch {
        // Continue through the remaining iframe sessions.
      }
    }
    if (!pageState) {
      throw new Error(`找不到隔離的 PDF Viewer 執行環境（已檢查 ${candidates.length} 個目標）。`);
    }
  } catch (error) {
    debuggerError = error?.message || String(error);
  } finally {
    chrome.debugger.onEvent.removeListener(onDebuggerEvent);
    if (attached) {
      try {
        await chrome.debugger.detach(debuggee);
      } catch {
        // Ignore a detach race when Chrome closes or reloads the tab.
      }
    }
  }

  let screenshot = null;
  try {
    screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 82
    });
  } catch {
    // Text-only mode remains usable if screenshot capture is unavailable.
  }

  return {
    tabId: tab.id,
    title: tab.title || filenameFromUrl(tab.url),
    url: tab.url,
    pageNumber: pageState?.pageNumber || null,
    pageCount: pageState?.pageCount || null,
    pageRect: pageState?.rect || null,
    screenshot,
    warning: debuggerError || null,
    capturedAt: new Date().toISOString()
  };
}

function pdfTargetScore(info, pdfUrl) {
  const url = info?.url || "";
  let score = 0;
  if (/^chrome-extension:\/\/mhjfbmdgcfjbbpaeojofohoefgiehjai\//i.test(url)) score += 100;
  if (/pdf-viewer|pdf_viewer|index\.html/i.test(url)) score += 30;
  if (pdfUrl && url.includes(encodeURIComponent(pdfUrl))) score += 20;
  if (info?.type === "iframe") score += 10;
  return score;
}

async function evaluatePdfViewer(session, contextId) {
  const params = {
    expression: `(() => {
      const viewer = document.querySelector('pdf-viewer') || globalThis.viewer;
      if (!viewer) return { found: false };
      const viewport = viewer.viewport || viewer.viewport_;
      let zeroBased = null;
      try { zeroBased = viewport?.getMostVisiblePage?.(); } catch (_) {}
      let pageNumber = Number.isFinite(zeroBased) ? zeroBased + 1 : null;
      pageNumber ||= Number(viewer.pageNo_ || viewer.pageNo || 0) || null;
      const toolbar = viewer.shadowRoot?.querySelector('#toolbar');
      pageNumber ||= Number(toolbar?.pageNo || 0) || null;
      const pageCount = Number(viewer.docLength_ || viewer.docLength || toolbar?.docLength || 0) || null;
      let rect = null;
      try {
        const r = viewport?.getPageScreenRect?.((pageNumber || 1) - 1);
        if (r) rect = { x: r.x, y: r.y, width: r.width, height: r.height };
      } catch (_) {}
      return { found: true, pageNumber, pageCount, rect };
    })()`,
    returnByValue: true,
    awaitPromise: true
  };
  if (contextId) params.contextId = contextId;
  const evaluated = await chrome.debugger.sendCommand(session, "Runtime.evaluate", params);
  if (evaluated?.exceptionDetails) {
    throw new Error(evaluated.exceptionDetails.text || "無法讀取 PDF Viewer 狀態。");
  }
  return evaluated?.result?.value || null;
}

function filenameFromUrl(url = "") {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.split("/").pop() || "document.pdf");
  } catch {
    return "document.pdf";
  }
}

async function ensureChatGptTab(backend = "chat", pdfKey = "", projectUrl = "") {
  const tabKey = `chatgptTabId_${backend}`;
  const urlKey = `chatgptConversationUrl_${backend}`;
  const pdfKeyName = `chatgptPdfKey_${backend}`;
  const projectKey = `chatgptProjectUrl_${backend}`;
  const desiredProject = validProjectUrl(projectUrl);
  const stored = await chrome.storage.local.get([
    tabKey, urlKey, pdfKeyName, projectKey, "pdfConversations", "pdfConversationProjects"
  ]);
  const archivedUrl = pdfKey && stored.pdfConversations?.[pdfKey]?.[backend];
  const archivedProject = pdfKey && stored.pdfConversationProjects?.[pdfKey]?.[backend] || "";
  const archivedMatchesProject = archivedProject === desiredProject;
  if (stored[tabKey]) {
    try {
      const existing = await chrome.tabs.get(stored[tabKey]);
      if (existing.url?.startsWith(CHATGPT_HOME)) {
        const changedPdf = Boolean(pdfKey && stored[pdfKeyName] !== pdfKey);
        const changedProject = validProjectUrl(stored[projectKey] || "") !== desiredProject;
        if (changedPdf || changedProject) {
          const targetUrl = archivedMatchesProject && archivedUrl?.startsWith(CHATGPT_HOME)
            ? archivedUrl
            : desiredProject || CHATGPT_HOME;
          const moved = await chrome.tabs.update(existing.id, { url: targetUrl });
          await chrome.storage.local.set({
            [pdfKeyName]: pdfKey,
            [urlKey]: targetUrl,
            [projectKey]: desiredProject
          });
          return moved;
        }
        return existing;
      }
    } catch {
      await chrome.storage.local.remove(tabKey);
    }
  }

  const startUrl = archivedMatchesProject && archivedUrl?.startsWith(CHATGPT_HOME)
    ? archivedUrl
    : stored[urlKey]?.startsWith(CHATGPT_HOME) && (!pdfKey || stored[pdfKeyName] === pdfKey) &&
      validProjectUrl(stored[projectKey] || "") === desiredProject
      ? stored[urlKey]
      : desiredProject || CHATGPT_HOME;
  const tab = await chrome.tabs.create({ url: startUrl, active: false });
  await chrome.storage.local.set({
    [tabKey]: tab.id,
    [pdfKeyName]: pdfKey,
    [projectKey]: desiredProject
  });
  return tab;
}

async function savePdfConversation(pdfKey, backend, url, projectUrl = "") {
  if (!pdfKey || !url?.startsWith(CHATGPT_HOME) || url === CHATGPT_HOME) return;
  const stored = await chrome.storage.local.get(["pdfConversations", "pdfConversationProjects"]);
  const conversations = stored.pdfConversations || {};
  const projects = stored.pdfConversationProjects || {};
  conversations[pdfKey] ||= {};
  conversations[pdfKey][backend] = url;
  projects[pdfKey] ||= {};
  projects[pdfKey][backend] = validProjectUrl(projectUrl);
  await chrome.storage.local.set({ pdfConversations: conversations, pdfConversationProjects: projects });
}

async function waitForTab(tabId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return tab;
    await delay(250);
  }
  throw new Error("等待 ChatGPT 網頁載入逾時。");
}

async function sendToChatGpt(payload) {
  const backend = payload.backend === "work" ? "work" : "chat";
  const tab = await ensureChatGptTab(backend, payload.pdfKey || "", payload.projectUrl || "");
  await waitForTab(tab.id);
  await startChatRenderPump(tab.id, backend);

  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: "bridge_send_prompt",
        payload: { ...payload, backend }
      });
      if (!response?.ok) throw new Error(response?.error || "ChatGPT bridge rejected the request.");
      const current = await chrome.tabs.get(tab.id);
      if (current.url?.startsWith(CHATGPT_HOME)) {
        await chrome.storage.local.set({ [`chatgptConversationUrl_${backend}`]: current.url });
        await savePdfConversation(payload.pdfKey, backend, current.url, payload.projectUrl);
      }
      return { tabId: tab.id, requestId: payload.requestId, backend };
    } catch (error) {
      lastError = error;
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["chatgpt-bridge.js"] });
      } catch {
        // A reload may still be in progress; retry below.
      }
      await delay(600);
    }
  }
  await stopChatRenderPump(backend);
  throw new Error(`無法連接 ChatGPT 分頁：${lastError?.message || lastError}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function validProjectUrl(value = "") {
  try {
    const url = new URL(value);
    const projectPath = /^\/g\/g-p-[^/]+\/project\/?$/i.test(url.pathname) ||
      /^\/projects?\/[^/]+\/?$/i.test(url.pathname);
    if (url.origin !== "https://chatgpt.com" || !projectPath) return "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}
