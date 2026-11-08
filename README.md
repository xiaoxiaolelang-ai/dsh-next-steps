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
- **Shift+点击** = 只填进输入框，不发送，改完自己按回车。**草稿里已经有内容时是追加**（换行分隔），不会把你打的字冲掉。
- 发送**成功**才锁定按钮（该条标灰、其余禁用）；**提交失败会解锁并显示原因**，可以直接重试——不会出现"按钮全灰但什么都没发出去"。
- 悬停显示完整 `prompt`（当它比按钮文字长时）以及「Shift+点击只填入」的提示。
- 无障碍：这组按钮是一个 `role="group"` 区域，带本地化标题（"下一步建议" / "Next steps"）；每条按钮的文字本身就是动作描述。

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

建议不是插件凭空生成的，它来自**这一轮的工具调用结果**。插件注册一条常驻提示（`prompt: always`，排在系统提示接近末尾的 9899 位），要求模型每轮收尾都调用 `suggest_actions`——例外只有「纯确认、且没有下一步可做」的那种回复。

0.1.4 起这条提示只有 6 条规则、约 116 词（早期版本写到 247 词，而且把"发布 release → 更新条目"这种具体流程写了进去，等于过拟合一个场景）：

- **每轮都要调用**，只有"纯确认且没有下一步"才免。
- **首条 = 下一步**，标 `recommended`。判断标准：*"如果用户只说了‘继续’，他实际会做什么？"* 已经做完的事不算步骤。
- **需要用户在聊天外完成的事**，写成**他完成后会发的那句话**，而不是"你去……"的指令。
- 每条必须**落到具体对象**（文件、命令、报错或数值）；**一条真的胜过四条凑数**。
- `label` 是动作本身（对话语言），`prompt` 是用户真会发出去的那句话。
- 禁止泛泛填充，禁止让人再确认已经确认过的事。

提示词刻意**不绑定任何具体场景**（不出现 release / pipeline / merge 这类词），换到写代码、查资料、做文档都同样成立。测试里有两条断言守着这条底线：词数 ≤ 200，且不得出现那批场景词。
即便如此，**模型仍有可能漏掉某一轮**——这是提示词约束的固有限制，没有任何机制能保证百分之百。真实的失败方式是"那一轮什么都不显示"，不会串轮、不会显示上一轮的建议。插件的统计口径是：从 0.1.3 之前的实测看，带提示的轮次里约 70% 真的发起了调用；改完之后是否提高，要看后续数据。

## 原理与兼容

- **Host 半**：注册 `suggest_actions` 工具，负责清洗（按立场去重、只留一个推荐、推荐置顶、`stop` 沉底、截断到上限），把算好的结果随工具结果一起交给客户端。
- **Client 半**：不注册采集器，只注册 `conversation.chat.turnTail`；用宿主给的 `turn.start.seq` / `turn.end.seq` 定位本轮的工具结果。节点内部形状不是公开契约，所以按「数据段前缀」深搜而不是写死路径；万一认不出来，降级到采集器，且仍然只挂最新一轮。
- **零依赖**：不 import 任何 `@deepseek-ai/*` 包（本地目录安装时那些包解析不到），工具用明文 JSON Schema 直接注册。
- 声明 `engines.dsh >= 0.2.2-rc.1`，在 `0.2.2-rc.1` 上验证。

## 重启后为什么还能看到

会话重新打开时，宿主会重放历史。重放出来的节点形状和实时流不一定一样，插件可能认不出里面那段数据，于是历史轮次的建议会消失。

所以插件会**自己记一份**：每次实时渲染出建议时，按「会话 + 该轮的收尾 seq」写进 localStorage（键 `dsh-next-steps:tails:v1`，最多 400 条）。重启后如果节点重放认不出数据，就用记下的那一份；键里带着轮次，所以只可能是“这一轮自己的建议”，不会把上一轮的顶上来。

代价：清掉站点数据（localStorage）后，历史轮次的建议就真的没了——但只影响历史，不影响新的一轮。

## 两种调用形态都支持

DSH 里工具可能有两种调用形态：**native**（模型直接发起工具调用，结果是会话里的顶层工具行）和 **PTC / `run_code`**（模型在程序里 `await tools.xxx()`，结果是 `tool/ptc-dispatch` 事件）。

0.1.x 只在 native 下工作——PTC 会话里永远收不到数据（实测：那类会话的请求里 `tools` 只有一个 `run_code`）。0.2.0 起，插件把每轮的 actions 写进**会话投影**（`sessionProjections`，key `next-steps`）：

- 投影从**事件参数**里取结构化 actions，两种形态都能覆盖；
- 历史会话靠重放事件自然重建，**不再依赖 localStorage 记忆**；
- 客户端读 `faceOf('next-steps')`，读不到（旧版宿主）再退回原来的文本通路。

性能上的两条约束写进了测试：不相关的事件必须返回**同一个 state 引用**（宿主据此跳过重算）；坏参数不抛错也不改状态。

**开关**：配置里 `projection: off` 会完全不注册投影单元、退回旧的文本通路。0.2.0 的第一次实现漏了宿主要求的 `stateSchema` / `wire.viewSchema`（宿主会直接调用它们的 `parse`），导致整段会话加载失败——所以这个开关必须有：出问题时关掉投影即可，不必禁用整个插件。

## 已知限制

- 工具结果里那段给客户端读的 JSON（前缀 `dsh-next-steps/v1`）也会进入模型上下文，每次约几百 token。改用 host 的 session projection + `wire.view` 可以消掉，但目前没做。
- 如果宿主某轮没有提供 `turn.start.seq`，按轮定位会退化成"截至本轮"——那种情况下，某一轮没调用工具时可能沿用上一轮的建议。
- 客户端不导出 `Config`，配置项不做 schema 校验，取值时按默认值兜底。

## 开发与自检

三个脚本都在本包目录内，路径按脚本自身位置解析，从任何目录跑都可以：

- `_test-next-steps.mjs`（13 项）：用假 React/假 ctx 驱动真实组件，覆盖逐轮投影、不继承上一轮、`latest`/`all` 两种模式、1/3 条跨列、缓存失效、跨会话隔离、兜底通道。
- `_test-normalize.mjs`（5 项）：从 `index.js` 里抽出 `normalizeActions` 直接跑，覆盖推荐置顶、`stop` 沉底、去重、截断、非法输入过滤。
- `_test-host.mjs`（5 项）：假 ctx 跑 Host 半边，验证工具注册、常驻提示的 section 顺序、`prompt: off` 时不注册。
- `_test-actions.mjs`（7 项）：带状态的 hook shim，验证点击发送、**失败后可重试**、Shift+点击**追加**已有草稿、以及无障碍标记。

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
