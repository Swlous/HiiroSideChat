(() => {
  if (globalThis.__PDF_CHAT_SIDEBAR_BRIDGE__) return;
  globalThis.__PDF_CHAT_SIDEBAR_BRIDGE__ = true;
  const uploadedDocuments = globalThis.__PDF_CHAT_UPLOADED_DOCUMENTS__ ||= new Set();
  const streamWakeups = new Map();
  const activeStreams = new Set();
  const renamedConversations = globalThis.__HIIRO_RENAMED_CONVERSATIONS__ ||= new Set();

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "bridge_wake_stream") {
      streamWakeups.get(message.requestId)?.();
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === "bridge_resume_stream") {
      const payload = message.payload;
      if (!payload?.requestId) {
        sendResponse({ ok: false, error: "缺少等待中的請求資料。" });
        return false;
      }
      if (activeStreams.has(payload.requestId)) {
        streamWakeups.get(payload.requestId)?.();
        sendResponse({ ok: true, resumed: false });
        return false;
      }
      const messages = assistantMessages();
      const beforeState = {
        count: messages.length,
        latest: messages.at(-1) || null,
        identities: new Set(messages.map(messageIdentity).filter(Boolean)),
        latestUser: null,
        resumed: true
      };
      void streamLatestAnswer(payload, beforeState);
      sendResponse({ ok: true, resumed: true });
      return false;
    }
    if (message?.type === "bridge_list_projects") {
      collectProjects(Boolean(message.waitForLoad)).then((projects) => sendResponse({ ok: true, projects }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message?.type === "bridge_list_project_rows") {
      waitFor(projectDirectoryRows, 10000, "ChatGPT 專案列表尚未載入。")
        .then((rows) => sendResponse({ ok: true, rows }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message?.type === "bridge_open_project_row") {
      waitFor(
        () => findProjectDirectoryRow(message.name),
        12000,
        `找不到專案：${message.name || "未命名"}`
      ).then((row) => {
        sendResponse({ ok: true });
        setTimeout(() => (row.querySelector('[role="gridcell"]') || row).click(), 0);
      }).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message?.type === "bridge_probe_project_source") {
      probeProjectSource(message.filename)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message?.type === "bridge_wait_project_source") {
      waitForProjectSource(message.filename)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message?.type === "bridge_ensure_project_source") {
      ensureProjectSource(message.pdfFile)
        .then((result) => sendResponse({ ok: true, ...result }))
        .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message?.type !== "bridge_send_prompt") return false;
    let acknowledged = false;
    const acknowledge = (response) => {
      if (acknowledged) return;
      acknowledged = true;
      sendResponse(response);
    };
    runPrompt(message.payload, () => acknowledge({ ok: true }))
      .then(() => acknowledge({ ok: true }))
      .catch((error) => {
        const text = error?.message || String(error);
        if (!acknowledged) acknowledge({ ok: false, error: text });
        else emit({
          type: "chatgpt_stream",
          requestId: message.payload?.requestId,
          backend: message.payload?.backend,
          text,
          done: true,
          error: true
        });
      });
    return true;
  });

  async function runPrompt(payload, acknowledge) {
    if (document.querySelector('[data-testid="login-button"]') || /auth\/login/.test(location.pathname)) {
      throw new Error("ChatGPT 尚未登入。請按「開啟 ChatGPT」完成登入後再試。");
    }

    await ensureBackendMode(payload.backend || "chat");
    await ensureReasoningEffort(payload.reasoningEffort || "auto");
    const existingLimit = findQuotaNotice();
    if (existingLimit) {
      emitQuota(payload, existingLimit, "");
      return;
    }

    const beforeMessages = assistantMessages();
    const beforeLatest = beforeMessages.at(-1) || null;
    const beforeUsers = userMessages();
    const beforeState = {
      count: beforeMessages.length,
      latest: beforeLatest,
      identities: new Set(beforeMessages.map(messageIdentity).filter(Boolean)),
      latestUser: beforeUsers.at(-1) || null,
      resumed: false
    };
    if (payload.pdfFile && !uploadedDocuments.has(payload.pdfFile.key)) {
      await attachFile(payload.pdfFile.dataUrl, payload.pdfFile.name || "document.pdf", "application/pdf");
      uploadedDocuments.add(payload.pdfFile.key);
    }
    if (payload.screenshot) await attachFile(payload.screenshot, payload.imageName || "pdf-page.jpg", "image/jpeg");

    const composer = await waitFor(findComposer, 20000, "找不到 ChatGPT 輸入框。可能尚未登入，或網頁介面已更新。");
    setComposerText(composer, payload.prompt);

    const sendButton = await waitFor(findSendButton, 15000, "找不到可用的傳送按鈕。");
    const pageBeforeSend = location.href;
    // Acknowledge immediately before the click.  Project chats can replace the
    // whole document synchronously after this point, destroying the message
    // port even though ChatGPT accepted the prompt.
    acknowledge?.();
    sendButton.click();
    void streamLatestAnswer(payload, beforeState);

    // React occasionally leaves the composer untouched on the first click.
    // Retry exactly once only when the route did not change and no new user
    // turn appeared, which avoids duplicating a successfully submitted prompt.
    setTimeout(() => {
      if (location.href !== pageBeforeSend || findSubmittedUser(payload, beforeState)) return;
      const retryButton = findSendButton();
      if (retryButton && !retryButton.disabled) retryButton.click();
    }, 1200);
  }

  async function ensureBackendMode(backend) {
    const selected = [...document.querySelectorAll('[aria-pressed="true"], [aria-selected="true"], [data-state="checked"]')]
      .map((node) => normalizedText(node))
      .filter(Boolean);
    const workIsSelected = selected.some((text) => /^(work|工作)$/i.test(text));

    if (backend === "chat" && !workIsSelected) return;
    if (backend === "work" && workIsSelected) return;

    const targetPattern = backend === "work" ? /^(work|工作)$/i : /^(chat|聊天|對話|对话)$/i;
    const directTarget = visibleClickables().find((node) => targetPattern.test(normalizedText(node)));
    if (directTarget) {
      directTarget.click();
      await delay(500);
      if (backend === "chat" || isModeSelected(targetPattern)) return;
    }

    const trigger = visibleClickables().find((node) => {
      const text = `${normalizedText(node)} ${node.getAttribute("aria-label") || ""}`;
      return /mode|模式|chat|work|聊天|工作/i.test(text) && node.getAttribute("aria-haspopup");
    });
    trigger?.click();
    if (trigger) await delay(250);

    const menuTarget = visibleClickables().find((node) => targetPattern.test(normalizedText(node)));
    if (menuTarget) {
      menuTarget.click();
      await delay(500);
      return;
    }

    if (backend === "work") {
      throw new Error("無法自動切換到 Work。請按「開啟 Work」在該專用分頁手動選擇 Work，然後重試。");
    }
    if (workIsSelected) {
      throw new Error("無法自動切回普通 Chat。請按「開啟 Chat」在該專用分頁手動選擇 Chat，然後重試。");
    }
  }

  function isModeSelected(pattern) {
    return [...document.querySelectorAll('[aria-pressed="true"], [aria-selected="true"], [data-state="checked"]')]
      .some((node) => pattern.test(normalizedText(node)));
  }

  async function ensureReasoningEffort(effort) {
    if (!effort || effort === "auto") return;
    const labels = {
      low: /^(low|低|快速)$/i,
      medium: /^(medium|中|均衡)$/i,
      high: /^(high|高|深入)$/i,
      xhigh: /^(xhigh|x-high|extra high|最高|最深入)$/i
    };
    const target = labels[effort];
    if (!target) return;

    // ChatGPT currently exposes this as a compact button whose whole label can
    // be only "低 / 中 / 高".  Opening it reveals a four-position slider rather
    // than ordinary menu items, so matching only "推理 / Thinking" silently did
    // nothing on the current UI.
    const triggerPattern = /^(?:low|medium|high|xhigh|x-high|extra high|低|中|高|最高|快速|均衡|深入|最深入)$/i;
    const trigger = visibleClickables().find((node) => {
      if (!node.getAttribute("aria-haspopup")) return false;
      const text = accessibleText(node);
      return triggerPattern.test(text) || /thinking|reasoning|推理|思考|推理強度|思考強度/i.test(text);
    });

    if (!trigger) {
      throw new Error("找不到 ChatGPT 的推理強度控制。請確認目前模型支援可調推理，或選擇「跟隨 ChatGPT」。");
    }
    if (effortTextMatches(accessibleText(trigger), target)) return;

    if (trigger.getAttribute("aria-expanded") !== "true") {
      trigger.click();
      await delay(250);
    }

    let slider = await waitFor(() => [...document.querySelectorAll('[role="slider"]')]
      .find((node) => node.getClientRects().length && !node.hasAttribute("disabled")), 900).catch(() => null);

    if (slider) {
      const requestedIndex = { low: 0, medium: 1, high: 2, xhigh: 3 }[effort];
      const menuText = normalizedText(slider.closest('[role="menu"]') || slider.parentElement);
      const itemCount = Number(menuText.match(/(?:共|of)\s*(\d+)\s*(?:項|items?)/i)?.[1]) ||
        Number(slider.getAttribute("aria-valuemax")) + 1 || 4;
      if (requestedIndex >= itemCount) {
        closeReasoningControl(trigger);
        throw new Error(`目前 ChatGPT 只提供 ${itemCount} 檔推理強度，無法選擇 ${effort.toUpperCase()}。`);
      }

      slider.focus();
      const response = await chrome.runtime.sendMessage({
        type: "chatgpt_set_reasoning_effort",
        targetIndex: requestedIndex
      });
      if (!response?.ok) {
        closeReasoningControl(trigger);
        throw new Error(response?.error || "無法操作 ChatGPT 的推理強度滑桿。");
      }

      const applied = await waitFor(() => reasoningSliderMatches(slider, target, requestedIndex), 2500)
        .then(() => true)
        .catch(() => false);
      closeReasoningControl(trigger);
      if (!applied) {
        throw new Error(`ChatGPT 沒有套用 ${effort.toUpperCase()} 推理強度；該檔位可能被目前方案或模型鎖定。`);
      }
      await delay(200);
      return;
    }

    // In the latest compact composer the thumb is not exposed as role=slider
    // until the track receives a real pointer event.  Use the popup/track
    // geometry with a trusted CDP mouse event, then verify the resulting label.
    const menu = [...document.querySelectorAll('[role="menu"]')]
      .find((node) => node.getClientRects().length && /推理|思考|reasoning|thinking|第\s*\d+\s*項|item/i.test(accessibleText(node)));
    if (menu) {
      const requestedIndex = { low: 0, medium: 1, high: 2, xhigh: 3 }[effort];
      const menuText = accessibleText(menu);
      const itemCount = Number(menuText.match(/(?:共|of)\s*(\d+)\s*(?:項|items?)/i)?.[1]) || 4;
      const track = findReasoningTrack(menu);
      const rect = (track || menu).getBoundingClientRect();
      const response = await chrome.runtime.sendMessage({
        type: "chatgpt_set_reasoning_pointer",
        targetIndex: requestedIndex,
        itemCount,
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        menuFallback: !track
      });
      if (!response?.ok) {
        closeReasoningControl(trigger);
        throw new Error(response?.error || "無法操作 ChatGPT 的推理強度滑桿。");
      }
      await delay(250);
      slider = [...document.querySelectorAll('[role="slider"]')]
        .find((node) => node.getClientRects().length && !node.hasAttribute("disabled")) || null;
      const applied = slider
        ? reasoningSliderMatches(slider, target, requestedIndex)
        : effortTextMatches(accessibleText(menu), target) || effortTextMatches(accessibleText(trigger), target);
      closeReasoningControl(trigger);
      if (!applied) {
        throw new Error(`ChatGPT 沒有套用 ${effort.toUpperCase()} 推理強度；該檔位可能被目前方案或模型鎖定。`);
      }
      await delay(200);
      return;
    }

    // Compatibility with older/menu-based ChatGPT layouts.
    const option = visibleClickables().find((node) => node !== trigger && target.test(normalizedText(node)));
    if (!option) {
      closeReasoningControl(trigger);
      throw new Error(`目前 ChatGPT 介面或模型不提供 ${effort.toUpperCase()} 推理強度。請在設定中選擇「跟隨 ChatGPT」。`);
    }
    option.click();
    await delay(400);
  }

  function reasoningSliderMatches(slider, target, requestedIndex) {
    const value = Number(slider.getAttribute("aria-valuenow"));
    if (Number.isFinite(value) && value === requestedIndex) return true;
    const context = accessibleText(slider.closest('[role="menu"]') || slider.parentElement);
    return effortTextMatches(context, target);
  }

  function effortTextMatches(text, pattern) {
    return String(text || "").split(/[\s，,、·:：()（）]+/).some((part) => pattern.test(part.trim()));
  }

  function accessibleText(node) {
    if (!node) return "";
    const labelledBy = (node.getAttribute?.("aria-labelledby") || "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ");
    return [normalizedText(node), node.getAttribute?.("aria-label"), node.getAttribute?.("title"), labelledBy]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function findReasoningTrack(menu) {
    const menuRect = menu.getBoundingClientRect();
    const explicit = [...menu.querySelectorAll('input[type="range"], [data-orientation="horizontal"], [class*="slider" i]')]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 80 && rect.height > 1 && rect.height < 90 && node.getClientRects().length;
      })
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    if (explicit) return explicit;
    return [...menu.querySelectorAll("div, span")]
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > menuRect.width * .65 && rect.height >= 4 && rect.height <= 50 &&
          rect.top > menuRect.top + menuRect.height * .35 && node.getClientRects().length;
      })
      .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
  }

  function closeReasoningControl(trigger) {
    if (trigger?.getAttribute("aria-expanded") === "true") trigger.click();
  }

  function visibleClickables() {
    return [...document.querySelectorAll('button, [role="button"], [role="menuitem"], [role="option"]')]
      .filter((node) => {
        if (node.disabled || node.getAttribute("aria-hidden") === "true") return false;
        if (node.getClientRects?.().length > 0) return true;
        const style = window.getComputedStyle?.(node);
        return style && style.display !== "none" && style.visibility !== "hidden";
      });
  }

  function normalizedText(node) {
    return (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function findComposer() {
    return document.querySelector('#prompt-textarea') ||
      document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]') ||
      document.querySelector('textarea[placeholder]');
  }

  function setComposerText(element, text) {
    element.focus();
    if (element instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(element, text);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }

    element.replaceChildren();
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    element.appendChild(paragraph);
    element.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: text
    }));
  }

  function findSendButton() {
    const candidates = [
      document.querySelector('button[data-testid="send-button"]'),
      ...document.querySelectorAll('button[aria-label]')
    ].filter(Boolean);
    return candidates.find((button) => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`;
      return !button.disabled && (/send/i.test(label) || /傳送|发送|送出/.test(label) || button.dataset.testid === "send-button");
    }) || null;
  }

  async function attachFile(dataUrl, filename, mimeType) {
    const composer = findComposer();
    const composerRoot = composer?.closest("form") || composer?.parentElement?.parentElement || document;
    const beforeMarkers = attachmentMarkerCount(composerRoot);
    const fileInputs = () => [...document.querySelectorAll('input[type="file"]')];
    const wanted = mimeType === "application/pdf" ? /pdf|application|\*/i : /image|\*/i;
    let input = fileInputs().find((node) => wanted.test(node.accept || "")) ||
      composerRoot.querySelector?.('input[type="file"]') ||
      null;
    if (!input) {
      const buttons = [...document.querySelectorAll('button[aria-label], button')];
      const attach = document.querySelector('button[data-testid*="composer-plus"], button[data-testid*="attach"]') ||
        buttons.find((button) => /attach|upload|add photos|附件|附加|上傳|上传|新增|添加/i.test(
        `${button.getAttribute("aria-label") || ""} ${button.textContent || ""}`
        ));
      attach?.click();
      input = await waitFor(() => {
        const inputs = fileInputs();
        return inputs.find((node) => wanted.test(node.accept || "")) || inputs[0];
      }, 5000).catch(() => null);
    }

    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], filename, { type: blob.type || mimeType });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    if (input) {
      input.files = transfer.files;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const attachmentAppeared = () => {
      const text = normalizedText(composerRoot);
      return attachmentMarkerCount(composerRoot) > beforeMarkers || text.includes(filename);
    };
    if (await waitFor(attachmentAppeared, 12000).then(() => true).catch(() => false)) return;

    // Some ChatGPT builds consume files from the composer's drop handler rather
    // than a persistent input element. Use the same in-memory File as a fallback.
    if (composer) {
      for (const type of ["dragenter", "dragover", "drop"]) {
        composer.dispatchEvent(new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer
        }));
      }
    }
    if (await waitFor(attachmentAppeared, 12000).then(() => true).catch(() => false)) return;
    throw new Error(`${mimeType === "application/pdf" ? "完整 PDF" : "頁面畫面"}未成功附加到 ChatGPT；已停止傳送。`);
  }

  async function ensureProjectSource(pdfFile) {
    const filename = String(pdfFile?.name || "document.pdf").trim();
    if (!pdfFile?.dataUrl) throw new Error("缺少專案資料來源的 PDF 內容。");
    if (!/(?:\?|&)tab=sources(?:&|$)/.test(location.search) && !/資料來源|数据源|sources/i.test(document.body.innerText || "")) {
      throw new Error("目前不是 ChatGPT 專案的資料來源頁。");
    }

    await waitFor(
      () => document.querySelector('[role="tabpanel"], [aria-label="資料來源"], [aria-label="数据源"]') ||
        visibleClickables().find((node) => /新增資料來源|添加数据源|add (?:a )?source/i.test(accessibleText(node))),
      20000,
      "ChatGPT 專案資料來源尚未載入。"
    );
    if (projectSourceNode(filename)) {
      return { filename, alreadyExisted: true };
    }

    let input = projectSourceFileInput();
    if (!input) {
      const addSource = visibleClickables().find((node) =>
        /^(?:新增資料來源|添加数据源|add (?:a )?(?:project )?source)$/i.test(accessibleText(node))
      );
      addSource?.click();
      input = await waitFor(projectSourceFileInput, 5000, "找不到專案資料來源的檔案上傳欄位。");
    }

    const blob = await (await fetch(pdfFile.dataUrl)).blob();
    const file = new File([blob], filename, { type: blob.type || "application/pdf" });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    const appeared = await waitFor(() => projectSourceNode(filename), 60000,
      `已送出 ${filename}，但資料來源清單在期限內沒有顯示它。`);
    await waitFor(() => {
      const node = projectSourceNode(filename) || appeared;
      const container = node.closest?.('[role="row"], li, article, [data-testid*="source"], [class*="card"]') || node.parentElement || node;
      const text = accessibleText(container);
      const error = /上傳失敗|上传失败|upload failed|處理失敗|处理失败|processing failed/i.test(text);
      if (error) throw new Error(`${filename} 已出現在資料來源，但 ChatGPT 顯示處理失敗。`);
      return !/上傳中|上传中|uploading|處理中|处理中|processing|建立索引|创建索引|indexing/i.test(text);
    }, 90000, `${filename} 已加入資料來源，但仍在處理中。`);
    return { filename, alreadyExisted: false };
  }

  async function probeProjectSource(value) {
    const filename = String(value || "document.pdf").trim();
    await readyProjectSourcesPanel();
    return { filename, exists: Boolean(projectSourceNode(filename)) };
  }

  async function waitForProjectSource(value) {
    const filename = String(value || "document.pdf").trim();
    await readyProjectSourcesPanel();
    const appeared = await waitFor(() => projectSourceNode(filename), 60000,
      `已選擇 ${filename}，但資料來源清單在期限內沒有顯示它。`);
    await waitFor(() => {
      const node = projectSourceNode(filename) || appeared;
      const container = node.closest?.('[role="row"], li, article, [data-testid*="source"], [class*="card"]') || node.parentElement || node;
      const text = accessibleText(container);
      const error = /上傳失敗|上传失败|upload failed|處理失敗|处理失败|processing failed/i.test(text);
      if (error) throw new Error(`${filename} 已出現在資料來源，但 ChatGPT 顯示處理失敗。`);
      return !/上傳中|上传中|uploading|處理中|处理中|processing|建立索引|创建索引|indexing/i.test(text);
    }, 90000, `${filename} 已加入資料來源，但仍在處理中。`);
    return { filename, exists: true };
  }

  async function readyProjectSourcesPanel() {
    const switchTab = () => {
      const tabs = [...document.querySelectorAll('[role="tab"], button, a')];
      const sourcesTab = tabs.find((el) => /^(資料來源|数据源|sources)$/i.test((el.innerText || el.textContent || "").trim()));
      if (sourcesTab && sourcesTab.getAttribute("aria-selected") !== "true" && sourcesTab.getAttribute("data-state") !== "active") {
        sourcesTab.click();
      }
    };
    switchTab();

    if (!/(?:\?|&)tab=sources(?:&|$)/.test(location.search) && !/資料來源|数据源|sources/i.test(document.body.textContent || "")) {
      throw new Error("目前不是 ChatGPT 專案的資料來源頁。");
    }
    await waitFor(
      () => {
        switchTab();
        return document.querySelector('[role="tabpanel"], [aria-label*="來源"], [aria-label*="来源"], [aria-label*="Sources"], [data-testid*="source"]') ||
          visibleClickables().find((node) => /新增|添加|add|upload/i.test(accessibleText(node))) ||
          document.querySelector("main");
      },
      20000,
      "ChatGPT 專案資料來源尚未載入。"
    );
  }

  function projectSourceFileInput() {
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    return inputs.find((node) =>
      node.id !== "upload-files" &&
      !/image|video/i.test(node.accept || "") &&
      !node.closest('form[data-type="unified-composer"]')
    ) || null;
  }

  function projectSourceNode(filename) {
    const exact = String(filename || "").trim().toLocaleLowerCase();
    const stem = exact.replace(/\.pdf$/i, "");
    if (!stem) return null;
    const roots = [
      ...document.querySelectorAll([
        '[role="tabpanel"]',
        '[aria-label*="資料來源"]',
        '[aria-label*="数据源"]',
        '[aria-label*="Sources"]',
        '[data-testid*="source"]',
        'main'
      ].join(","))
    ];
    if (!roots.length && document.body) roots.push(document.body);
    for (const root of roots) {
      const candidates = root.querySelectorAll('a, button, [role="row"], tr, li, article, p, span, div, td');
      for (const node of candidates) {
        if (node.children.length > 8) continue;
        const text = (node.textContent || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
        if (text === exact || text === stem || (exact.length > 3 && text.includes(exact))) return node;
      }
    }
    return null;
  }

  function attachmentMarkerCount(root) {
    return root.querySelectorAll([
      '[data-testid*="attachment"]',
      '[data-testid*="file-thumbnail"]',
      'button[aria-label*="Remove file"]',
      'button[aria-label*="移除檔案"]',
      'button[aria-label*="移除文件"]',
      'img[src^="blob:"]'
    ].join(",")).length;
  }

  async function streamLatestAnswer(payload, beforeState) {
    if (activeStreams.has(payload.requestId)) return;
    activeStreams.add(payload.requestId);
    let lastText = "";
    let lastChange = Date.now();
    let idleSince = 0;
    let continuedOnce = false;
    let observedResponse = false;
    const started = Date.now();

    while (Date.now() - started < 5 * 60 * 1000) {
      const quotaNotice = findQuotaNotice();
      if (quotaNotice) {
        emitQuota(payload, quotaNotice, lastText);
        activeStreams.delete(payload.requestId);
        streamWakeups.delete(payload.requestId);
        return;
      }

      const messages = assistantMessages();
      const submittedUser = findSubmittedUser(payload, beforeState);
      const latest = submittedUser ? latestAssistantAfter(submittedUser) : messages.at(-1);
      const text = latest ? extractMessageText(latest) : "";
      const identity = messageIdentity(latest);
      // References, citations and late math hydration can mutate the previous
      // answer long after it completed.  Those changes must never be mistaken
      // for the answer to the newly submitted question.
      const isNewResponse = Boolean(latest && (submittedUser ||
        messages.length > beforeState.count ||
        identity && !beforeState.identities.has(identity)
      ));

      if (isNewResponse) observedResponse = true;
      const currentText = isNewResponse ? text : "";
      if (observedResponse && currentText !== lastText) {
        lastText = currentText;
        lastChange = Date.now();
        emit({ type: "chatgpt_stream", requestId: payload.requestId, backend: payload.backend, text: currentText, done: false });
      }

      const continueButton = findContinueButton(latest);
      if (continueButton && !continuedOnce) {
        continuedOnce = true;
        idleSince = 0;
        continueButton.click();
        await delay(800);
        continue;
      }

      const generating = isGenerating();
      if (!generating && observedResponse && lastText) {
        idleSince ||= Date.now();
      } else {
        idleSince = 0;
      }

      const explicitComplete = hasCompletionControls(latest);
      const quietFor = Date.now() - lastChange;
      const idleFor = idleSince ? Date.now() - idleSince : 0;
      if (idleSince && (
        explicitComplete && idleFor > 300 && quietFor > 450 ||
        !explicitComplete && idleFor > 30000 && quietFor > 30000
      )) {
        const domText = latest ? extractMessageText(latest) : lastText;
        const renderedMathCount = latest?.querySelectorAll?.('[role="math"], [data-math-source], .katex-display, math').length || 0;
        const domMathCount = countMathExpressions(domText);
        // The DOM is now the fast path.  Invoking ChatGPT's copy action used
        // to add up to three seconds after the answer was visibly complete.
        // Only fall back to that slow path if the page visibly contains math
        // but its source attributes could not be recovered.
        const needsCopyFallback = !domText || renderedMathCount > 0 && domMathCount === 0;
        const sourceText = explicitComplete && needsCopyFallback ? await captureCopiedSource(latest) : "";
        const finalText = chooseRicherMathSource(sourceText, domText || lastText);
        await ensureConversationTitle(payload.chatTitle).catch(() => {});
        emit({
          type: "chatgpt_stream",
          requestId: payload.requestId,
          backend: payload.backend,
          text: finalText,
          done: true,
          conversationUrl: location.href
        });
        activeStreams.delete(payload.requestId);
        streamWakeups.delete(payload.requestId);
        return;
      }
      await waitForDomActivity(payload.requestId, 1000);
    }

    emit({
      type: "chatgpt_stream",
      requestId: payload.requestId,
      backend: payload.backend,
      text: lastText || "等待回答逾時。請開啟 ChatGPT 分頁查看狀態。",
      done: true,
      error: true
    });
    activeStreams.delete(payload.requestId);
    streamWakeups.delete(payload.requestId);
  }

  function waitForDomActivity(requestId, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const root = document.querySelector("main") || document.body || document.documentElement;
      let observer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        if (timer) clearTimeout(timer);
        if (streamWakeups.get(requestId) === finish) streamWakeups.delete(requestId);
        resolve();
      };
      observer = new MutationObserver(finish);
      observer.observe(root, { subtree: true, childList: true, characterData: true });
      streamWakeups.set(requestId, finish);
      timer = setTimeout(finish, timeoutMs);
    });
  }

  function hasCompletionControls(latest) {
    const root = messageTurnRoot(latest);
    if (!root) return false;
    const selectors = [
      'button[data-testid="copy-turn-action-button"]',
      'button[data-testid*="turn-action"]',
      'button[aria-label*="Copy"]',
      'button[aria-label*="copy"]',
      'button[aria-label*="複製"]',
      'button[aria-label*="复制"]',
      'button[aria-label*="Good response"]',
      'button[aria-label*="Bad response"]'
    ];
    return Boolean(root.querySelector(selectors.join(",")));
  }

  function captureCopiedSource(latest) {
    const root = messageTurnRoot(latest);
    const copyButton = [...(root?.querySelectorAll([
      'button[data-testid="copy-turn-action-button"]',
      'button[aria-label*="Copy"]',
      'button[aria-label*="copy"]',
      'button[aria-label*="複製"]',
      'button[aria-label*="复制"]'
    ].join(",")) || [])].at(-1);
    if (!copyButton) return Promise.resolve("");

    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      let settled = false;
      const finish = (value = "") => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
        resolve(value);
      };
      const onMessage = (event) => {
        if (event.source !== window || event.data?.source !== "HiiroSideChatMain" || event.data?.id !== id) return;
        if (event.data.type === "copy-armed") {
          if (!event.data.ready) return finish("");
          copyButton.click();
        } else if (event.data.type === "clipboard-source") {
          finish(typeof event.data.text === "string" ? event.data.text.trim() : "");
        }
      };
      const timer = setTimeout(() => finish(""), 3000);
      window.addEventListener("message", onMessage);
      window.postMessage({ source: "HiiroSideChatBridge", type: "arm-copy", id }, "*");
    });
  }

  function chooseRicherMathSource(copiedText, domText) {
    const copied = normalizeMathSource(copiedText);
    const dom = normalizeMathSource(domText);
    if (!copied) return dom;
    if (!dom) return copied;
    return countMathExpressions(dom) > countMathExpressions(copied) ? dom : copied;
  }

  function normalizeMathSource(value) {
    return String(value || "")
      .replace(/```(?:latex|tex|math)\s*\n([\s\S]*?)```/gi, (_match, tex) => `\n$$${tex.trim()}$$\n`)
      .trim();
  }

  function countMathExpressions(value) {
    return (String(value || "").match(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$(?:\\.|[^$\n])+\$/g) || []).length;
  }

  async function ensureConversationTitle(title) {
    const cleanTitle = String(title || "").trim().slice(0, 80);
    const conversationKey = location.pathname;
    if (!cleanTitle || !/\/c\//.test(conversationKey) || renamedConversations.has(conversationKey)) return;

    try {
      const anchor = [...document.querySelectorAll('a[href]')].find((node) => {
        try { return new URL(node.href).pathname === conversationKey; } catch { return false; }
      });
      const row = anchor?.closest("li") || anchor?.closest('[data-testid*="conversation"]') || anchor?.parentElement;
      if (!row) return;
      row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      await delay(250);

      const menuButton = [...row.querySelectorAll("button")].find((button) => {
        const label = `${button.getAttribute("aria-label") || ""} ${button.title || ""}`;
        return /more|options|menu|更多|選項|选项/i.test(label);
      }) || row.querySelector("button");
      if (!menuButton) return;
      menuButton.click();
      await delay(250);

      const rename = visibleClickables().find((node) => /^(rename|重新命名|重命名)$/i.test(normalizedText(node)));
      if (!rename) return;
      rename.click();
      const input = await waitFor(() => document.querySelector('[role="dialog"] input, input[name="title"]'), 2500).catch(() => null);
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, cleanTitle);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
      renamedConversations.add(conversationKey);
    } catch {
      // Conversation naming is cosmetic; never block delivery of an answer.
    }
  }

  function isGenerating() {
    const selector = [
      'button[data-testid="stop-button"]',
      'button[data-testid*="stop"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]',
      'button[aria-label*="停止"]',
      'button[title*="Stop"]',
      'button[title*="停止"]'
    ].join(",");
    return Boolean(document.querySelector(selector) || visibleClickables().find((button) => {
      const label = `${normalizedText(button)} ${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""}`;
      return /stop generating|停止生成|停止產生|停止回答/i.test(label);
    }));
  }

  function findContinueButton(latest) {
    const root = latest?.closest('[data-testid^="conversation-turn"], article') || document;
    return [...root.querySelectorAll('button, [role="button"]')].filter((node) => node.getClientRects().length).find((button) => {
      const label = `${normalizedText(button)} ${button.getAttribute("aria-label") || ""}`;
      return /continue generating|繼續生成|继续生成|繼續產生|繼續回答/i.test(label);
    }) || null;
  }

  function messageIdentity(element) {
    if (!element) return "";
    const turn = element.closest('[data-message-id], [data-testid^="conversation-turn"], article');
    return element.getAttribute("data-message-id") || turn?.getAttribute("data-message-id") ||
      turn?.getAttribute("data-testid") || turn?.id || "";
  }

  function messageTurnRoot(element) {
    // The response action buttons are siblings of the inner data-message-id
    // node in current ChatGPT builds.  Prefer the outer turn, otherwise the
    // completion detector waits for its 30-second silence fallback.
    return element?.closest('[data-testid^="conversation-turn"]') ||
      element?.closest("article") ||
      element?.closest("[data-message-id]") || element || null;
  }

  async function collectProjects(waitForLoad = false) {
    const projectPattern = /^\/g\/g-p-[^/]+\/project\/?$|^\/projects?\/[^/]+\/?$/i;
    const read = () => {
      const found = new Map();
      for (const anchor of document.querySelectorAll("a[href]")) {
        let url;
        try { url = new URL(anchor.href, location.origin); } catch { continue; }
        if (url.origin !== "https://chatgpt.com" || !projectPattern.test(url.pathname)) continue;
        url.search = "";
        url.hash = "";
        const name = (anchor.getAttribute("aria-label") || normalizedText(anchor) || "未命名專案")
          .replace(/^(?:開啟|打开|open)\s*/i, "")
          .replace(/\s*(?:專案|项目|project)$/i, "")
          .replace(/新增專案|新建项目|new project/ig, "")
          .trim();
        if (name) found.set(url.href, { name, url: url.href });
      }
      return [...found.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
    };
    let projects = read();
    if (projects.length) return projects;
    const trigger = visibleClickables().find((node) => node.tagName === "BUTTON" &&
      /(?:^|\s)(專案|项目|projects?)(?:\s|$)/i.test(accessibleText(node)));
    if (trigger && trigger.getAttribute("aria-expanded") !== "true") {
      trigger.click();
      await delay(500);
      projects = read();
    }
    if (waitForLoad && !projects.length) {
      for (let attempt = 0; attempt < 12 && !projects.length; attempt += 1) {
        await delay(250);
        projects = read();
      }
    }
    return projects;
  }

  function projectDirectoryRows() {
    const rows = [...document.querySelectorAll('[data-page-table-selectable-row="true"], [role="row"][aria-selected]')];
    const names = rows.map((row) => projectNameFromRow(row)).filter(Boolean);
    return names.length ? [...new Set(names)] : null;
  }

  function projectNameFromRow(row) {
    const actionLabel = [...row.querySelectorAll('button[aria-label]')]
      .map((button) => button.getAttribute("aria-label") || "")
      .find((label) => /專案選項|项目选项|project options/i.test(label));
    const fromAction = actionLabel?.match(/^(?:開啟|打开|open)\s+(.+?)\s+(?:的)?(?:專案選項|项目选项|project options)$/i)?.[1];
    if (fromAction) return fromAction.trim();
    const cell = row.querySelector('[role="gridcell"]');
    const candidate = [...(cell?.querySelectorAll("div, span") || [])]
      .filter((node) => !node.children.length && normalizedText(node))
      .map(normalizedText)
      .find((text) => !/^(今天|today|昨天|yesterday)$/i.test(text));
    return candidate || "";
  }

  function findProjectDirectoryRow(name) {
    const wanted = String(name || "").trim();
    return [...document.querySelectorAll('[data-page-table-selectable-row="true"], [role="row"][aria-selected]')]
      .find((row) => projectNameFromRow(row) === wanted) || null;
  }

  function findQuotaNotice() {
    const pattern = /(?:you(?:'ve| have)?\s+(?:reached|hit)\s+(?:the\s+)?(?:current\s+)?(?:usage|message|rate)?\s*limit|usage limit reached|rate limit(?:ed| exceeded)?|limit resets?\s+(?:at|in)|已(?:達到|达到|用完|耗盡|耗尽).{0,40}(?:使用限制|用量上限|訊息上限|消息上限|額度|额度)|(?:使用限制|用量上限|訊息上限|消息上限|額度|额度).{0,30}(?:已達到|已达到|已用完|不足))/i;
    const selectors = [
      '[role="alert"]',
      '[role="dialog"]',
      '[data-testid*="limit"]',
      '[data-testid*="error"]',
      '[class*="toast"]'
    ];
    const candidates = [...document.querySelectorAll(selectors.join(","))];
    for (const node of candidates) {
      const text = normalizedText(node);
      if (text.length <= 1200 && pattern.test(text)) return text;
    }

    // Some ChatGPT limit notices are inline rather than alerts. Only consider
    // short visible blocks so ordinary assistant discussions of "limits" do not trigger failover.
    const inlineCandidates = [...document.querySelectorAll("main p, main [data-message-author-role='system'], main [class*='error']")].slice(-16);
    for (const node of inlineCandidates) {
      if (!node.getClientRects().length) continue;
      const text = normalizedText(node);
      if (text.length <= 500 && pattern.test(text)) return text;
    }
    return "";
  }

  function emitQuota(payload, reason, partialText) {
    emit({
      type: "chatgpt_quota",
      requestId: payload.requestId,
      backend: payload.backend,
      reason,
      partialText: partialText || ""
    });
  }

  function assistantMessages() {
    return [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  }

  function userMessages() {
    return [...document.querySelectorAll('[data-message-author-role="user"]')];
  }

  function findSubmittedUser(payload, beforeState) {
    const latest = userMessages().at(-1) || null;
    if (!latest) return null;
    if (!beforeState.resumed && latest === beforeState.latestUser) return null;

    const actual = normalizedText(latest);
    const expected = normalizedTextValue(payload.prompt || "");
    const signature = expected.slice(-Math.min(240, expected.length));
    if (signature && actual.includes(signature)) return latest;

    const question = normalizedTextValue(payload.question || "");
    if (question && actual.includes(`問題： ${question}`)) return latest;
    // A project navigation can hydrate a visually shortened user bubble whose
    // textContent no longer contains the tail of the submitted prompt.  Resume
    // heartbeats only begin after bridge_send_prompt has acknowledged the
    // click, so the newest user turn is the safe fallback on the new page.
    if (beforeState.resumed) return latest;
    return latest !== beforeState.latestUser ? latest : null;
  }

  function latestAssistantAfter(user) {
    const ordered = [...document.querySelectorAll("[data-message-author-role]")];
    const userIndex = ordered.indexOf(user);
    if (userIndex < 0) return null;
    return ordered.slice(userIndex + 1)
      .filter((node) => node.getAttribute("data-message-author-role") === "assistant")
      .at(-1) || null;
  }

  function normalizedTextValue(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function extractMessageText(element) {
    const clone = element.cloneNode(true);

    const texAnnotation = (node) => [...(node.querySelectorAll?.("annotation") || [])]
      .find((item) => /(?:^|[\/+.-])tex(?:$|[;\s+.-])/i.test(item.getAttribute("encoding") || ""));
    const texOf = (node) => texAnnotation(node)?.textContent?.trim() ||
      node.getAttribute?.("data-math-source")?.trim() ||
      node.getAttribute?.("data-latex")?.trim() || node.getAttribute?.("data-tex")?.trim() ||
      node.getAttribute?.("data-math")?.trim() || node.getAttribute?.("data-formula")?.trim() ||
      node.getAttribute?.("alttext")?.trim() || node.getAttribute?.("aria-label")?.trim() || "";
    const replaceMath = (node, display) => {
      if (!clone.contains(node)) return;
      const tex = texOf(node);
      if (tex) node.replaceWith(document.createTextNode(display ? `\n$$${tex}$$\n` : `$${tex}$`));
    };

    // Since September 2026, ChatGPT can render KaTeX without a MathML
    // annotation.  The TeX then lives on the *parent* span as
    // data-math-source/aria-label, while .katex-display contains only an
    // aria-hidden visual tree.  Process outer source-bearing nodes first so
    // removing aria-hidden content below cannot erase a whole formula line.
    const mathCarriers = [...clone.querySelectorAll([
      '[role="math"]',
      '[data-math-source]',
      '.katex-display',
      '.math-display',
      '[class*="math-display"]',
      'math[display="block"]',
      '[data-math-style="display"]'
    ].join(","))];
    for (const node of mathCarriers) {
      const display = node.matches?.('.katex-display, .math-display, [class*="math-display"], math[display="block"], [data-math-style="display"]') ||
        node.style?.display === "block" ||
        Boolean(node.querySelector?.('.katex-display, .math-display, [class*="math-display"], math[display="block"]'));
      replaceMath(node, Boolean(display));
    }
    for (const node of [...clone.querySelectorAll('.katex, math[alttext], [data-latex], [data-tex]')]) {
      replaceMath(node, false);
    }
    for (const annotation of [...clone.querySelectorAll("annotation")].filter((item) => /tex/i.test(item.getAttribute("encoding") || ""))) {
      const target = annotation.closest('.katex-display, .math-display, [class*="math-display"], math') || annotation.parentElement;
      const display = target?.matches?.('.katex-display, .math-display, [class*="math-display"], math[display="block"]');
      replaceMath(target, Boolean(display));
    }
    for (const noisy of clone.querySelectorAll('button, svg, [aria-hidden="true"]')) noisy.remove();
    return (clone.textContent || "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function emit(message) {
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  async function waitFor(getter, timeoutMs, failureMessage = "等待網頁元素逾時。") {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const value = getter();
      if (value) return value;
      await delay(150);
    }
    throw new Error(failureMessage);
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
