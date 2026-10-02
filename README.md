# 危险反思 · Danger Reflection

一个 DSH 插件，它做两件事：

1. 在**权限等级**里新增一个选项，名字就叫 **危险反思**。
2. 当 AI 执行**需要人工确认的命令**时，不再弹窗问你，而是**把当前对话交给当前对话正在使用的那个模型**，让它带着上下文反思自己这条命令是否正确，然后按反思结果放行或拒绝。

---

## 为什么这样设计

DSH 的审批（approval）只会在一种情况下被触发：命令被沙箱拒绝后，模型用 `sandbox_permissions` 申请更宽权限重试。所以：

- 权限等级的沙箱模式必须保持**受限**（本插件用 `workspace-write`）。如果沙箱是 `danger-full-access`，就永远不会产生审批请求，也就永远没有东西可以反思。
- 审批策略必须是 `ask`。审批服务在策略为 `never` 时会**在派发瀑布流之前直接返回拒绝**，插件根本没有插手的余地。

插件用 `prepend` 把自己挂在 `approval/request` 瀑布流的最前面，因此它在客户端贡献的「人类应答者」之前拿到问题。它返回结果，人类就不会被问到；它调用 `next()`，问题才会继续流向人类。

「危险」在于：放行与否只由模型自己判断，没有人类把关。「反思」在于：判断依据是模型把整段对话重放一遍后得出的结论。

### 模型看到什么

审查调用**重放当前会话的真实上下文**（`session.deriveMessages()`：系统提示词、你的原始请求、模型之前说过的话、之前所有工具调用与结果），然后追加一条 user 消息，内容是：

- 待确认的工具名；
- 智能体自己给出的理由（含升级到哪个沙箱模式）；
- 这次调用的**原始参数**（从会话日志里按 `call_id` 取回，也就是那条**真实的命令本身**，而不是模型对它的转述）；
- 审查规则与要求的输出格式。

路由取自会话自己的请求头，所以用的就是**当前对话正在用的 provider / model**，不需要额外配置。

审查指令是追在对话后面的**最后一条 user 消息**，而不是单独的 `system` 字段——这样审查请求是「最后一次真实请求」的严格前缀，能复用 provider 的 KV cache。这与 DSH 自带的 `compaction-basic` 的做法一致。

### 重放上下文必须是「工具配对配平」的

这一条是踩过坑才写下来的，值得记住：**待审查的那次调用在对话里必定是「有调用、没结果」的**——它的结果要等审批通过才可能存在。而 chat 请求不允许出现没有结果的 tool call：DSH 自己的 DeepSeek 适配器在组装线上请求时逐条校验，assistant 消息开启的每个 call id 都必须在紧随其后的 user/tool 消息里被消掉，否则整个请求直接 `INVALID_REQUEST`：

```
DeepSeek Messages tool calls need immediate results
```

（`@deepseek-ai/dsh-llm-deepseek`。）所以早期版本原样重放整段历史时，审查请求会在发出去之前就被自己的适配器拒掉，然后按 `onFailure: ask` 落回你手上——表现就是「插件好像没审查，弹窗照旧」。当时没暴露，只是因为跑的是兼容接口，它不校验这一条。

修法是加一遍配平（`closePendingCalls`）：**把没有结果的调用改写成文本**，并老实说明它还没执行、就是本次待审查的操作：

```
[工具调用 pwsh 尚未执行。参数：{"command":"node .dsh-fix/clear-stale-cache.mjs"}。这就是本次待审查的操作，它的审批结果决定它是否执行。]
```

对审查员来说是**无损**的——跟在后面的指令本来就带着同一个调用名、理由和原始参数；而已配对的调用保持原样仍是真正的 tool call，所以重放依然是真实请求的忠实前缀。（DSH 自带的 `compaction-basic` 没有这个问题，是因为它只重放由 `toolPairingBalancedAfter/Before` 保证过配平的区间；我当初重放了没配平的区间。）

### 另一个实测过的失败：输出预算被推理吃掉

