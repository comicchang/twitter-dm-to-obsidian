// ==UserScript==
// @name         Twitter DM to Obsidian
// @namespace    https://github.com/comicchang/twitter-dm-to-obsidian
// @version      3.8.3
// @description  将 Twitter/X DM 消息（转发推文）批量导入 Obsidian，支持删除已载入消息
// @author       comicchang
// @homepageURL  https://github.com/comicchang/twitter-dm-to-obsidian
// @updateURL    https://raw.githubusercontent.com/comicchang/twitter-dm-to-obsidian/main/twitter-dm-to-obsidian.user.js
// @downloadURL  https://raw.githubusercontent.com/comicchang/twitter-dm-to-obsidian/main/twitter-dm-to-obsidian.user.js
// @match        https://twitter.com/messages/*
// @match        https://x.com/messages/*
// @match        https://x.com/i/chat/*
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      publish.twitter.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ─── 用户配置（仅需修改这里）────────────────────────────────────────────────
  const CONFIG = {
    vault:           '',        // Obsidian vault 名称（留空=使用当前已打开的 vault，填写后区分大小写）
    dailyNoteFolder: '',        // Daily Note 子目录，空=根目录
    writeMode:       'prepend', // 'prepend'=写在笔记开头；'append'=写在笔记末尾
    debug:           false,     // true=写入 debug.md；false=追加到今日 Daily Note
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
    // view: window 在 Tampermonkey 沙箱中会报错（沙箱 window 非真实 Window 对象），省略即可
    const opts = { bubbles: true, cancelable: true };
    ['pointerover', 'mouseover', 'pointermove', 'mousemove'].forEach(t =>
      el.dispatchEvent(new MouseEvent(t, opts))
    );
    ['pointerenter', 'mouseenter'].forEach(t =>
      el.dispatchEvent(new MouseEvent(t, { ...opts, bubbles: false }))
    );
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
    // t.co 对非浏览器请求不做 HTTP 302，而是返回 200 + HTML（JS redirect）
    // 解析 <a id="l" href="...">（t.co 标准锚点）提取真实 URL；meta refresh 作备选
    function gmExpand(u) {
      return new Promise(resolve => {
        GM_xmlhttpRequest({
          method: 'GET', url: u,
          headers: { 'User-Agent': navigator.userAgent },
          onload: r => {
            // 若 HTTP 层发生了真实重定向（部分环境下有效）
            const httpFinal = r.finalUrl || r.responseURL;
            if (httpFinal && httpFinal !== u) return resolve(httpFinal);
            // 解析 t.co 返回的 HTML
            try {
              const doc = new DOMParser().parseFromString(r.responseText, 'text/html');
              const anchor = doc.querySelector('a#l');
              if (anchor?.href) return resolve(anchor.href);
              const meta = doc.querySelector('meta[http-equiv="refresh"]');
              const content = meta?.getAttribute('content') || '';
              const m = content.match(/url=['"]?([^'">\s]+)/i);
              if (m) return resolve(m[1]);
            } catch {}
            resolve(u);
          },
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

    // 用缓存结果替换 extraLinks 中的 href，并按最终 URL 去重（DOM + oEmbed 来源可能重叠）
    return messages.map(msg => {
      const expanded = (msg.extraLinks || []).map(link => ({
        ...link,
        href: urlCache.get(link.href) ?? link.href,
      }));
      const seen = new Set();
      return {
        ...msg,
        extraLinks: expanded.filter(l => seen.has(l.href) ? false : seen.add(l.href)),
      };
    });
  }

  // ─── oEmbed 补全 ─────────────────────────────────────────────────────────────
  //
  // DM 卡片只渲染推文预览，正文内的链接（t.co）可能不出现在卡片 DOM 里。
  // 通过 publish.twitter.com/oembed 获取推文完整 HTML，展开 t.co 后更新正文文字。

  /**
   * 获取单条推文 oEmbed 的 blockquote <p> 元素及其中的 t.co 链接列表
   * 返回 { p: Element, tcoLinks: string[] } 或 null
   */
  async function fetchOembedData(tweetUrl) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `https://publish.twitter.com/oembed?url=${encodeURIComponent(tweetUrl)}&omit_script=true`,
        onload: r => {
          // 4xx：推文已删除 / 不可见 / 账号停用，标记为 notFound 供调用方过滤
          if (r.status >= 400 && r.status < 500) return resolve({ notFound: true });
          try {
            const { html } = JSON.parse(r.responseText);
            const tmp = document.createElement('div');
            tmp.innerHTML = html;
            const p = tmp.querySelector('blockquote p');
            if (!p) return resolve(null);
            const tcoLinks = [...p.querySelectorAll('a[href]')]
              .map(a => a.href)
              .filter(h => h.includes('t.co/'));
            resolve({ p, tcoLinks });
          } catch {
            resolve(null);
          }
        },
        onerror: () => resolve(null),
      });
    });
  }

  /**
   * 用 oEmbed 数据更新每条推文的正文（批量并发 3）：
   * - t.co 链接从正文中移除，加入 extraLinks 由 resolveExtraLinks 统一展开
   * - @mention / #hashtag 保留为纯文字
   * 返回 { messages, skippedMessageKeys }：
   * - messages：仍可参与归档的消息
   * - skippedMessageKeys：推文已失效，归档时跳过，但允许加入待删除集合
   */
  async function enrichWithOembed(messages) {
    const BATCH = 3;
    const result = messages.map(m => ({ ...m, extraLinks: [...(m.extraLinks || [])] }));
    const tweetItems = result.filter(m => m.url);
    const skippedMessageKeys = [];

    for (let i = 0; i < tweetItems.length; i += BATCH) {
      await Promise.all(tweetItems.slice(i, i + BATCH).map(async msg => {
        const data = await fetchOembedData(msg.url);
        if (!data) return; // 网络错误：保留原始数据
        if (data.notFound) {
          msg._skip = true;
          skippedMessageKeys.push(msg.messageKey);
          return;
        }

        const { p, tcoLinks } = data;

        // t.co <a> → 从文字中移除；其余 <a>（@mention/#hashtag）→ 保留显示文字
        for (const a of [...p.querySelectorAll('a[href]')]) {
          a.replaceWith(document.createTextNode(
            a.href.includes('t.co/') ? '' : a.textContent
          ));
        }

        // 更新正文（多余空格合并）
        const cleaned = p.textContent.replace(/\s+/g, ' ').trim();
        if (cleaned) msg.text = cleaned;

        // t.co 链接加入 extraLinks，交由 resolveExtraLinks 展开后统一去重
        for (const href of tcoLinks) {
          msg.extraLinks.push({ href, label: '' });
        }
      }));
    }

    return {
      messages: result.filter(m => !m._skip),
      skippedMessageKeys,
    };
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
      if (!data) continue;

      // 消息唯一键：优先使用 Twitter 内部 message-* id，其次回退到 URL/文本
      const testId = msgEl.getAttribute('data-testid') || '';
      const idPart = testId.startsWith('message-') ? testId.slice('message-'.length) : '';
      const messageKey = idPart
        ? `id:${idPart}`
        : (data.url ? `url:${data.url}` : `text:${data.text}`);

      result.push({ liEl: li, msgEl, messageKey, ...data });
    }
    return result;
  }

  // 导出顺序应跟随 DM 对话本身，而不是原推文发布时间。
  // 这里按页面中的实际位置排序：越靠下通常越新，也更接近“转发给机器人”的先后顺序。
  function sortMessagesForExport(messages) {
    return [...messages].sort((a, b) => {
      const aTop = a.liEl?.getBoundingClientRect?.().top ?? 0;
      const bTop = b.liEl?.getBoundingClientRect?.().top ?? 0;
      if (aTop !== bTop) return bTop - aTop;
      return 0;
    });
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

  // 实测浏览器/Obsidian 链路对超长 custom URI 比脚本内字符串长度更敏感，
  // 阈值保守一些，避免传输途中被截断后留下半个 %xx 导致 URI malformed。
  const URI_MAX = 7400;
  const URI_SOFT_MAX = 7000;
  const BUTTON_STATUS_RESET_MS = 3500;
  const DELETE_CONFIRM_ARM_MS = 4000;
  // 安全门禁：每个会话记录“允许删除的消息 key”（已归档或已确认失效）
  const exportedMessageKeysByConversation = new Map();
  const EXPORT_STATE_STORAGE_PREFIX = 'twitter-dm-to-obsidian:exported:';

  // 当前会话 key：/messages/{id} 或 /i/chat/{id}
  function getCurrentConversationKey() {
    const m = window.location.pathname.match(/^\/(?:messages|i\/chat)\/[^/]+/);
    return m ? m[0] : '';
  }

  function getExportStateStorageKey(conversationKey) {
    return `${EXPORT_STATE_STORAGE_PREFIX}${conversationKey}`;
  }

  function loadPersistedMessageSet(conversationKey) {
    try {
      const raw = localStorage.getItem(getExportStateStorageKey(conversationKey));
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? new Set(parsed.filter(v => typeof v === 'string' && v)) : new Set();
    } catch {
      return new Set();
    }
  }

  function savePersistedMessageSet(conversationKey, set) {
    try {
      const storageKey = getExportStateStorageKey(conversationKey);
      if (!set.size) {
        localStorage.removeItem(storageKey);
        return;
      }
      localStorage.setItem(storageKey, JSON.stringify([...set]));
    } catch {}
  }

  function getExportedMessageSetForCurrentConversation(create = false) {
    const key = getCurrentConversationKey();
    if (!key) return null;
    let set = exportedMessageKeysByConversation.get(key);
    if (!set) {
      set = loadPersistedMessageSet(key);
      if (create || set.size > 0) {
        exportedMessageKeysByConversation.set(key, set);
      }
    }
    return set || null;
  }

  function hasExportedCurrentConversation() {
    const set = getExportedMessageSetForCurrentConversation(false);
    return !!set && set.size > 0;
  }

  function isMessageExported(messageKey) {
    const set = getExportedMessageSetForCurrentConversation(false);
    return !!set && set.has(messageKey);
  }

  function markMessagesExported(messageKeys) {
    const conversationKey = getCurrentConversationKey();
    const set = getExportedMessageSetForCurrentConversation(true);
    if (!set || !conversationKey) return;
    for (const messageKey of messageKeys) set.add(messageKey);
    exportedMessageKeysByConversation.set(conversationKey, set);
    savePersistedMessageSet(conversationKey, set);
  }

  function unmarkMessageExported(messageKey) {
    const conversationKey = getCurrentConversationKey();
    const set = getExportedMessageSetForCurrentConversation(false);
    if (!set || !conversationKey) return;
    set.delete(messageKey);
    if (set.size > 0) exportedMessageKeysByConversation.set(conversationKey, set);
    else exportedMessageKeysByConversation.delete(conversationKey);
    savePersistedMessageSet(conversationKey, set);
  }

  // 根据安全门禁刷新删除按钮状态
  function syncDeleteGuard(deleteBtn) {
    const canDelete = hasExportedCurrentConversation();
    deleteBtn.disabled = !canDelete;
    deleteBtn.style.opacity = canDelete ? '1' : '0.65';
    deleteBtn.style.cursor = canDelete ? 'pointer' : 'not-allowed';
    deleteBtn.title = canDelete
      ? '仅删除当前已载入且已归档，或已确认失效的消息（不可撤销）'
      : '安全检查：请先执行归档；删除只会作用于已归档或已确认失效的消息';
  }

  function getExportButtonIdleLabel() {
    return CONFIG.debug ? '📥 Obsidian [D]' : '📥 Obsidian';
  }

  function setButtonStatus(btn, label, { disabled = false, resetTo = '', resetMs = BUTTON_STATUS_RESET_MS, onReset } = {}) {
    if (!btn) return;
    clearTimeout(btn._statusTimer);
    btn.textContent = label;
    btn.disabled = disabled;
    if (!resetTo) return;
    btn._statusTimer = setTimeout(() => {
      btn.textContent = resetTo;
      btn.disabled = false;
      if (onReset) onReset();
    }, resetMs);
  }

  function clearDeleteConfirmState(deleteBtn, { syncGuard = true } = {}) {
    if (!deleteBtn) return;
    clearTimeout(deleteBtn._confirmTimer);
    deleteBtn.dataset.confirmDelete = '';
    deleteBtn.dataset.confirmDeleteCount = '';
    if (syncGuard) {
      deleteBtn.textContent = '🗑️ 删除已载入';
      syncDeleteGuard(deleteBtn);
    }
  }

  function armDeleteConfirm(deleteBtn, count) {
    clearDeleteConfirmState(deleteBtn, { syncGuard: false });
    deleteBtn.dataset.confirmDelete = '1';
    deleteBtn.dataset.confirmDeleteCount = String(count);
    deleteBtn.disabled = false;
    deleteBtn.style.opacity = '1';
    deleteBtn.style.cursor = 'pointer';
    deleteBtn.textContent = `⚠️ 再点删除 ${count} 条`;
    deleteBtn.title = '再次点击以确认删除；超时会自动取消';
    deleteBtn._confirmTimer = setTimeout(() => {
      clearDeleteConfirmState(deleteBtn);
    }, DELETE_CONFIRM_ARM_MS);
  }

  // Advanced URI 在不同宿主链路里可能被提前解码一次。
  // 这里统一做双层 encode，保证传到插件 decodeURIComponent 后仍能还原原文。
  function encodeAdvancedUriValue(value) {
    return encodeURIComponent(encodeURIComponent(value));
  }

  // 用 encodeURIComponent 构造 URI，避免 URLSearchParams 把空格编为 +
  // debug=true 时写入 debug.md，否则追加到今日 Daily Note
  function buildObsidianUri(data) {
    const target = CONFIG.debug
      ? `filepath=${encodeAdvancedUriValue('debug.md')}`
      : `daily=true${CONFIG.dailyNoteFolder ? `&dailyNotePath=${encodeAdvancedUriValue(CONFIG.dailyNoteFolder)}` : ''}`;
    let u = `obsidian://advanced-uri?${target}&mode=${CONFIG.writeMode}&data=${encodeAdvancedUriValue(data)}`;
    if (CONFIG.vault) u += `&vault=${encodeAdvancedUriValue(CONFIG.vault)}`;
    return u;
  }

  function getSingleMessageUriLength(message) {
    return buildObsidianUri('\n' + formatMarkdown([message])).length;
  }

  function buildOverflowNote({ textTrimmed, removedMediaCount, removedLinkCount }) {
    const parts = [];
    if (textTrimmed) parts.push('正文已截断');
    if (removedMediaCount > 0) parts.push(`省略${removedMediaCount}个媒体`);
    if (removedLinkCount > 0) parts.push(`省略${removedLinkCount}条链接`);
    if (!parts.length) return '';
    return `[内容过长，${parts.join('，')}]`;
  }

  function buildTruncatedText(baseText, maxLength, note) {
    const safeBase = (baseText || '').trim();
    if (!safeBase) return note || '';
    if (maxLength <= 0) return note || '';
    if (safeBase.length <= maxLength) {
      return note ? `${safeBase}\n${note}` : safeBase;
    }
    const truncated = `${safeBase.slice(0, maxLength).trimEnd()}…`;
    return note ? `${truncated}\n${note}` : truncated;
  }

  // 单条消息超限时，尽量降级成一个可归档版本，避免卡住后续“先归档再删除”的循环。
  function fitSingleMessageWithinLimit(message) {
    const originalMedia = [...(message.media || [])];
    const originalLinks = [...(message.extraLinks || [])];
    const originalText = message.text || '';

    let removedMediaCount = 0;
    let removedLinkCount = 0;
    let textTrimmed = false;
    let textLimit = originalText.length;

    function buildCandidate() {
      const note = buildOverflowNote({ textTrimmed, removedMediaCount, removedLinkCount });
      const media = originalMedia.slice(0, originalMedia.length - removedMediaCount);
      const extraLinks = originalLinks.slice(0, originalLinks.length - removedLinkCount);
      const text = buildTruncatedText(originalText, textLimit, note);
      return { ...message, media, extraLinks, text };
    }

    let candidate = buildCandidate();
    if (getSingleMessageUriLength(candidate) <= URI_SOFT_MAX) return candidate;

    while (removedLinkCount < originalLinks.length) {
      removedLinkCount++;
      candidate = buildCandidate();
      if (getSingleMessageUriLength(candidate) <= URI_SOFT_MAX) return candidate;
    }

    while (removedMediaCount < originalMedia.length) {
      removedMediaCount++;
      candidate = buildCandidate();
      if (getSingleMessageUriLength(candidate) <= URI_SOFT_MAX) return candidate;
    }

    if (originalText) {
      textTrimmed = true;
      while (textLimit > 280) {
        textLimit = Math.max(280, textLimit - 200);
        candidate = buildCandidate();
        if (getSingleMessageUriLength(candidate) <= URI_SOFT_MAX) return candidate;
      }
    }

    const minimalNote = message.url
      ? '[内容过长，已截断，详见原推文链接]'
      : '[内容过长，已截断]';
    candidate = {
      ...message,
      media: [],
      extraLinks: [],
      text: minimalNote,
    };
    return getSingleMessageUriLength(candidate) <= URI_SOFT_MAX ? candidate : null;
  }

  // 只选择“从前往后”能安全装进单次导出的消息前缀。
  // 超限后立即停止，剩余消息留给下一轮导出，避免一次触发多次 URI 调用。
  function takeExportableMessagePrefix(messages) {
    const selected = [];
    let truncatedCount = 0;

    for (const msg of messages) {
      const next = [...selected, msg];
      const nextUri = buildObsidianUri('\n' + formatMarkdown(next));
      if (nextUri.length <= URI_SOFT_MAX) {
        selected.push(msg);
        continue;
      }

      const singleUri = buildObsidianUri('\n' + formatMarkdown([msg]));
      if (!selected.length && singleUri.length > URI_SOFT_MAX) {
        const fitted = fitSingleMessageWithinLimit(msg);
        if (fitted) {
          return {
            selected: [fitted],
            remaining: messages.slice(1),
            blockedBySingleOversize: false,
            truncatedCount: 1,
          };
        }
        return { selected: [], remaining: messages, blockedBySingleOversize: true, truncatedCount: 0 };
      }
      break;
    }

    return {
      selected,
      remaining: messages.slice(selected.length),
      blockedBySingleOversize: false,
      truncatedCount,
    };
  }

  async function exportToObsidian(btn, deleteBtn) {
    const ul = document.querySelector(`${SEL.messageList} ul`);
    if (!ul) {
      setButtonStatus(btn, '⚠️ 未找到对话', { resetTo: getExportButtonIdleLabel() });
      return;
    }

    btn.textContent = '⏳ 抓取中...';
    btn.disabled = true;

    let messages = sortMessagesForExport(scrapeLoadedMessages())
      .filter(m => !isMessageExported(m.messageKey));
    const skippedDeletedTweetKeys = [];
    if (!messages.length) {
      if (deleteBtn && document.contains(deleteBtn)) syncDeleteGuard(deleteBtn);
      setButtonStatus(btn, '⚪ 无新消息', { resetTo: getExportButtonIdleLabel() });
      return;
    }

    // oEmbed：获取完整推文正文并展开正文内 t.co 链接
    const tweetCount = messages.filter(m => m.url).length;
    if (tweetCount > 0) {
      btn.textContent = `⏳ 抓取推文 (${tweetCount})...`;
      const enriched = await enrichWithOembed(messages);
      messages = enriched.messages;
      skippedDeletedTweetKeys.push(...enriched.skippedMessageKeys);
      if (skippedDeletedTweetKeys.length > 0) {
        markMessagesExported(skippedDeletedTweetKeys);
      }
    }

    // 展开卡片 DOM 里剩余的 t.co 短链（链接预览卡等）
    const tcoCount = messages.reduce((n, m) => n + (m.extraLinks || []).filter(l => l.href.includes('t.co/')).length, 0);
    if (tcoCount > 0) {
      btn.textContent = `⏳ 展开链接 (${tcoCount})...`;
      messages = await resolveExtraLinks(messages);
    }

    const { selected, remaining, blockedBySingleOversize, truncatedCount } = takeExportableMessagePrefix(messages);
    if (!selected.length) {
      if (deleteBtn && document.contains(deleteBtn)) syncDeleteGuard(deleteBtn);
      if (skippedDeletedTweetKeys.length > 0) {
        setButtonStatus(btn, `⏭️ 跳过失效 ${skippedDeletedTweetKeys.length}`, {
          resetTo: getExportButtonIdleLabel(),
        });
        return;
      }
      setButtonStatus(
        btn,
        blockedBySingleOversize ? `⚠️ 首条超长>${URI_SOFT_MAX}` : '⚠️ 无可导出消息',
        { resetTo: getExportButtonIdleLabel() }
      );
      return;
    }

    const uri = buildObsidianUri('\n' + formatMarkdown(selected));
    if (uri.length > URI_MAX) {
      setButtonStatus(btn, `⚠️ 导出超限>${URI_MAX}`, { resetTo: getExportButtonIdleLabel() });
      return;
    }

    btn.textContent = `⏳ 导出 ${selected.length} 条...`;
    window.location.href = uri;
    markMessagesExported(selected.map(m => m.messageKey));

    setTimeout(() => {
      if (deleteBtn && document.contains(deleteBtn)) syncDeleteGuard(deleteBtn);
      const summary = [`归档${selected.length}`];
      if (truncatedCount > 0) summary.push(`精简${truncatedCount}`);
      if (skippedDeletedTweetKeys.length > 0) summary.push(`失效${skippedDeletedTweetKeys.length}`);
      if (remaining.length > 0) summary.push(`剩余${remaining.length}`);
      setButtonStatus(btn, `✅ ${summary.join(' ')}`, {
        resetTo: getExportButtonIdleLabel(),
        onReset: () => {
          if (deleteBtn && document.contains(deleteBtn)) syncDeleteGuard(deleteBtn);
        },
      });
    }, 1000);
  }

  // ─── 删除逻辑 ────────────────────────────────────────────────────────────────

  /**
   * 删除单条消息（hover → 操作按钮 → Delete → 确认）
   * ⚠️ 依赖 React 响应 JS 派发的鼠标事件，可能失效
   */
  async function deleteSingleMessage(liEl, msgEl, label) {
    liEl.scrollIntoView({ block: 'center', behavior: 'instant' });
    await sleep(500);

    dispatchHoverEvents(msgEl);
    await sleep(700);

    const actionsDiv = msgEl.querySelector(SEL.actionsArea);
    if (!actionsDiv) {
      console.warn('[delete]', label, '→ actionsDiv 未出现（hover 未触发）');
      return false;
    }

    const btns = actionsDiv.querySelectorAll('button');
    if (!btns.length) {
      console.warn('[delete]', label, '→ actionsDiv 内无按钮');
      return false;
    }

    // 点击最后一个按钮（"..." 更多操作）
    btns[btns.length - 1].click();

    // 轮询等待 Radix Popover 内的删除按钮出现（最多 1.5s）
    let deleteItem = null;
    for (let t = 0; t < 10 && !deleteItem; t++) {
      await sleep(150);
      deleteItem = document.querySelector(
        '[data-testid="action-menu-item-delete-for-me"],' +
        '[data-testid="action-menu-item-delete"],' +
        '[data-testid="action-menu-item-delete-for-everyone"]'
      );
    }

    if (!deleteItem) {
      console.warn('[delete]', label, '→ 未找到删除按钮（Radix Popover 未出现或结构变化）');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(300);
      return false;
    }

    deleteItem.click();

    // 轮询等待确认弹窗出现（最多 1.5s）
    // 确认按钮是 type="submit"，取消按钮是 type="button"
    let confirmBtn = null;
    for (let t = 0; t < 10 && !confirmBtn; t++) {
      await sleep(150);
      confirmBtn = document.querySelector(
        '[role="dialog"] button[type="submit"], [role="alertdialog"] button[type="submit"]'
      );
    }
    if (confirmBtn) {
      console.log('[delete]', label, '→ 点击确认弹窗:', confirmBtn.textContent.trim());
      confirmBtn.click();
      await sleep(500);
      return true;
    }

    console.log('[delete]', label, '→ 成功（无确认弹窗）');
    return true;
  }

  async function deleteAllMessages(deleteBtn) {
    if (!hasExportedCurrentConversation()) {
      clearDeleteConfirmState(deleteBtn);
      setButtonStatus(deleteBtn, '⚠️ 先归档再删', {
        resetTo: '🗑️ 删除已载入',
        onReset: () => syncDeleteGuard(deleteBtn),
      });
      return;
    }

    const initial = scrapeLoadedMessages().filter(m => isMessageExported(m.messageKey));
    if (!initial.length) {
      clearDeleteConfirmState(deleteBtn);
      setButtonStatus(deleteBtn, '⚪ 无可删消息', {
        resetTo: '🗑️ 删除已载入',
        onReset: () => syncDeleteGuard(deleteBtn),
      });
      return;
    }

    if (deleteBtn.dataset.confirmDelete !== '1') {
      armDeleteConfirm(deleteBtn, initial.length);
      return;
    }

    clearDeleteConfirmState(deleteBtn, { syncGuard: false });
    deleteBtn.disabled = true;
    let success = 0, fail = 0;
    const total = initial.length;
    // 从下往上删：底部消息先删，顶部消息留在视口内不被回收
    const pending = [...initial].reverse().map(m => m.messageKey);

    console.log('[delete] 开始删除，共', total, '条');

    for (const key of pending) {
      // 重新抓取，找到与 key 匹配的当前 DOM 节点
      const current = scrapeLoadedMessages().find(m => m.messageKey === key);
      if (!current || !document.contains(current.liEl)) {
        console.warn('[delete] 不在 DOM，跳过:', key?.slice(0, 60));
        continue;
      }

      const preview = (current.url || current.text || key || '').slice(0, 60);
      const label = `[${success + fail + 1}/${total}] ${preview}`;
      deleteBtn.textContent = `⏳ ${success + fail + 1}/${total}`;

      const ok = await deleteSingleMessage(current.liEl, current.msgEl, label);
      console.log('[delete]', label, ok ? '✅ 成功' : '❌ 失败');
      if (ok) {
        success++;
        unmarkMessageExported(key);
      } else {
        fail++;
      }

      await sleep(500); // 等待 DOM 更新
    }

    deleteBtn.disabled = false;
    setButtonStatus(
      deleteBtn,
      fail === 0 ? `✅ 删除 ${success} 条` : `⚠️ 删成${success} 失败${fail}`,
      {
        resetTo: '🗑️ 删除已载入',
        resetMs: 4000,
        onReset: () => syncDeleteGuard(deleteBtn),
      }
    );
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
    const existingExportBtn = document.getElementById('obsidian-export-btn');
    const existingDeleteBtn = document.getElementById('obsidian-delete-btn');
    if (existingExportBtn && existingDeleteBtn) {
      if (existingDeleteBtn.dataset.confirmDelete === '1' && !hasExportedCurrentConversation()) {
        clearDeleteConfirmState(existingDeleteBtn);
      }
      syncDeleteGuard(existingDeleteBtn);
      return;
    }
    // 避免只残留单个按钮导致状态错乱
    existingExportBtn?.remove();
    existingDeleteBtn?.remove();

    const moreBtn = document.querySelector(SEL.moreBtn);
    if (!moreBtn) return;

    const container = moreBtn.parentElement;
    if (!container) return;

    const deleteBtn = makeBtn('obsidian-delete-btn', '🗑️ 删除已载入', '#dc2626', '#b91c1c');
    syncDeleteGuard(deleteBtn);
    deleteBtn.addEventListener('click', () => deleteAllMessages(deleteBtn));

    const exportLabel = CONFIG.debug ? '📥 Obsidian [D]' : '📥 Obsidian';
    const exportBtn = makeBtn('obsidian-export-btn', exportLabel, '#7c3aed', '#6d28d9');
    exportBtn.title = CONFIG.debug ? '调试模式：写入 debug.md' : '将已载入消息保存到 Obsidian Daily Note';
    exportBtn.addEventListener('click', () => exportToObsidian(exportBtn, deleteBtn));

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
