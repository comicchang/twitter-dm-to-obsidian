# CLAUDE.md — twitter-dm-to-obsidian

## 项目结构

单文件实现，无构建步骤，无依赖：

```
twitter-dm-to-obsidian.user.js   ← 唯一实现文件（Tampermonkey userscript）
README.md
CLAUDE.md
```

## 架构概览

脚本在 Twitter/X DM 页面（SPA）注入两个按钮，无服务端，所有逻辑在浏览器内运行。

```
页面加载/路由切换
  └─ tryInjectButtons()          按钮注入（MutationObserver + pushState 劫持）
       └─ exportToObsidian()     📥 导出流程
            ├─ expandShowMore()  展开截断正文（调 React onClick，无网络请求）
            ├─ scrapeLoadedMessages()
            │    └─ parseMessage()  提取 url/author/time/text/media/extraLinks
            ├─ resolveExtraLinks()  t.co 短链展开（GM_xmlhttpRequest，5并发）
            ├─ formatMarkdown()     Logseq outliner 格式化
            └─ obsidian://advanced-uri  追加到 Daily Note
       └─ deleteAllMessages()    🗑️ 删除流程
            └─ deleteSingleMessage()  hover模拟 → 点"..." → Delete → 确认
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
          [style*="grid-area: actions"]           ← hover后操作按钮（初始为空）
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
actionsArea:  '[style*="grid-area: actions"]'    // hover后才有内容
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
必须用 `GM_xmlhttpRequest`（`@grant GM_xmlhttpRequest` + `@connect t.co`）在扩展沙箱内发起请求。

## Show more 展开

Twitter 用 React 管理"Show more"状态，`.click()` 无效，必须调用 React 内部 onClick：

```javascript
const propsKey = Object.keys(span).find(k => k.startsWith('__reactProps'));
span[propsKey].onClick({ preventDefault: noop, stopPropagation: noop, ... });
```

合成事件对象必须包含 `preventDefault`、`stopPropagation`、`stopImmediatePropagation`、
`persist`、`isDefaultPrevented`、`isPropagationStopped`、`nativeEvent` 等方法，否则报错。

## 删除机制

依赖 JS 派发鼠标事件触发 React 渲染操作按钮，**不稳定**，可能失效：

1. `scrollIntoView` → `dispatchHoverEvents`（pointerover/mouseover 冒泡版）
2. 等待 `[style*="grid-area: actions"]` 内按钮出现
3. 点击最后一个按钮（"..."）→ 找 `[role="menuitem"]` 中的 Delete/删除
4. 处理二次确认弹窗

如需提高成功率，可考虑改用 Twitter 内部 API（需 bearer token 和 CSRF token）。

## SPA 路由处理

Twitter 是 SPA，三重保障：

1. `MutationObserver` 监听 `document.body`（childList + subtree），debounce 100ms
2. 劫持 `history.pushState`，延迟 500ms 重注入
3. 监听 `popstate`

注入守卫：URL 必须匹配 `/\/messages\/.+|\/i\/chat\/.+/`，且 `#obsidian-export-btn` 不存在。

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