`maxOutputTokens` 默认给到 **8192** 是故意的。推理模型会**先花这块预算做隐藏推理**，然后才吐出那个小 JSON；而 DSH 的 DeepSeek 适配器默认 `reasoningEffort` 是 `high`。上限给小了（最初是 2048），审查调用会在说出判定之前就被截断：

```
the reviewer reply was truncated at maxOutputTokens before any decision
```

这是实测踩到的第二个失败模式。两者都按同一条规矩处理：**报成「未得出结论」、交还人类**——绝不写成「拒绝」，也绝不静默放行。

### 模型怎么回答

严格只输出一个 JSON 对象，**两种判定都必须给出 `reason`**：

```
{"decision":"allow","reason":"…"}
{"decision":"deny","reason":"…"}
```

`reason` 是**模型针对这一次操作自己写的一句话**，插件不规定句式、不加任何前缀，只要求它讲具体依据（引用用户请求与命令里的目标、路径、范围、影响），而不是「符合用户要求」这类不说具体内容的套话。所以下面是三个不同的放行理由，措辞各不相同——这才是有意义的输出：

```
{"decision":"allow","reason":"用户要求清理构建产物，命令只删除 build/ 目录。"}
{"decision":"allow","reason":"复现构建失败需要写入工作区外的临时缓存目录，属于最小范围的提权。"}
{"decision":"allow","reason":"安装用户点名的依赖需要访问注册表，命令本身不修改仓库外的文件。"}
```

放行理由一律是模型的原话；缺 `reason` 时判定仍然有效（不会因为少一句话就把本该放行的操作推回人工），通知里会注明「模型没有给出理由」。若模型**照抄提示词里的占位符**（`<REASON>`）而不是真的作答，则视为未得出结论——这种情况不能当放行。

判定用 `JSON.parse` 解析**整个回复**，而不是在自由文本里找关键字。这一点是刻意的：如果只做子串匹配，模型把提示词里的示例原样复述出来（或回复在复述途中被截断）就会被读成「放行」。要求整段回复必须是一个可解析的 JSON 对象，复述不可能满足。另外还拒绝重复的 JSON 键（`{"decision":"deny","decision":"allow"}`），因为 `JSON.parse` 只保留最后一个。

### 你在对话窗口里会看到什么

每次审查一结束，插件都会把结果**作为一条 user 角色的消息放进当前会话**（用 `agent.steer()`，它会在当前轮次的下一步被提交成持久的 `user/message`）。排版刻意做成「调用 / 结果」的样子，一眼就像一次调用：

```
【危险反思 · 自动审查结果（非用户发言）】
✅ 危险反思 · 模型判定：放行

工具：pwsh
提权理由：escalate sandbox to danger-full-access: 需要清理构建产物
命令：{"command":"Remove-Item -Recurse -Force ./build"}

↳ 用户要求清理构建产物，命令只删除 build/ 目录。
结果：本次提权已放行，命令会继续执行。
```

> `↳` 后面是**模型的原文**，插件不加任何前缀、也不套固定句式。上面只是示意；实际措辞随每次操作而变，因为提示词明确要求针对这一次操作写具体依据，并禁止套话与照抄。

为什么不做成**真正的工具调用**（那种可以折叠的 tool call 卡片）？因为做不到，而且是结构性的：聊天记录由 `conversation.chat.node` 渲染，它的 key 是**固定的 `ChatNodeKind` 表**（19 种全部占满，里面没有「审批」这种节点）；`tool.call.toolview` 虽然 key 域开放，但它只能**装饰已存在的工具调用**，不能创造一个新的。要凭空造一个 `危险反思` 工具调用，就得同时伪造一条 assistant 消息说模型调用过它——那会让模型在下一轮看到自己调用过一个从没调用过的工具，而且 `tool/result` 没有对应的 assistant `tool-call` 会被适配器直接拒绝（`tool result has no matching call`）。所以通知只能是消息，不能是工具卡片。

拒绝时是 `🛑 危险反思 · 模型判定：拒绝` + 拒绝原因；未得出结论时是 `⚠️ 危险反思 · 未得出结论`，并说明问题被转交人工还是按配置处理了（见「失败 ≠ 拒绝」）。

