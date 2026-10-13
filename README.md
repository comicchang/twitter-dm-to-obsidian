# Twitter DM to Obsidian

将 Twitter/X DM 中的转发推文批量导入 Obsidian Daily Note 的 Tampermonkey 脚本。

A Tampermonkey userscript that exports forwarded tweets from Twitter/X DMs into your Obsidian Daily Note.

---

## 使用场景 / Use Case

将 Twitter/X 当做稍后读工具：把感兴趣的推文转发给某个 dummy 联系人，再一键批量导入 Obsidian。

Use Twitter/X as a read-later tool: forward interesting tweets to a dummy DM contact, then export them all at once to Obsidian.

---

## 前置要求 / Prerequisites

| 工具 | 说明 |
|------|------|
| [Tampermonkey](https://www.tampermonkey.net/) | Chrome / Edge / Firefox 均可 |
| [Obsidian](https://obsidian.md/) | 需已打开目标 vault |
| [Advanced URI 插件](https://github.com/Vinzent03/obsidian-advanced-uri) | Obsidian 社区插件，用于 append 模式写入 Daily Note |

Advanced URI 安装：Obsidian → 设置 → 社区插件 → 浏览 → 搜索 `Advanced URI` → 安装并启用。

---

## 安装 / Installation

1. 安装 Tampermonkey 浏览器扩展
2. 点击 Tampermonkey 图标 → **新建脚本**
3. 将 `twitter-dm-to-obsidian.user.js` 的全部内容粘贴进去，或直接访问 [Raw 链接](https://raw.githubusercontent.com/comicchang/twitter-dm-to-obsidian/main/twitter-dm-to-obsidian.user.js) 安装
4. `Ctrl/Cmd + S` 保存，允许所有域名访问权限（用于展开 t.co 短链）

---

## 配置 / Configuration

脚本顶部 `CONFIG` 对象，通常无需修改：

```javascript
const CONFIG = {
  vault:           '',        // 留空=使用当前已打开的 vault；多 vault 时填写名称（区分大小写）
  dailyNoteFolder: '',        // Daily Note 所在子目录，留空=根目录
  writeMode:       'prepend', // 'prepend'=写在笔记开头；'append'=写在笔记末尾
  debug:           false,     // true=写入 debug.md 而非 Daily Note（调试用）
};
```

---

## 使用方法 / Usage

1. 打开 `x.com/messages/` 并进入任意 DM 对话
2. 页面右上角出现两个主按钮，最右侧还有一个低频恢复入口的小图标按钮（悬浮有 Tooltip 提示，需二次确认才执行，防止误触）：

   | 按钮 | 功能 |
   |------|------|
   | 📥 Obsidian | 将当前已渲染的消息导出到 Obsidian Daily Note |
   | 🗑️ 删除已载入 | 逐条删除当前已渲染且**已归档（或已确认失效）**的消息（不可撤销，需二次点击确认） |
   | 🔧 恢复（小图标） | 打开恢复菜单，提供两个低频动作，见下文「恢复菜单」 |

3. 点击 **📥 Obsidian**，浏览器弹出"打开 Obsidian"确认框，允许后内容自动追加到今日 Daily Note

> **注意**：Twitter 使用虚拟列表，只有滚动进视口的消息才会被渲染。若需导出更多历史记录，请先向上滚动加载，再点击导出。单次导出条数少（约 5 条）的根因是 URI 长度上限而非 lazy load（见「已知限制」），被截断的剩余消息已暂存缓存，下一轮导出可从缓存继续。
>
> **删除安全门禁**：🗑️ 删除按钮默认禁用，需先执行过至少一次归档（或存在已确认失效的推文）才会启用；且只会作用于**已归档或已确认失效**的消息，不会影响未导出的内容。首次点击后按钮变为 `⚠️ 再点删除 N 条`，需在 4 秒内再次点击才真正删除（不可撤销），超时自动取消。

### 恢复菜单 / Recovery

Obsidian 冷启动时可能丢掉第一条 Advanced URI，而脚本此时已把内容标记为已导出——后续执行删除/取消收藏会把这条**从未写入笔记**的内容一并删掉。为此提供一个低频恢复入口：按钮区最右侧的小图标按钮，悬浮显示 Tooltip，点击后打开小菜单，包含两个动作（均需二次确认，防止误触）：

| 菜单动作 | 功能 |
|------|------|
| 重发上次导出 | 重新派发**上次实际生成的** `obsidian://advanced-uri`，不重新抓取网络数据；适用于确认第一条 URI 丢失后补写 |
| 全部标记未抓取 | 清除当前会话已导出状态，使这些内容可重新抓取导出，且**不会**被后续删除/取消收藏误删 |

两个动作均为低频操作，不影响日常导出/删除主流程。

### 抓取缓存 / Scrape Cache

已抓取并完成 oEmbed / t.co 展开 / 引用展开的推文信息会按会话（conversationKey）暂存到 localStorage；下次点击导出时，DOM 当前消息与缓存中**尚未导出**的消息合并（按 messageKey 去重，DOM 新鲜数据优先），已处理过的推文无需重复网络抓取。

- 超过单次 URI 上限被截断的消息留在缓存中，下一轮导出可直接从缓存继续，无需重新滚动加载
- 推文的原文、译文、语言、媒体、链接和引用/回复信息完整进入缓存并可还原，不会破坏导出格式
- 成功删除/取消收藏的消息会从缓存移除，避免已删除内容"复活"

### 书签 / 历史页

打开 `x.com/i/bookmarks`（书签）或 `x.com/i/history`（历史），页面标题右侧出现两个主按钮（最右侧同样有低频恢复入口的小图标按钮，行为见上文「恢复菜单」）：

| 按钮 | 功能 |
|------|------|
| 📥 Obsidian | 将当前已渲染的书签/历史推文导出到 Obsidian Daily Note |
| 🗑️ 取消收藏 | 取消收藏当前已渲染且**已归档（或已确认失效）**的书签（不可撤销，需二次点击确认） |

> **注意**：书签/历史页同样使用虚拟列表，只有滚动进视口的推文才会被渲染；导出顺序为页面 DOM 原始顺序（最新在前）。

---

## 导出格式 / Output Format

Logseq / Obsidian outliner 格式，无额外 header/footer：

```markdown
- [砍砍.ᐟ](https://x.com/pmamtraveller) [22h](https://x.com/pmamtraveller/status/2027794932224889018)
	- I've made changes to vphone-cli so you can now use the virtual device without a VNC.
	- <video src="https://video.twimg.com/amplify_video/.../xxx.mp4?tag=14" controls style="max-width:480px"></video>

- [作者名](https://x.com/author) [Mar 1](https://x.com/author/status/2027794932224889000)
	- 推文正文第一段
	  推文正文第二段
	- 🔗 [GitHub - repo/name](https://github.com/...)

- 纯文字 DM 内容
```

> 子级 bullet 用 **Tab** 缩进（Logseq outliner 约定）；同一段正文的续行不重复 `- ` 前缀，在 Tab 后补两个空格；消息之间用一个无缩进空行分隔。

每条推文包含：
- **作者显示名**（链接到作者主页）+ **时间戳**（链接到原推文）
- **正文**（已展开 "Show more"，已清理 t.co / pic.twitter.com 残留引用）
- **译文**：Twitter 自动翻译（Grok）存在时，原文与译文**同时保留**——原文块在前，译文块在后并附语言提示（lang），译文不会覆盖原文；超长退化精简时原文与译文同进退，不会只留其一
- **媒体**：视频链接（`video.twimg.com` 长期有效）/ 图片内嵌
- **额外链接**：t.co 短链自动展开为真实 URL；已过滤推文自身链接、作者 profile 链接和 analytics 链接
- **引用/回复推文**（仅书签/历史页）：书签/历史页推文若引用或回复另一条推文，被引用/回复推文会展开一层；不再继续展开它自己的引用/回复。DM 页暂不支持展开

---

## 已知限制 / Known Limitations

- **虚拟列表**：只有滚动进视口的消息才会被渲染。但单次导出条数少（约 5 条）的根因是下面的 **URI 长度上限**，不是 lazy load 硬上限；受截断的剩余消息会暂存在抓取缓存中，下一轮导出无需重新滚动加载即可继续
- **删除功能**：依赖 JS 模拟鼠标 hover 触发 React 事件，成功率不稳定；失败时请手动删除。删除仅作用于已归档或已确认失效的消息，且需二次点击确认
- **URI 长度上限**：为规避浏览器/Obsidian 对 custom URI 的截断，限制的是**双层编码后的完整 `obsidian://advanced-uri` URI 长度**（`URI_SOFT_MAX = 7000`，硬上限 `URI_MAX = 7400`），不是正文长度；超限时只导出从前往后装得下的消息前缀，剩余消息留待下一轮（从缓存继续，无需重新抓取）
- **抓取缓存**：暂存于 localStorage，按会话（conversationKey）隔离；成功删除/取消收藏的消息会从缓存移除。恢复菜单的「全部标记未抓取」会清除当前会话已导出状态，之后再次导出会写入重复内容——仅用于第一条 URI 丢失等恢复场景
- **引用层级**：引用/回复推文只展开一层，避免递归引用导致内容和 URI 体积失控
- **图片**：推文内嵌图片 URL 可能有时效限制；视频 URL（`video.twimg.com`）长期有效
- **时间戳格式**：显示 Twitter 原始相对时间（`22h` / `Mar 1`），不转换为绝对时间
- **书签页重定向**：`/i/bookmarks` 已被 X 官方重定向至 `/i/history`，旧 URL 下已导出的历史状态（localStorage 中 `twitter-dm-to-obsidian:exported:/i/bookmarks` 键）不会迁移到新 URL，可能被重复导出
- **引用/回复展开仅限书签/历史页**：该功能走 fiber 提取路径，只有 `parseBookmarkArticle()` 会填充 `referencedTweet`；DM 页的 `parseMessage()` 走纯 DOM 抓取，不展开引用/回复推文
- **引用推文媒体缺失**：经 fiber 提取的引用推文包含图片/视频；回复目标与 DOM 回退路径经 oEmbed 补全，oEmbed 不返回媒体，因此这些引用/回复块只有正文和链接

---

## 版本历史 / Changelog

| 版本 | 变更 |
|------|------|
| 3.11.0 | **抓取缓存**：已抓取并完成 oEmbed/t.co 展开/引用展开的推文信息按 conversationKey 暂存 localStorage；下次导出合并 DOM 当前消息与缓存中未导出消息（按 messageKey 去重，DOM 新鲜数据优先），已处理推文不再重复网络抓取；成功删除/取消收藏的消息从缓存移除。**原文+译文保真**：Twitter 自动翻译存在时原文与译文同时保留（译文带语言提示），译文不再覆盖原文；超长精简退化时原文与译文同进退。**恢复菜单**：按钮区最右侧新增低频小图标入口（悬浮 Tooltip，防误触），提供「重发上次导出」（重新派发上次实际生成的 Advanced URI，不重新抓取）与「全部标记未抓取」（清除当前会话已导出状态）两个动作，均需二次确认；解决 Obsidian 冷启动丢失第一条 URI 后内容被误删的问题。**上限根因澄清**：单次导出约 5 条的限制源于 URI 长度上限（`URI_SOFT_MAX=7000` / `URI_MAX=7400`），而非虚拟列表 lazy load；剩余消息可从缓存继续导出。 |
| 3.10.0 | **引用/回复展开（仅书签/历史页）**：书签/历史页推文引用或回复另一条推文时，展开被引用/回复推文正文、媒体和链接；仅展开一层，不递归展开目标推文自己的引用/回复。fiber 优先提取 `quoted_status`/`in_reply_to_status_id_str`，回复目标缺失正文时用 oEmbed 补全（oEmbed 不含媒体）。DM 页解析路径未接入。**结构化 status 链接去重**：过滤指向本条推文自身及其引用/回复目标的冗余 status 链接（作者名、时间戳、媒体、analytics 等），正文中的他人推文链接保留。**长推文**：支持 `note_tweet`，截断的长推文按完整正文导出。**视频格式**：视频媒体导出为 `<video src="..." controls style="max-width:480px"></video>` 内联标签。 |
| 3.9.5 | **DM 导出修复**：适配新 DOM（无 ul/li，嵌套 div）；`SEL.tweetAuthor` 移除失效的 `data-slot` 要求；`@match` 扩大到 `x.com/*` 解决 GreaseMonkey SPA 导航不注入按钮。**书签页 fiber 提取**：完整正文 + 译文 + 展开 URL；oEmbed 不覆盖已翻译文本。**链接清理**：过滤推文自身/analytics 链接；正文清理 t.co/pic.twitter.com。**格式**：作者名链接到 profile；Logseq outliner 格式对齐（空行无缩进、连续空行归一）。**视觉反馈**：已导出推文降低透明度（0.6）+ 左侧蓝色边框，导出/删除后自动更新 |
| 3.9.4 | 支持 `/i/history` 新 URL（X 已将 `/i/bookmarks` 重定向至 `/i/history`，历史/书签页均可注入按钮）；`GM_xmlhttpRequest` 请求增加 10 秒超时（t.co 展开与 oEmbed 超时不再拖死导出流程）；导出前先落库 `markMessagesExported` 再导航，保证删除安全门禁可靠；删除冗余 `@connect publish.twitter.com`；补充 `@match` 规则（`/i/chat/*`、`/i/bookmarks*`、`/i/history*`）；更新文档 |
| 3.9.3 | formatMarkdown 修复：推文正文多行改为嵌套列表（以 `-`、`*`、`1.` 列表标记开头的行缩进为二级 bullet，空行与续行格式归一） |
| 3.9.2 | 书签页按钮改为注入 h2 标题行容器（标题右侧水平布局）并调整配色；oEmbed 补全正文保留换行；过滤与已提取媒体重复的 `/photo/N`、`/video/N` 链接 |
| 3.9.1 | 修复书签页按钮注入位置（header caret 前，与 DM 模式一致）；书签导出跳过屏幕位置排序，保持 DOM 原始顺序（最新在前） |
| 3.9.0 | 新增书签页支持：`/i/bookmarks` 注入「📥 Obsidian」+「🗑️ 取消收藏」按钮；按钮注入时序修复（锚点缺失时 500ms 重试，最多 10 次）；导出/删除逻辑以 scraper 参数复用 |
| 3.8.4 | 删除流程适配新版 DM 操作按钮 DOM（`message-overflow-button-{UUID}`，旧版 grid-area 回退）；过滤 extraLinks 中的 Twitter/X 用户 profile 链接 |
| 3.8.3 | 已归档消息改为持久化保存并在重复导出时自动跳过；导出/删除结果改为按钮内状态；删除改为按钮二次确认 |
| 3.8.2 | 去掉错误的导出反转顺序；单条超长消息支持精简版归档；失效推文归档时跳过但加入待删除列表 |
| 3.8.1 | Advanced URI 参数改为双层编码，规避 `%` 内容触发 `URI malformed`；导出改为只归档可装下的前缀消息，删除只作用于已归档消息 |
| 3.8.0 | oEmbed 补全推文正文及链接；t.co 解析 HTML anchor 展开；删除流程适配 Radix UI Popover；虚拟列表从下往上逐条删除 |
| 3.6.0 | 输出改为 Logseq outliner 格式 |
| 3.5.0 | 提取推文作者、时间戳、视频/图片媒体 |
| 3.4.0 | 修复 URLSearchParams 空格编码为 `+` 的问题；去掉 header/footer |
| 3.3.0 | t.co 展开改用 GM_xmlhttpRequest 绕过 CSP；vault 留空使用当前打开的 vault |
| 3.0.0 | 重写：实际 Twitter DOM 选择器；双按钮（导出 + 删除） |

---

## 开发笔记：踩过的坑 / Developer Notes

### 1. URLSearchParams 把空格编为 `+`

Obsidian Advanced URI 用 `decodeURIComponent` 解码 `data` 参数，而 `URLSearchParams` 把空格编为 `+`（application/x-www-form-urlencoded 标准），`decodeURIComponent('+')` 仍是 `+`，导致所有空格变成加号。
**解决**：手动拼接 URI，不用 `URLSearchParams`。同时对传给 Advanced URI 的值做双层 `encodeURIComponent`，兼容宿主链路可能发生的一次预解码。

---

### 1.1 `URI malformed` 多半是 `%` 或超长 URI 被链路截断

部分浏览器/桌面端在把 `obsidian://advanced-uri?...` 交给 Obsidian 前，可能会先解码一层或截断过长 URI。这样一来，原文里只要有 `%`，或者 URI 末尾刚好断在 `%E4` 这种半个转义序列上，Advanced URI 插件里的 `decodeURIComponent` 就会直接抛 `URIError: URI malformed`。
**解决**：参数统一双层编码，并把单次导出的 URI 长度阈值调保守。超限时只导出前面装得下的消息，剩余消息留到下一轮处理。

---

### 2. `vault` 留空才是正确默认值

`obsidian://advanced-uri` 若带了 `vault=` 参数但 vault 名拼错，会提示"Unable to find vault"。省略 `vault` 参数时 Advanced URI 自动使用当前打开的 vault。

---

### 3. t.co 对非浏览器请求返回 200 + HTML，不做 302

`GM_xmlhttpRequest HEAD/GET` 请求 `t.co/xxx`，`r.finalUrl` 仍等于原 URL，`r.responseURL` 为 `undefined`。原因：t.co 检测到非浏览器 UA 时不执行 HTTP 重定向，而是返回一段包含 `<a id="l" href="真实URL">` 的 HTML 页面。
**解决**：解析返回的 HTML，取 `document.querySelector('a#l')?.href`；以 `<meta http-equiv="refresh">` 内容为备选。同时需要 `@connect *`，因为重定向目标域名不可预知。

---

### 4. Tampermonkey 沙箱的 `window` 不是真实 Window 对象

在 Tampermonkey 沙箱里，`window` 是一个 Proxy，把它传给 `new MouseEvent('mouseover', { view: window })` 会抛 `Failed to read the 'view' property from 'UIEventInit'`。
**解决**：`MouseEvent` 构造选项中省略 `view` 字段。

---

### 5. DM 卡片只展示推文预览，内嵌链接不完整

Twitter DM 卡片不渲染推文里的所有 t.co 链接，例如博客链接会被隐藏。
**解决**：调用 `publish.twitter.com/oembed?url=...&omit_script=true`，从返回的 blockquote HTML 里提取完整正文和所有 t.co 链接，再统一展开。此 API 对已删除/不可见推文返回 4xx，需跳过该条消息。

---

### 6. 删除菜单是 Radix UI Popover，不是 `[role="menuitem"]`

Twitter DM 消息的操作菜单已迁移到 Radix UI Popover（容器带 `data-radix-popper-content-wrapper` 属性），菜单项是普通 `<button>` 而非 `role="menuitem"` 元素。
**解决**：改用 `data-testid` 定位，删除按钮为 `action-menu-item-delete-for-me`。

---

### 7. 确认弹窗的确认按钮是 `type="submit"`

点击删除后出现 Radix Dialog 二次确认，"Delete for me"按钮的 `type` 是 `submit`，取消按钮是 `button`。用文字精确匹配（如 `=== 'delete'`）会漏掉"Delete for me"。
**解决**：选择器改为 `[role="dialog"] button[type="submit"]`。

---

### 8. 虚拟列表 DOM 节点回收导致引用失效

Twitter 消息列表是虚拟列表，`scrollIntoView` 滚动后，视口外的 `<li>` 会被回收并复用为其他消息节点。事先锁定的 `liEl`/`msgEl` 引用在第一条删除后就可能指向完全不同的消息。
**解决**：每次迭代重新调用 `scrapeLoadedMessages()` 并按 URL/文字 key 找到当前对应的节点；**从下往上删除**，使已处理的消息在底部消失，未处理的消息始终留在视口上方。
