# 下一步建议 · dsh-next-steps

在每轮回复下方给出一组可点的下一步建议：**2×2 最多四格**，每一条都只属于它自己那一轮。

建议是**按轮次投影**出来的：每个轮次尾部只读它自己那一轮的工具结果，所以历史轮次各自定格、新的一轮不会继承上一轮的按钮，晚到的结果也会触发重渲染。

## 设计取舍

- **按轮次投影，不共享状态。** 每个轮次尾部只回答一个问题：「在（本轮起点, 本轮收尾] 之间，有没有一条 `suggest_actions` 结果？」历史轮次各自定格在自己那一组，晚到的结果也会触发重渲染。没有 Map、没有 render 副作用、没有跨组件传递。
- **2×2 版式。** 一次最多四条：1 条整宽、2 条一行、3 条末条跨列、4 条标准 2×2。超过四条在 host 侧直接截断，不做"还有 N 条"——那会破坏版式。
- **三档视觉。** 主推用强调色（DeepSeek 蓝）16% 底 + 55% 描边 + 3px 左座条；常规用主文字色 8% 叠底；`stop` 用 5% 叠底、次级文字。**全部基于主题令牌与 alpha 叠加**，浅色/深色自动跟随，代码里没有一处硬编码颜色。
- **不突兀。** 不加卡片/边框/阴影，字号比正文小一档、两行截断，圆角与原生按钮同档；和下方「点赞那排」之间用宿主已有的 16px 间距，不额外补边距。
- **窄容器自适应。** 右侧栏打开或窗口变窄时，`@container ≤420px` 自动降成一列。

## 交互

- **点击** = 把建议文本作为你的消息发出去（走输入框的 setDraft → 落定 → submit）。
- **Shift+点击** = 只填进输入框，不发送，改完自己按回车。
- 点击后该条标灰、其余暂时禁用，防连点；失败会在下方显示原因，不静默。
- 悬停显示完整 `prompt`（当它比按钮文字长时）以及「Shift+点击只填入」的提示。

## 安装

```
dsh plugin add dsh-next-steps
```

或者插件管理器里添加 `dsh-next-steps`。

> 同一个「轮次尾部」如果还有别的插件也往里放建议按钮，会出现两排；那种情况下同一时间只启用一个。

## 配置

写在 profile 的 `cordis.patch.yml` 里本插件那一行的 `config` 下：

```yaml
- id: next-steps
  config:
    maxActions: 4      # 1-4，默认 4
    history: latest    # latest=只在最新一轮显示（默认）；all=每轮都显示当轮的建议
    prompt: always     # always=注册一条常驻指令，让模型每轮收尾都调用工具；off=不注册
```

## 为什么某轮可能没有按钮

建议不是插件凭空生成的，它来自**这一轮的工具调用结果**。插件会注册一条常驻提示（`prompt: always`），要求模型在收尾时调用 `suggest_actions`；但如果某一轮模型没调用，那一轮就确实什么都不显示——这是刻意的：绝不把上一轮的按钮顶上来充数。

## 原理与兼容

- **Host 半**：注册 `suggest_actions` 工具，负责清洗（按立场去重、只留一个推荐、推荐置顶、`stop` 沉底、截断到上限），把算好的结果随工具结果一起交给客户端。
- **Client 半**：不注册采集器，只注册 `conversation.chat.turnTail`；用宿主给的 `turn.start.seq` / `turn.end.seq` 定位本轮的工具结果。节点内部形状不是公开契约，所以按「数据段前缀」深搜而不是写死路径；万一认不出来，降级到采集器，且仍然只挂最新一轮。
- **零依赖**：不 import 任何 `@deepseek-ai/*` 包（本地目录安装时那些包解析不到），工具用明文 JSON Schema 直接注册。
- 声明 `engines.dsh >= 0.2.2-rc.1`，在 `0.2.2-rc.1` 上验证。

## 已知限制

- 工具结果里那段给客户端读的 JSON（前缀 `dsh-next-steps/v1`）也会进入模型上下文，每次约几百 token。改用 host 的 session projection + `wire.view` 可以消掉，但目前没做。
- 如果宿主某轮没有提供 `turn.start.seq`，按轮定位会退化成"截至本轮"——那种情况下，某一轮没调用工具时可能沿用上一轮的建议。
- 客户端不导出 `Config`，配置项不做 schema 校验，取值时按默认值兜底。

## 开发与自检

- `_test-next-steps.mjs`（工作区根目录）：用假 React/假 ctx 驱动真实组件，覆盖逐轮投影、不继承上一轮、`latest`/`all` 两种模式、1/3 条跨列、缓存失效、跨会话隔离、兜底通道。
- `_test-normalize.mjs`：从 `index.js` 里抽出 `normalizeActions` 直接跑，覆盖推荐置顶、`stop` 沉底、去重、截断、非法输入过滤。

## License

MIT

---

# dsh-next-steps (English)

Clickable next-step suggestions under each reply: up to four, in a 2x2 grid, and **each turn only ever shows its own suggestions**.

Suggestions are **projected per turn**: each turn tail reads only its own turn's tool result, so historical turns keep their own set and a new turn never inherits the previous one's buttons.

- **Per-turn projection.** Each turn tail answers one question — *is there a `suggest_actions` result inside (this turn's start, this turn's end]?* Historical turns keep their own set; late results re-render. No shared map, no render-phase side effects, no cross-component handoff.
- **2x2 layout.** One entry spans the row, two sit side by side, three give the last one a full row, four make a clean 2x2. Anything beyond four is truncated host-side.
- **Three visual tiers.** Recommended: accent colour at 16% fill, 55% outline, 3px left bar. Normal: 8% ink overlay. `stop`: 5% overlay with secondary text. Everything is a theme token plus alpha, so light and dark follow the host with no literal colours.
- **Quiet by design.** No card, border or shadow; one step below body text, clamped to two lines, same corner radius as native buttons, reusing the host's existing 16px gap.
- **Narrow columns.** `@container (max-width: 420px)` collapses the grid to one column.

Interaction: click sends the text as your message; **Shift+click** only fills the composer; buttons disable after a click; failures are shown, never swallowed.

### Configuration

In the profile's `cordis.patch.yml`, on this plugin's row:

```yaml
- id: next-steps
  config:
    maxActions: 4      # 1-4, default 4
    history: latest    # latest = newest turn only (default); all = every turn keeps its own
    prompt: always     # always = register a standing instruction so the tool is called every turn; off = don't
```

Suggestions come from the turn's own tool call. With `prompt: always` the model is asked to call `suggest_actions` at the end of every reply; if a turn still has no call, that turn simply shows nothing — it never borrows the previous turn's buttons.

Requires DSH `>= 0.2.2-rc.1`. Zero dependencies. Only one plugin that adds rows to the turn tail should be enabled at a time. MIT.