通知有 3 个作用：你看得见；**模型也看得见**（所以被拒绝的命令能据此改正，而不是盲目重试）；`source` 上除了 `kind: 'danger-reflection'` 还带着**结构化的判定**（`verdict` / `action` / `detail` / `toolName`），首行也明确写了「非用户发言」，避免被读成用户指令。审计记录里同时保存了通知全文。

### 输入框上方的常驻判定小条

对话记录会往下滚，所以插件另外在**输入框上方**（`conversation.composer.dock`）放了一条常驻小条，显示本会话最近一次判定：

```
✅ 危险反思 · 已放行   pwsh
🛑 危险反思 · 已拒绝   pwsh
⚠️ 危险反思 · 未得出结论   pwsh   （审查没有作出判定）
```

鼠标悬停显示模型的完整理由。几个设计要点：

- **它读的是宿主的会话投影**（`dangerReflection`），宿主从已提交的日志里折叠出来——客户端半边不需要自己搞数据通路，也不解析文本：判定就写在通知消息的 `source` 上。
- **完全沉默地降级**：没有投影注册表、宿主拒绝这个 key、或者这个会话从未被审查过，小条就**不渲染**，什么都不显示（不是显示一个空壳）。宿主侧注册失败只会记一条警告——**小条是装饰，拦截才是本体**，绝不能因为装饰失败而让审查失效。
- 它和通知遵守同一条措辞规则：只报告**模型判了什么**，绝不把「没有判定」画成「已拒绝」。
- 它是一个**增量座位**：`conversation.composer.dock` 是 `kind: list`、`replaceRisk: none`，用自己的 `id` 加一格，不替换自带条目（不遮蔽任何东西，与上面那个权限选择器不同）。

用 `announce: false` 可以关掉。

---

## 配置

配置写在插件自身的 bundle patch（`cordis.patch.yml`）里。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `presets` | `["danger-reflection"]` | 哪些权限等级（preset **key**，不是显示名）需要反思 |
| `onDeny` | `reject` | 模型判定**拒绝**时：`reject` 直接拒绝（模型的反思就是最终结论）；`ask` 转交给人类应答者再要一次意见 |
| `onFailure` | `ask` | 审查**没能作出判定**时（模型报错、超时、输出不合协议）：`ask` 把问题交还给人类；`unavailable` 以「审查无法作答」结束（fail-closed）；`allow` 无判定直接放行 |
| `timeoutMs` | `120000` | 单次审查调用超时 |
| `maxContextChars` | `400000` | 重放上下文的上限；超出时保留最近的消息 |
| `maxOutputTokens` | `8192` | 审查调用的 token 上限。**给得宽是故意的**:推理模型会先花这块预算做隐藏推理,DSH 的 DeepSeek 适配器默认 effort 是 `high`,上限给小了就会在说出判定之前被截断(2048 实测踩过) |
| `temperature` | `0` | 审查采样温度（0 有意义） |
| `reviewPrompt` | 内置 | 审查员的判断规则，可整个替换 |
| `announce` | `true` | 是否把审查结果作为消息放进对话（见上） |
| `audit` | `true` | 是否记录审计（JSON Lines） |
| `auditPath` | `""` | 显式指定审计文件绝对路径；留空则由宿主推导到 `<DSH home>/danger-reflection/audit.jsonl` |
| `verbose` | `false` | 是否把每次「拒绝」也写进日志（「放行」始终以 warn 记录） |

### 审计记录

因为这是一个「不需要人类确认就放行」的功能，默认会留一条审计线索。位置由宿主的 profile 上下文推导（`<DSH home>/danger-reflection/audit.jsonl`），**不依赖环境变量**——组合插件的主进程不保证导出 `DSH_HOME`。文件里每行一个 JSON 对象：

