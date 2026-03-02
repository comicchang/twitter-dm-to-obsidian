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
3. 将 `twitter-dm-to-obsidian.user.js` 的全部内容粘贴进去
4. `Ctrl/Cmd + S` 保存，允许 `t.co` 域名访问权限

---

## 配置 / Configuration

脚本顶部 `CONFIG` 对象，通常无需修改：

```javascript
const CONFIG = {
  vault:           '',  // 留空=使用当前已打开的 vault；多 vault 时填写名称（区分大小写）
  dailyNoteFolder: '',  // Daily Note 所在子目录，留空=根目录
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
| 3.6.0 | 输出改为 Logseq outliner 格式 |
| 3.5.0 | 提取推文作者、时间戳、视频/图片媒体 |
| 3.4.0 | 修复 URLSearchParams 空格编码为 `+` 的问题；去掉 header/footer |
| 3.3.0 | t.co 展开改用 GM_xmlhttpRequest 绕过 CSP；vault 留空使用当前打开的 vault |
| 3.2.0 | 新增 t.co 短链展开；修复 Show more React 合成事件 |
| 3.1.0 | 新增额外链接提取；支持 x.com/i/chat/* 路径 |
| 3.0.0 | 重写：实际 Twitter DOM 选择器；双按钮（导出 + 删除） |
