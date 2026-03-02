// ==UserScript==
// @name         Twitter DM to Obsidian
// @namespace    https://github.com/user/twitter-dm-to-obsidian
// @version      3.7.0
// @description  将 Twitter/X DM 消息（转发推文）批量导入 Obsidian，支持删除已载入消息
// @author       user
// @match        https://twitter.com/messages/*
// @match        https://x.com/messages/*
// @match        https://x.com/i/chat/*
// @grant        GM_xmlhttpRequest
// @connect      t.co
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── 用户配置（仅需修改这里）────────────────────────────────────────────────
  const CONFIG = {
    vault:           '',  // Obsidian vault 名称（留空=使用当前已打开的 vault，填写后区分大小写）
    dailyNoteFolder: '',  // Daily Note 子目录，空=根目录
  };

  // ─── DOM 选择器 ──────────────────────────────────────────────────────────────
  const SEL = {
    messageList:  '[data-testid="dm-message-list"]',
    messageItem:  '[data-testid^="message-"]',
    moreBtn:      '[data-testid="dm-conversation-more-button"]',
    // 转发推文卡片的 <a> 链接（href 即原始推文 URL）
    tweetCard:    'a[href*="/status/"]',
    // 推文正文：span[dir="auto"] 内的第一个 span 子节点
    tweetText:    'span[dir="auto"] > span',
    // 推文作者显示名（card header 内 hover-card-trigger 里的 font-bold）
    tweetAuthor:  '[data-slot="hover-card-trigger"] [class*="font-bold"]',
    // 推文相对时间戳（card header 内 text-gray-800 元素）
    tweetTime:    '[class*="text-gray-800"]',
    // hover 后出现的操作按钮区（初始为空的 div）
    actionsArea:  '[style*="grid-area: actions"]',
  };

  // ─── 工具函数 ────────────────────────────────────────────────────────────────

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // 派发 hover 相关事件触发 React 渲染操作按钮（mouseover 需要冒泡以命中事件委托）
  function dispatchHoverEvents(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    ['pointerover', 'mouseover', 'pointermove', 'mousemove'].forEach(t =>
      el.dispatchEvent(new MouseEvent(t, opts))
    );
    ['pointerenter', 'mouseenter'].forEach(t =>
      el.dispatchEvent(new MouseEvent(t, { ...opts, bubbles: false }))
    );
  }

  /**
   * 点击所有 "Show more" 按钮展开截断文字（纯本地操作，无网络请求）
   * 通过 React props.onClick 直接调用，比 .click() 更可靠
   * 返回展开的按钮数量
   */
  async function expandShowMore() {
    const spans = [...document.querySelectorAll('span')]
      .filter(el => el.textContent.trim() === 'Show more');

    for (const span of spans) {
      const propsKey = Object.keys(span).find(k => k.startsWith('__reactProps'));
      const onClick = propsKey && span[propsKey]?.onClick;
      if (onClick) {
        // React 合成事件要求有 preventDefault/stopPropagation 等方法
        const noop = () => {};
        onClick({
          type: 'click',
          target: span,
          currentTarget: span,
          bubbles: true,
          cancelable: true,
          preventDefault: noop,
          stopPropagation: noop,
          stopImmediatePropagation: noop,
          persist: noop,
          isDefaultPrevented: () => false,
          isPropagationStopped: () => false,
          nativeEvent: { preventDefault: noop, stopPropagation: noop },
        });
      } else {
        span.click(); // fallback
      }
      await sleep(30);
    }

    if (spans.length > 0) await sleep(200); // 等待 React 重渲染
    return spans.length;
  }

  // ─── t.co 短链展开 ──────────────────────────────────────────────────────────

  // 展开结果缓存（同一页面会话内复用，避免重复请求）
  const urlCache = new Map();

  /**
   * 展开单个 t.co 短链，返回最终 URL
   * 使用 GM_xmlhttpRequest 绕过 x.com 的 CSP connect-src 限制
   */
  async function expandTcoUrl(url) {
    if (!url.includes('t.co/')) return url; // 非短链直接返回
    if (urlCache.has(url)) return urlCache.get(url);

    // GM_xmlhttpRequest 绕过 x.com 的 CSP connect-src 限制
    function gmExpand(u) {
      return new Promise(resolve => {
        GM_xmlhttpRequest({
          method: 'HEAD', url: u,
          onload:  r => resolve(r.finalUrl || u),
          onerror: () => resolve(u),
        });
      });
    }

    try {
      const expanded = await gmExpand(url);
      urlCache.set(url, expanded);
      return expanded;
    } catch {
      // 网络错误：保留原始 t.co 链接
      urlCache.set(url, url);
      return url;
    }
  }

  /**
   * 并行展开一批消息中所有 extraLinks 的 t.co 短链
   * 限制并发为 5，避免触发速率限制
   */
  async function resolveExtraLinks(messages) {
    // 收集所有需要展开的唯一 t.co URL
    const tcoUrls = [...new Set(
      messages.flatMap(m => (m.extraLinks || []).map(l => l.href).filter(h => h.includes('t.co/')))
    )];

    if (!tcoUrls.length) return messages;

    // 分批并发（每批 5 个）
    const BATCH = 5;
    for (let i = 0; i < tcoUrls.length; i += BATCH) {
      await Promise.all(tcoUrls.slice(i, i + BATCH).map(u => expandTcoUrl(u)));
    }

    // 用缓存结果替换 extraLinks 中的 href
    return messages.map(msg => ({
      ...msg,
      extraLinks: (msg.extraLinks || []).map(link => ({
        ...link,
        href: urlCache.get(link.href) ?? link.href,
      })),
    }));
  }

  // ─── 消息提取 ────────────────────────────────────────────────────────────────

  /**
   * 从单个消息元素提取数据
   * 优先取转发推文卡片（URL + 正文）；fallback 取纯文字
   * 返回 {url, text} 或 null（无法提取则跳过）
   */
  function parseMessage(msgEl) {
    // 内容区域（grid-area: content）下的所有 <a>
    // 注意：<a> 嵌套 <a> 是非法 HTML，浏览器解析后链接预览卡会变成兄弟节点
    const contentArea = msgEl.querySelector('[style*="grid-area: content"]');
    const allLinks = contentArea
      ? [...contentArea.querySelectorAll('a[href]')]
      : [...msgEl.querySelectorAll(SEL.tweetCard)];

    // 主推文卡片：第一个指向 /status/ 的链接
    const card = allLinks.find(a => a.href.includes('/status/'));

    if (card) {
      // 推文作者显示名
      const author = card.querySelector(SEL.tweetAuthor)?.textContent?.trim() || '';

      // 相对时间戳（如 "22h"）
      const time = card.querySelector(SEL.tweetTime)?.textContent?.trim() || '';

      // 推文正文：取 card 内 span[dir="auto"] > span 的第一段纯文字
      let text = '';
      for (const el of card.querySelectorAll(SEL.tweetText)) {
        const t = el.textContent.trim();
        if (t) { text = t; break; }
      }

      // 媒体：视频（video.twimg.com URL 长期有效）和推文内容图片（跳过头像）
      const media = [];
      for (const v of card.querySelectorAll('video[src]')) {
        media.push({ type: 'video', src: v.src });
      }
      for (const img of card.querySelectorAll('img:not([alt="user avatar"])')) {
        if (img.src) media.push({ type: 'image', src: img.src });
      }

      // 额外链接：内容区内所有非推文状态页的链接（链接预览卡、t.co 等）
      const extraLinks = [];
      for (const a of allLinks) {
        if (a === card) continue;
        const href = a.href;
        if (!href || !href.startsWith('http')) continue;
        // 来源域名标签（"From github.com"）或链接文字
        const sourceLabel = a.querySelector('[class*="text-gray-5"], [class*="subtext2"]')
          ?.textContent?.trim();
        extraLinks.push({ href, label: sourceLabel || '' });
      }

      return { url: card.href, author, time, text, media, extraLinks };
    }

    // fallback：纯文字消息（无推文卡片）
    const parts = [];
    for (const el of msgEl.querySelectorAll(SEL.tweetText)) {
      const t = el.textContent.trim();
      if (t) parts.push(t);
    }
    if (parts.length) return { url: '', text: parts.join('\n'), extraLinks: [] };

    return null;
  }

  /**
   * 遍历虚拟列表中当前已渲染的所有 <li>
   * 返回 [{liEl, msgEl, url, text}]
   */
  function scrapeLoadedMessages() {
    const ul = document.querySelector(`${SEL.messageList} ul`);
    if (!ul) return [];

    const result = [];
    for (const li of ul.querySelectorAll('li')) {
      const msgEl = li.querySelector(SEL.messageItem);
      if (!msgEl) continue;
      const data = parseMessage(msgEl);
      if (data) result.push({ liEl: li, msgEl, ...data });
    }
    return result;
  }

  // ─── Markdown 格式化 ──────────────────────────────────────────────────────────
  //
  // 输出格式（无 header/footer）：
  //
  // Logseq outliner 格式（子 bullet 用 tab 缩进）：
  //
  // - 作者名 [Mar 1](https://x.com/i/status/...)
  // \t- 推文正文（多行文本合并为单条 bullet）
  // \t- 🎬 [视频](https://video.twimg.com/...)
  // \t- 🔗 [链接标题](https://...)
  //
  // - 纯文字消息内容

  function formatMarkdown(messages) {
    const lines = [];

    for (const { url, author = '', time = '', text, media = [], extraLinks = [] } of messages) {
      if (url) {
        // 第一行：作者 + 时间戳链接
        const timeLink = `[${time || 'Tweet'}](${url})`;
        lines.push(`- ${author ? `${author} ` : ''}${timeLink}`);

        // 正文：合并为单条子 bullet，多行文本保持连续缩进
        if (text) {
          lines.push(`\t- ${text.replace(/\n/g, '\n\t  ')}`);
        }

        // 媒体
        for (const { type, src } of media) {
          if (type === 'video') lines.push(`\t- 🎬 [视频](${src})`);
          else lines.push(`\t- ![](${src})`);
        }

        // 额外链接
        for (const { href, label } of extraLinks) {
          lines.push(`\t- 🔗 ${label ? `[${label}](${href})` : href}`);
        }
      } else {
        // 纯文字消息（无推文卡片，直接顶级 bullet）
        lines.push(`- ${text}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  // ─── Obsidian URI 导出 ────────────────────────────────────────────────────────

  const URI_MAX = 8000;

  async function exportToObsidian(btn) {
    const ul = document.querySelector(`${SEL.messageList} ul`);
    if (!ul) {
      alert('未找到消息列表，请确认已打开一个 DM 对话');
      return;
    }

    // 展开所有截断的推文正文
    btn.textContent = '⏳ 展开中...';
    btn.disabled = true;
    const expanded = await expandShowMore();
    if (expanded > 0) console.log(`[DM→Obsidian] 展开了 ${expanded} 个 Show more`);

    let messages = scrapeLoadedMessages();
    if (!messages.length) {
      btn.textContent = '📥 Obsidian';
      btn.disabled = false;
      alert('未找到可导出的消息内容');
      return;
    }

    // 展开 t.co 短链（如 CORS 阻断则静默保留原始链接）
    const tcoCount = messages.reduce((n, m) => n + (m.extraLinks || []).filter(l => l.href.includes('t.co/')).length, 0);
    if (tcoCount > 0) {
      btn.textContent = `⏳ 展开链接 (${tcoCount})...`;
      messages = await resolveExtraLinks(messages);
    }

    const markdown = formatMarkdown(messages);

    // 用 encodeURIComponent 构造 URI，避免 URLSearchParams 把空格编为 +
    const buildUri = (data) => {
      let u = `obsidian://advanced-uri?daily=true&mode=append&data=${encodeURIComponent(data)}`;
      if (CONFIG.vault) u += `&vault=${encodeURIComponent(CONFIG.vault)}`;
      if (CONFIG.dailyNoteFolder) u += `&dailyNotePath=${encodeURIComponent(CONFIG.dailyNoteFolder)}`;
      return u;
    };

    let dataStr = '\n' + markdown;
    let uri = buildUri(dataStr);

    if (uri.length > URI_MAX) {
      alert(`内容超过 ${URI_MAX} 字符（共 ${messages.length} 条），将截断导出。`);
      // 每次削减 100 字符直到满足长度上限
      while (uri.length > URI_MAX && dataStr.length > 100) {
        dataStr = dataStr.slice(0, dataStr.length - 100);
        uri = buildUri(dataStr);
      }
    }

    btn.textContent = '⏳ 导出中...';
    window.location.href = uri;

    setTimeout(() => {
      btn.textContent = '✅ 已导出';
      btn.disabled = false;
      setTimeout(() => { btn.textContent = '📥 Obsidian'; }, 2000);
    }, 1000);
  }

  // ─── 删除逻辑 ────────────────────────────────────────────────────────────────

  /**
   * 删除单条消息（hover → 操作按钮 → Delete → 确认）
   * ⚠️ 依赖 React 响应 JS 派发的鼠标事件，可能失效
   */
  async function deleteSingleMessage(liEl, msgEl) {
    liEl.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(120);

    dispatchHoverEvents(msgEl);
    await sleep(350);

    const actionsDiv = msgEl.querySelector(SEL.actionsArea);
    if (!actionsDiv) return false;

    const btns = actionsDiv.querySelectorAll('button');
    if (!btns.length) return false;

    // 点击最后一个按钮（通常是 "..." 更多操作）
    btns[btns.length - 1].click();
    await sleep(300);

    // 在浮动菜单中找 Delete/删除
    let deleteItem = null;
    for (const item of document.querySelectorAll('[role="menuitem"]')) {
      const t = item.textContent.trim().toLowerCase();
      if (t === 'delete' || t === '删除') { deleteItem = item; break; }
    }

    if (!deleteItem) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(100);
      return false;
    }

    deleteItem.click();
    await sleep(300);

    // 处理二次确认弹窗（如有）
    for (const btn of document.querySelectorAll('[role="dialog"] button, [role="alertdialog"] button')) {
      const t = btn.textContent.trim().toLowerCase();
      if (t === 'delete' || t === '删除' || t === 'confirm') {
        btn.click();
        await sleep(200);
        return true;
      }
    }

    return true; // 无二次确认弹窗视为成功
  }

  async function deleteAllMessages(deleteBtn) {
    const messages = scrapeLoadedMessages();
    if (!messages.length) {
      alert('未找到已载入的消息');
      return;
    }

    if (!window.confirm(
      `确认删除已载入的 ${messages.length} 条消息？\n\n` +
      `⚠️ 不可撤销，仅删除你这侧的记录。\n` +
      `⚠️ 若失败率高，请手动删除（删除功能依赖鼠标 hover 触发）。`
    )) return;

    deleteBtn.disabled = true;
    let success = 0, fail = 0;

    for (const { liEl, msgEl } of messages) {
      if (!document.contains(liEl)) continue;
      deleteBtn.textContent = `⏳ ${success + fail + 1}/${messages.length}`;
      await deleteSingleMessage(liEl, msgEl) ? success++ : fail++;
    }

    deleteBtn.disabled = false;
    deleteBtn.textContent = fail === 0
      ? `✅ 删除 ${success} 条`
      : `⚠️ ${success} 成功 / ${fail} 失败`;

    if (fail > 0) {
      alert(`${success} 条成功，${fail} 条失败。\n请手动删除剩余消息。`);
    }

    setTimeout(() => { deleteBtn.textContent = '🗑️ 删除已载入'; }, 4000);
  }

  // ─── 按钮注入 ────────────────────────────────────────────────────────────────

  function makeBtn(id, label, color, hoverColor) {
    const btn = document.createElement('button');
    btn.id = id;
    btn.textContent = label;
    Object.assign(btn.style, {
      backgroundColor: color,
      color: '#fff',
      border: 'none',
      borderRadius: '9999px',
      padding: '0 12px',
      height: '36px',
      fontSize: '13px',
      fontWeight: '600',
      cursor: 'pointer',
      whiteSpace: 'nowrap',
      flexShrink: '0',
      transition: 'background-color 0.15s',
    });
    btn.addEventListener('mouseover', () => { if (!btn.disabled) btn.style.backgroundColor = hoverColor; });
    btn.addEventListener('mouseout',  () => { if (!btn.disabled) btn.style.backgroundColor = color; });
    return btn;
  }

  function tryInjectButtons() {
    if (!/\/messages\/.+|\/i\/chat\/.+/.test(window.location.pathname)) return;
    if (document.getElementById('obsidian-export-btn')) return;

    const moreBtn = document.querySelector(SEL.moreBtn);
    if (!moreBtn) return;

    const container = moreBtn.parentElement;
    if (!container) return;

    const exportBtn = makeBtn('obsidian-export-btn', '📥 Obsidian', '#7c3aed', '#6d28d9');
    exportBtn.title = '将已载入消息保存到 Obsidian Daily Note';
    exportBtn.addEventListener('click', () => exportToObsidian(exportBtn));

    const deleteBtn = makeBtn('obsidian-delete-btn', '🗑️ 删除已载入', '#dc2626', '#b91c1c');
    deleteBtn.title = '逐条删除已载入的消息（不可撤销）';
    deleteBtn.addEventListener('click', () => deleteAllMessages(deleteBtn));

    // 插入顺序：[📥 Obsidian] [🗑️ 删除已载入] [...]
    container.insertBefore(deleteBtn, moreBtn);
    container.insertBefore(exportBtn, deleteBtn);
  }

  // ─── SPA 路由处理 ────────────────────────────────────────────────────────────

  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(tryInjectButtons, 100);
  });
  observer.observe(document.body, { childList: true, subtree: true });

  const origPushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    origPushState(...args);
    setTimeout(tryInjectButtons, 500);
  };
  window.addEventListener('popstate', () => setTimeout(tryInjectButtons, 500));

  tryInjectButtons();
})();