- `{"kind":"loaded",...}`：插件加载时写入一次，带 `sourceHash` —— 即当前正在运行的 `lib/index.js` 的 SHA-256 前 16 位。用它可以把某次决定归因到**确切的代码版本**，而不是「当时插件目录里碰巧是什么」。
- `{"kind":"review",...}`：每次反思一行，含会话、工具名、调用 id、审批理由、**原始命令参数**、模型判定、理由、最终动作（`allow` / `deny` / 失败策略）、**`announced` 与 `notice`（对话里实际发出的通知全文）**、provider/model、耗时。

审计写入是「尽力而为」的：写失败只会记一条警告，绝不会影响判定结果。

**默认策略是 fail-closed**：只有模型明确说出 `allow` 才会放行。任何含糊、超时、报错、协议不符，都会回到人类手上，绝不会静默放行。

### 失败 ≠ 拒绝

这条是刻意做进设计里的，不是措辞问题。

DSH 的审批结果词汇是封闭的四个值：`allowed-once` / `rejected` / `cancelled` / `unavailable`——**没有「失败」这一格**。所以审查没作出判定时，必须在这四个里挑一个，而 `rejected` 是错的那个：调用方（`dsh-sandbox`）会把它渲染成

```
the user rejected escalating this command to "danger-full-access"
```

也就是说,它会把一个**没人做过的判断**说成事实——既替模型认了罪,也替你认了罪。正确的落点是 `unavailable`,调用方渲染为「审批通道无法作答」,这才是实际发生的事。

因此 `onFailure` **不接受 `reject`**(写了会在加载时明确报错并告诉你该用哪个),而且插件里所有地方都做了区分:

- **通知的标题只讲模型判了什么**,`✅ 模型判定：放行` / `🛑 模型判定：拒绝` / `⚠️ 未得出结论`,不看最终动作;
- **通知的结尾只讲实际发生了什么**,`未获放行` / `已转交人工确认` / `未获放行：审查没有作出判定`;失败路径**不会**出现「被拒绝」字样;
- **审计记录里 `verdict` 与 `decided` 分开记**,`decided: false` 明确表示「没有判定」,`action` 用 `unavailable` 而不是 `reject`。

顺带一提,`allow` 只被描述成它实际做的事(无判定也放行),不会被包装成一条判定——失败在两个方向上都不能冒充结论。

---

## 安装

这是一个 DSH profile bundle。用插件管理器按 Git 地址安装（推荐，它会自动登记 bundle、应用 patch 层并重载）：

```
dsh-danger-reflection          # 或者 https://github.com/XIMOYA/dsh-danger-reflection
```

也可以交给 agent 执行：

> 用 `plugin_manager` 的 `install_bundle` 安装 `XIMOYA/dsh-danger-reflection`

装完**重启一次 DSH 并刷新页面**（原因见下），然后在权限选择器里选 **危险反思**。

不需要任何外部依赖：插件只用 Node 内置模块，浏览器侧半边只用外壳基座表里的 `react` 与图标库。所以安装不需要联网拉依赖。

## 目录结构

```
dsh-danger-reflection/
├── package.json           # bundle 声明（dsh.bundle.patch + dsh.client），无任何外部依赖
├── cordis.patch.yml       # bundle patch：覆写 permission 行 + 插入本插件
├── lib/index.js           # 宿主侧：审批拦截 + 反思调用 + 对话通知 + 判定投影
├── lib/client.js          # 浏览器侧：接管权限选择器（图标）+ 输入框上方的判定小条
├── locale/{en,zh}.json    # 插件在插件管理器里的显示名
├── test/reflect.test.mjs  # 宿主侧单元测试（55）
├── test/client.test.mjs   # 浏览器侧契约测试（16，在 stub 浏览器里真跑一遍）
├── tools/check-patch.mjs  # bundle patch + 清单形状校验
├── tools/asar-extract.mjs # 从 app.asar 里读/搜 DSH 自身源码的小工具
├── LICENSE / NOTICE       # MIT，以及从 DeepSeek Harness 移植部分的第三方归属
└── README.md
```

以 `link:` 方式装进 profile 时，插件目录会出现在 `~/.dsh/profiles/<profile>/node_modules/dsh-danger-reflection`，并在 profile 的 `package.json` 里登记为 bundle。

