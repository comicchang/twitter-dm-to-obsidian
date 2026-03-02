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
2. 页面右上角出现两个按钮：

   | 按钮 | 功能 |
   |------|------|
   | 📥 Obsidian | 将当前已渲染的消息导出到 Obsidian Daily Note |
   | 🗑️ 删除已载入 | 逐条删除当前已渲染的消息（不可撤销） |

3. 点击 **📥 Obsidian**，浏览器弹出"打开 Obsidian"确认框，允许后内容自动追加到今日 Daily Note

> **注意**：Twitter 使用虚拟列表，只有滚动进视口的消息才会被渲染。若需导出更多历史记录，请先向上滚动加载，再点击导出。

---

## 导出格式 / Output Format

Logseq / Obsidian outliner 格式，无额外 header/footer：

```markdown
- 砍砍.ᐟ [22h](https://x.com/i/status/2027794932224889018)
  - I've made changes to vphone-cli so you can now use the virtual device without a VNC.
  - 🎬 [视频](https://video.twimg.com/amplify_video/.../xxx.mp4?tag=14)

- 作者名 [Mar 1](https://x.com/i/status/...)
  - 推文正文第一段
  - 推文正文第二段
  - 🔗 [GitHub - repo/name](https://github.com/...)

- 纯文字 DM 内容
```

每条推文包含：
- **作者显示名** + **时间戳**（链接到原推文）
- **正文**（已展开 "Show more"）
- **媒体**：视频链接（`video.twimg.com` 长期有效）/ 图片内嵌
- **额外链接**：t.co 短链自动展开为真实 URL

---

## 已知限制 / Known Limitations

- **虚拟列表**：一次只能导出当前已渲染的消息，无法一次性导出全部历史
- **删除功能**：依赖 JS 模拟鼠标 hover 触发 React 事件，成功率不稳定；失败时请手动删除
- **URI 长度上限**：单次导出最多约 8000 字符，超出会截断并提示
- **图片**：推文内嵌图片 URL 可能有时效限制；视频 URL（`video.twimg.com`）长期有效
- **时间戳格式**：显示 Twitter 原始相对时间（`22h` / `Mar 1`），不转换为绝对时间

---

## 版本历史 / Changelog

| 版本 | 变更 |
|------|------|
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
**解决**：手动拼接 URI，只用 `encodeURIComponent`，不用 `URLSearchParams`。

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
