# CLAUDE.md — twitter-dm-to-obsidian

## 项目结构

单文件实现，无构建步骤，无依赖：

```
twitter-dm-to-obsidian.user.js   ← 唯一实现文件（Tampermonkey userscript）
README.md
CLAUDE.md
```

## 架构概览

脚本在 Twitter/X 的 DM 会话页与书签/历史页（SPA）注入两个按钮，无服务端，所有逻辑在浏览器内运行。

```
页面加载/路由切换
  └─ tryInjectButtons()          按钮注入（MutationObserver + pushState 劫持；DM 与书签/历史两套锚点）
       ├─ exportToObsidian()     📥 导出流程（DM / 书签页共用，scraper 按页面注入）
       │    ├─ scrapeLoadedMessages() / scrapeBookmarks()
       │    │    └─ parseMessage() / parseBookmarkArticle()  提取 url/author/time/text/media/extraLinks
       │    ├─ enrichWithOembed()   oEmbed 补全正文（fetchOembedData，批量并发 3，跳过失效推文）
       │    ├─ resolveExtraLinks()  t.co 短链展开（GM_xmlhttpRequest，5 并发）
       │    ├─ formatMarkdown()     Logseq outliner 格式化
       │    └─ obsidian://advanced-uri  追加到 Daily Note
       ├─ deleteAllMessages()     🗑️ DM 删除流程
       │    └─ deleteSingleMessage()  overflow 按钮 → Popover 删除项 → dialog 确认
       └─ unbookmarkAll()         🗑️ 书签/历史页取消收藏
            └─ 点击 [data-testid="removeBookmark"]
```

## 实际 Twitter DOM 结构（2026-03 验证）

```
[data-testid="dm-conversation-panel"]
  [data-testid="dm-conversation-header"]
    .parentElement of [data-testid="dm-conversation-more-button"]  ← 按钮注入位置
  [data-testid="dm-message-list"]
    ul
      li
        [data-testid^="message-{UUID}"]          ← 消息根元素（UUID = Twitter内部消息ID）
          [data-testid="message-reaction-button-{UUID}"]  ← hover后出现（表情）
          [data-testid="message-overflow-button-{UUID}"]   ← hover后出现（"..."删除入口）
          [style*="grid-area: content"]           ← 消息内容
            a[href*="/status/"]                   ← 转发推文卡片
              [data-slot="hover-card-trigger"]
                [class*="font-bold"]             ← 作者显示名
              [class*="text-gray-800"]            ← 相对时间戳（"22h" / "Mar 1"）
              span[dir="auto"] > span             ← 推文正文
              video[src]                          ← 视频（URL长期有效）
              img:not([alt="user avatar"])         ← 推文内容图片（跳过头像）
```

**重要**：`<a>` 嵌套 `<a>` 是非法 HTML，浏览器将链接预览卡解析为推文卡片的**兄弟节点**，
因此 extraLinks 必须从 `[style*="grid-area: content"]` 容器查询，而非从 card 内部。

书签/历史页 DOM（与 DM 结构不同，直接抓取 article，无 hover）：

```
article[data-testid="tweet"]            ← 每条书签的根元素
  [data-testid="User-Name"]             ← 作者显示名
  time → 最近的 a[href]                 ← 时间戳及其推文 URL
  [data-testid="tweetText"]             ← 正文
  [data-testid="tweetPhoto"] img        ← 推文图片
  [data-testid="removeBookmark"]        ← "移除书签"按钮
```

## 关键选择器（SEL 对象）

若 Twitter 改版导致选择器失效，只需更新 `SEL` 常量：

```javascript
messageList:  '[data-testid="dm-message-list"]'
messageItem:  '[data-testid^="message-"]'       // 前缀匹配，UUID后缀
moreBtn:      '[data-testid="dm-conversation-more-button"]'
tweetCard:    'a[href*="/status/"]'
tweetText:    'span[dir="auto"] > span'
tweetAuthor:  '[data-slot="hover-card-trigger"] [class*="font-bold"]'
tweetTime:    '[class*="text-gray-800"]'         // card内第一个匹配=时间戳
actionsArea:  '[style*="grid-area: actions"]'    // 旧版回退（新版已弃用）
bookmarkArticle:   'article[data-testid="tweet"]'       // 书签/历史页：每条书签的根元素
bookmarkRemoveBtn: '[data-testid="removeBookmark"]'    // 书签条目内的"移除书签"按钮（点击即取消收藏）
// 新版操作按钮 testid 格式（hover后出现，直接在 msgEl 内）：
// message-reaction-button-{UUID}、message-overflow-button-{UUID}
```