> 注意：loader patch 的 `config` 是**整体替换**，不是深合并。所以 patch 里把 base 原有的三个预设（`read-only`、`workspace-write`、`danger-full-access`）原样重述了一遍。这三个预设**故意不写** `name` / `description`：客户端会用自己带的多语言文案渲染它们，一旦在这里写死，英文界面也会变成中文。新预设必须写，因为客户端没有它的文案。
>
> `danger-reflection` 排在最后也是故意的：它和 `workspace-write` 共用同一组旋钮（`workspace-write` + `ask`），而「组合默认预设」是按配置顺序取**第一个**匹配项，所以 `workspace-write` 必须排在前面，默认行为才不会被改掉。两者共用旋钮是安全且被预设服务明确支持的——持久化的 `permission/preset` 身份会把它们区分开。

---

## 图标：为什么要接管权限选择器

权限选择器里「危险反思」原本**没有图标**，而且文字还会往左偏。原因是客户端把图标**按预设值**写死在一张模块内的表里，只有 `read-only`、`workspace-write`、`danger-full-access` 三项；`permissionGlyph(value)` 对别的值返回 `undefined`，渲染时连图标元素都不生成（源码注释自己写着：*"host-configured names outside the design set get none"*）。客户端 Service 目录里没有任何图标注册表，图标库里也只有那六个 permission 图形，没有第四个可用的。所以这不是配置问题，插件没有注入点。

**做法**：`lib/client.js` 作为浏览器侧半边，占住 `conversation.input.permission` 这个槽位。该槽位是 `single` 类型——**同优先级**再注册会抛错，**不同优先级**则允许，规则是 *"register at a different priority to shadow it (lowest renders)"*；自带控件在优先级 0，本插件用 **`priority: -10`**，于是由它渲染。

**代价要说清楚**：这是一个被明确标记为 `replaceRisk: "shadows-shipped-ui"` 的替换。从此**你输入框下方的权限选择器由本插件维护**，所以 `lib/client.js` 里的目录读取、文案规则、风险确认弹窗、样式和结构都是自带控件的忠实移植；DSH 之后改进那个控件时，这份拷贝不会自动跟上。只有两处是有意的差异：

1. 多了一个第四种图标（见下）；
2. 文案放在本插件自己的 locale 命名空间 `danger-reflection.permission`，不去借用自带的 `permission.access`。

其余行为都刻意保持一致：三个自带预设的图标用的是图标库原组件；`danger-full-access` 的确认弹窗、触发器上的 `title` 说明、禁用态、busy 态、`/permission` 命令提交路径，全部沿用。

**新图标**：用自带只读图标的**同一条盾牌路径**，里面换成一只眼睛（两段对称弧 + 瞳孔）——同一个 16×16 画板、1px 描边、`currentColor`、`aria-hidden`，所以它属于同一套视觉语言，而不是旁边另贴一个。未知的宿主预设仍然保持 DSH 原本的行为（没有图标），不会凭空多出东西。

浏览器侧只向运行时要两样：`react` 和 `@deepseek-ai/dsh-client-ui-primitives`。两者都在外壳的**冻结基座模块表**里，所以 `dsh.client` 不需要声明任何 `external`；快照源（`getSnapshot`/`subscribe`）是自己写的十来行，没有引入额外依赖。

### 这次改动的生效条件

浏览器侧半边由**宿主**扫描 `dsh.client` 声明后提供，而宿主把「包元数据按 Loader specifier 缓存**至重启**」。所以：

1. **需要重启一次 DSH**（和模块代码那次是同一次，不是额外一次）；
2. 重启后**刷新页面**。若 `pnpm run dev:web` 没有在跑，客户端插件不会热更新——改 `lib/client.js` 同样需要重启 + 刷新。

---

## 使用

1. 在输入框下方的**权限等级**选择器里选 **危险反思**（也可以用 `/permission danger-reflection`）。
2. 之后当某条命令需要更宽权限时，模型会先自我反思，而不是弹窗问你。
3. 想留档就打开审计记录（默认已开，见上）。

> 权限等级是**按会话**生效的。切换只影响当前会话。

> **改了插件代码之后需要重启 DSH（首次安装后也需要一次），然后刷新页面。** 原因有两层：
>
> 1. **宿主侧模块代码**：DSH 的 HMR 默认 `root: []`，模块监视是 opt-in 且必须在启动前配置好，所以 `lib/index.js` 的改动不会热加载。
> 2. **浏览器侧半边**：宿主把包元数据按 Loader specifier **缓存至重启**，新出现的 `dsh.client` 声明要重启后才会被扫描并提供；而客户端插件在没有 `pnpm run dev:web` 的情况下也不会热更新。
>
> 安装/启用插件、以及 `cordis.patch.yml` 里的**配置**改动都是即时生效的，只有**代码**不是。
>
> 本插件已经替你把第 1 层配好了：profile 的 `cordis.patch.yml` 末尾加了一段带 `# BEGIN/END DANGER REFLECTION (managed)` 注释的 `hmr` 行，把插件源码目录加入 `root`。**重启一次之后**，改 `lib/index.js` 就会实时生效。想恢复默认就删掉那一段（原始文件已备份为 `cordis.patch.yml.bak-danger-reflection`）。第 2 层没有等价开关，改 `lib/client.js` 仍需重启 + 刷新。

---

## 测试

```bash
node test/reflect.test.mjs          # 宿主侧 55 个用例
node test/client.test.mjs           # 浏览器侧 16 个用例
node tools/check-patch.mjs          # bundle patch + 清单形状校验
```

> 这里直接执行测试文件，而不是 `node --test test/`：在 `workspace-write`（受限）文件策略下，`node --test` 为每个文件 spawn 子进程并用管道捕获输出，会被沙箱以 `EPERM` 拒绝。直接执行则在同进程内跑，不 spawn。

`test/reflect.test.mjs` 覆盖：判定协议（含复述攻击、占位符回显、重复键、allow/deny 各自带理由）、fail-closed 各路径、预设归属、重放请求的形状与**线上请求合法性**（工具配对配平、镜像 DeepSeek 适配器的不变量）、**对话通知**（放行/拒绝/未判定三种文案、原文引用不加套话、「失败绝不写成拒绝」、`announce: false`、缺 `steer()` 与 `steer()` 抛错都不影响判定）、**判定投影**（只折叠自己的通知、无关事件保持同一引用、畸形输入不凭空造判定、schema 真的会抛错、注册表缺失或被拒只丢小条）、审计记录与测试隔离、附件剥离与上下文截断。

`test/client.test.mjs` 用 stub 的 `window.__ModuleLoader__`、`react`、primitives 和 Client context **真正执行**浏览器侧半边，再把它渲染出来。之所以值得这么做：客户端半边在重启前完全无法验证，而这个测试正好覆盖几件看不见就会出错的事——**槽位真的被一个能赢的优先级接管**、**「危险反思」那一行真的有图标**（并断言三个自带预设没有丢图标、未知宿主预设仍保持无图标）、**判定小条是增量座位且不会把「没有判定」画成「已拒绝」**、以及没有投影能力或没有翻译函数时静默降级而不抛错。另外还校验浏览器模块 id 等于包名、`exports["./client"]` 存在、不需要任何 `external`、以及宿主半边不会反向引入浏览器半边。

`tools/check-patch.mjs` 独立校验 YAML 与清单：patch 是**整体替换**，且目标不存在的 patch 只会被**警告并跳过**，所以这里的字段写错不会报错、只会静默地让「危险反思」从选择器里消失——因此单独检查它。它需要能解析 YAML，找不到解析器时会以退出码 2 明确告诉你它没跑。

`tools/asar-extract.mjs` 是写这个插件时用来读 DSH 自身源码的工具（`list` / `extract` / `grep` 三种模式，直接读 `resources/app.asar`）。本插件的挂载点、`approval/request` 瀑布流的顺序语义、以及预设表的整体替换规则，都是用它的 `grep` 模式从 `@deepseek-ai/dsh-user-approval`、`dsh-permission-presets`、`cordis-plugin-loader` 等包里读出来的：