## Obsidian URI

```
obsidian://advanced-uri?daily=true&mode=append&data={encodeURIComponent(encodeURIComponent(content))}
```

- `vault` 参数留空时省略 → Advanced URI 使用当前打开的 vault
- 必须手动拼接 URI，**不能用** `URLSearchParams`（空格会编为 `+`，Obsidian 不解码）
- `data` / `vault` / `dailyNotePath` 统一做双层 `encodeURIComponent`，兼容宿主链路可能发生的一次预解码
- URI 长度上限保守控制为 `URI_SOFT_MAX = 7000`、`URI_MAX = 7400`，避免 custom URI 被链路截断后触发 `URI malformed`
- 导出超限时只发送“从前往后”装得下的消息前缀，并只把这部分消息标记为可删除

## t.co 展开

x.com 的 CSP `connect-src` 不包含 `t.co`，`fetch` 会被阻断。
必须用 `GM_xmlhttpRequest`（`@grant GM_xmlhttpRequest`，t.co 由 `@connect *` 通配白名单放行）在扩展沙箱内发起请求。

## oEmbed 补全

DM 卡片只渲染推文预览，正文内的链接（t.co）可能不出现在卡片 DOM 里。
通过 `publish.twitter.com/oembed`（GM_xmlhttpRequest，publish.twitter.com 由 `@connect *` 通配白名单放行）获取推文完整 HTML：

1. `fetchOembedData(tweetUrl)` 请求 oEmbed，返回 blockquote `<p>` 及其中 t.co 链接列表；4xx 标记 `notFound`（推文已删除 / 不可见 / 账号停用）
2. `enrichWithOembed(messages)` 批量并发 3：t.co `<a>` 从正文移除并加入 extraLinks（交由 resolveExtraLinks 统一展开），@mention / #hashtag 保留纯文字
3. 失效推文（notFound）跳过归档，但标记为已导出，允许加入待删除集合
4. 媒体冗余清理：已有图片/视频时移除对应的 `/photo/N`、`/video/N` 链接

## 删除机制

依赖 JS 派发鼠标事件触发 React 渲染操作按钮，**不稳定**，可能失效：

1. `scrollIntoView` → `dispatchHoverEvents`（pointerover/mouseover 冒泡版）
2. 点击 `message-overflow-button-{UUID}`（hover 后出现；旧版回退 `[style*="grid-area: actions"]` 内最后一个按钮）
3. Radix Popover 出现 → 轮询等待删除项（`action-menu-item-delete-for-me` / `action-menu-item-delete` / `action-menu-item-delete-for-everyone`）
4. 点击删除项 → 轮询等待确认弹窗 `[role="dialog"] button[type="submit"]`（`[role="alertdialog"]` 同理；取消按钮是 `type="button"`）
5. 无确认弹窗时视为删除成功

书签/历史页的取消收藏不经过上述链路：直接点击每条 `article` 内的 `[data-testid="removeBookmark"]`。

如需提高成功率，可考虑改用 Twitter 内部 API（需 bearer token 和 CSRF token）。

## SPA 路由处理

Twitter 是 SPA，三重保障：

1. `MutationObserver` 监听 `document.body`（childList + subtree），debounce 100ms
2. 劫持 `history.pushState`，延迟 500ms 重注入
3. 监听 `popstate`

注入守卫（`tryInjectButtons` 内按页面模式判断）：
- DM 页：URL 匹配 `/\/messages\/.+|\/i\/chat\/.+/`，且 `[data-testid="dm-conversation-more-button"]` 已渲染（否则 500ms 重试，最多 10 次）
- 书签/历史页：URL 以 `/i/bookmarks` 或 `/i/history` 开头，且页面 `h2` 标题为「书签」/「历史」作为注入锚点（同样 500ms 重试，最多 10 次）
- 两种模式共用守卫：`#obsidian-export-btn` 与 `#obsidian-delete-btn` 均已存在则跳过

## 输出格式

Logseq outliner 格式（无 header/footer）：

```markdown
- 作者名 [22h](https://x.com/i/status/...)
  - 正文段落
  - 🎬 [视频](https://video.twimg.com/...)
  - ![](https://pbs.twimg.com/...)
  - 🔗 [链接标题](https://github.com/...)

- 纯文字DM内容
```

时间戳显示 Twitter 原始相对时间，不转换（`22h` / `Mar 1`）。