```bash
node tools/asar-extract.mjs list  "<安装目录>/resources/app.asar" "dsh/node_modules/@deepseek-ai"
node tools/asar-extract.mjs grep  "<安装目录>/resources/app.asar" "dsh/node_modules/@deepseek-ai/dsh-user-approval" "approval/request"
node tools/asar-extract.mjs extract "<安装目录>/resources/app.asar" "dsh/node_modules/@deepseek-ai/dsh-permission-presets" ./out
```

---

## 与官方 `auto-review` 的关系

DSH 自带一个**可选**bundle `@deepseek-ai/dsh-experimental-auto-review`（默认关闭），它给 `auto` 预设提供「每次工具调用都由同模型审查」的能力。区别：

| | 官方 auto-review | 本插件 危险反思 |
|---|---|---|
| 权限等级显示名 | `Auto review`（EXP） | **危险反思** |
| 触发时机 | 每一次原生工具调用 | **只有需要人工确认的命令**（审批请求） |
| 挂载点 | `tools/pre-execute` | `approval/request` |
| 上下文 | 重新构造的、带角色标注的过滤历史 | **重放当前会话的真实上下文** |
| 沙箱 | `danger-full-access`（不设沙箱） | `workspace-write`（保持受限） |
| 模型判定为拒绝时 | `ask` 策略下交还人类 | 默认直接拒绝（可配 `onDeny: ask` 改成前者） |
| 模型调用失败时 | 直接拒绝 | 默认交还人类；可选 `unavailable`（以「无法作答」结束）或 `allow`。**不接受 `reject`**：失败不是判定 |
| 对话里能看到结果吗 | 看不到，只有一条工具错误 | **能看到**：判定 + 模型原话作为消息写进对话，输入框上方还有常驻小条 |

两者不冲突，可以同时启用。本插件的输出协议刻意比照官方做了加固（整段 JSON 解析、重复键防护、终止后无额外数据）。

---

## 已知限制

- **选择「危险反思」不会弹风险确认框。** 本轮已由本插件接管权限选择器，但为了忠实移植，确认门仍然只对 `danger-full-access` 和 `auto` 生效（自带行为如此）。选之前请确认你理解：放行完全由模型决定。这是一个可以补上的缺口——`RiskConfirmation` 原语和文案都已就位，加一段门控即可；之所以没顺手加，是因为它会改变你原本要求的界面一致性。
- **输入框下方的权限选择器现在由本插件维护。** 这是一次被槽位系统标记为 `replaceRisk: "shadows-shipped-ui"` 的替换：DSH 之后改进那个控件时，`lib/client.js` 里的移植副本不会自动跟上。三个自带预设的行为保持一致，但升级 DSH 后值得复核一次。
- 预设的 `description` 是宿主提供的单一字符串，无法随界面语言切换（英文界面也会显示中文描述）。
- 本插件没有 `Config` schema（为避免声明外部依赖、保证离线可装），所以**不能在图形界面的设置表单里改配置**，需要改 `cordis.patch.yml`。

---

## 开发

```bash
npm test     # 宿主侧 55 + 浏览器侧 16
npm run check  # bundle patch + 清单形状校验
```

或者直接跑单个文件（在受限文件策略下 `node --test` 会 spawn 子进程、被沙箱以 `EPERM` 拒绝，所以直接执行）：

```bash
node test/reflect.test.mjs
node test/client.test.mjs
node tools/check-patch.mjs
```

`tools/asar-extract.mjs` 是写这个插件时用来读 DSH 自身源码的工具（`list` / `extract` / `grep`，直接读 `resources/app.asar`）——本插件的挂载点、瀑布流顺序语义、预设表规则、以及线上请求不变量，都是用它的 `grep` 模式从 DSH 自己的包里读出来的。

---

## 许可

[MIT](LICENSE)。`lib/client.js` 含移植自 DeepSeek Harness（同为 MIT）的代码——包括权限选择器组件、其 CSS 规则、以及新图标里沿用的盾牌路径。具体来自哪些包、移植了什么，见 [NOTICE](NOTICE)。