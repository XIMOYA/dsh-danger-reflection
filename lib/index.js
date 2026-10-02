/**
 * 危险反思 (Danger Reflection).
 *
 * A permission preset that keeps the sandbox confining, but answers the
 * sandbox-escalation approval prompts that confinement produces with the
 * current conversation's own model instead of the human. When a tool call
 * needs wider permissions, this plugin replays the conversation so far into
 * the routed provider/model, appends the pending action, and asks the model to
 * decide whether that exact action is correct and should be allowed right now.
 * The model's verdict becomes the approval outcome.
 *
 * Why this hooks `approval/request` and not the approval policy: the approval
 * service short-circuits `never` before the waterfall is dispatched, so a
 * "review instead of ask" preset must keep `approval: ask` and take the
 * question away from the composed human answerer by answering it here. The
 * listener is registered `prepend` so it precedes the answerer that a client
 * contributes.
 *
 * Why the directive is a final user message rather than a `system` field: the
 * conversation's own system prompt, tool envelope, and message prefix stay in
 * front of it, so the review call is a genuine prefix of the last routed
 * request and reuses the provider's warm KV cache. This mirrors
 * `@deepseek-ai/dsh-compaction-basic`, the platform's own in-turn auxiliary
 * call over the same session.
 *
 * Fail-closed reasoning, stated plainly: a false ALLOW is the risk this feature
 * accepts by design (that is the "dangerous" half of its name), so an
 * inconclusive review never silently grants. It follows `onFailure`, which
 * defaults to handing the question back to the human answerer.
 *
 * @module dsh-danger-reflection
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Plugin identity recorded by the loader. */
export const name = 'danger-reflection'

/** The single hard dependency: the streaming model-call API. */
export const inject = ['llm']

/** Preset keys reviewed when the configuration names none. */
const DEFAULT_PRESETS = ['danger-reflection']

/**
 * Outcomes `onDeny` may name — the reviewer DID reach a denial.
 *
 * `reject` closes it here; `ask` passes that denial on to the human answerer as
 * a second opinion, which is coherent precisely because a verdict exists.
 */
const DENY_ACTIONS = ['reject', 'ask']

/**
 * Outcomes `onFailure` may name — the reviewer reached NO decision.
 *
 * `reject` is deliberately absent. The approval vocabulary has no "failed", so a
 * failure has to pick one of the four real outcomes, and `rejected` is the wrong
 * one: the caller renders it as "the user rejected escalating this command",
 * which states as fact a judgement nobody made. `unavailable` renders as "no
 * approval channel is available" — exactly what happened. A failure must not be
 * reported as a decision in either direction, which is also why `allow` is named
 * for what it does (grant anyway) rather than dressed up as a verdict.
 */
const FAILURE_ACTIONS = ['ask', 'unavailable', 'allow']

/** Placeholder replacing one attachment block in the replayed context. */
const OMITTED_IMAGE = '[image omitted by the danger-reflection reviewer]'

/**
 * Source kind marking one conversation message as this plugin's review notice.
 *
 * The notice carries the structured verdict alongside its text, so the session
 * log is the single source of truth for both the reader and the projection
 * below. This is the same shape the platform itself uses for a plugin-owned
 * message source (`{ kind: 'plugin', plugin: 'compact', … }`), and a
 * `user/message` source is validated only as a record with a `kind`, so extra
 * fields are both safe and idiomatic.
 */
const SOURCE_KIND = 'danger-reflection'

/** Verdicts a review can reach. Anything else means no decision was made. */
const VERDICTS = new Set(['allow', 'deny'])

/** The state of a session that has never been reviewed. */
const EMPTY_VERDICT = Object.freeze({ verdict: null, action: '', detail: '', toolName: null, at: 0 })

/**
 * Validator for the projected verdict state.
 *
 * `sessionProjections.register` declares `stateSchema`/`viewSchema` as zod
 * types, and every call site in `@deepseek-ai/dsh-session-projection` uses
 * exactly one method — `parse`. This package declares no dependencies, so the
 * schema is written out here rather than imported; it VALIDATES and throws,
 * because the platform relies on this schema to reject a malformed restored
 * checkpoint row, and a pass-through would silently accept one.
 */
const VERDICT_SCHEMA = {
  parse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('danger-reflection: the projected verdict must be an object')
    }
    const { verdict, action, detail, toolName, at } = value
    if (verdict !== null && !VERDICTS.has(verdict)) {
      throw new TypeError(`danger-reflection: verdict must be null or a known decision, got ${String(verdict)}`)
    }
    if (typeof action !== 'string') throw new TypeError('danger-reflection: action must be a string')
    if (typeof detail !== 'string') throw new TypeError('danger-reflection: detail must be a string')
    if (toolName !== null && typeof toolName !== 'string') throw new TypeError('danger-reflection: toolName must be a string or null')
    if (typeof at !== 'number' || !Number.isFinite(at)) throw new TypeError('danger-reflection: at must be a finite number')
    return value
  }
}

/**
 * Register the client-visible projection of this session's latest verdict.
 *
 * A client half cannot read host state directly, and this is the platform's own
 * seat for exactly that: the host folds one value per session from the committed
 * log, and the composer reads it through the standard `useProjection` prop.
 * A deployment without the projection registry simply loses the ambient chip.
 *
 * @param ctx - plugin context, read for the projection registry.
 * @param logger - diagnostic sink.
 * @returns whether the projection was registered.
 */
function registerVerdictProjection(ctx, logger) {
  const projections = ctx.get('sessionProjections')
  if (projections === undefined) return false
  try {
    ctx.effect(() => projections.register({
      key: 'dangerReflection',
      stateVersion: 1,
      stateSchema: VERDICT_SCHEMA,
      init: () => EMPTY_VERDICT,
      apply: (state, event) => {
        // Unrelated events must return the SAME reference: the registry's change
        // gate is an Object.is check on the state.
        if (event.type !== 'user/message') return state
        const source = event.data === null || typeof event.data !== 'object' ? undefined : event.data.source
        if (source === null || typeof source !== 'object' || source.kind !== SOURCE_KIND) return state
        return {
          verdict: VERDICTS.has(source.verdict) ? source.verdict : null,
          action: typeof source.action === 'string' ? source.action : '',
          detail: typeof source.detail === 'string' ? source.detail : '',
          toolName: typeof source.toolName === 'string' ? source.toolName : null,
          at: typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : 0
        }
      },
      wire: {
        viewSchema: VERDICT_SCHEMA,
        view: (state) => state
      }
    }), 'danger-reflection: verdict projection')
  } catch (error) {
    // The chip is ambient; the reviewer is the point. A registry that refuses
    // this key must cost the chip, never the interception.
    logger?.warn?.(`danger-reflection: the session verdict projection was refused, so the composer chip stays absent: ${messageOf(error)}`)
    return false
  }
  logger?.info?.('danger-reflection: published the session verdict projection for the composer chip')
  return true
}

/**
 * The reviewer directive, delivered as the final user message of the replayed
 * conversation. Kept language-matched to the feature's users while the verdict
 * vocabulary stays machine-stable.
 */
const DEFAULT_REVIEW_PROMPT = [
  '你是「危险反思」审查器。一个自主编码智能体正准备执行一个通常必须由人类确认的操作，而现在没有人可以确认。你必须代替人类，只看上下文中已有的事实，判断这一次操作此刻是否可以放行。',
  '',
  '只依据下面四条判断，不要臆测上下文里没有的信息：',
  '1. 这个操作是否直接服务于用户真实且已明确表达的请求；',
  '2. 它是否是达成该请求所需的最小范围（更小的权限、更少的文件、更小的破坏面优先）；',
  '3. 它是否触及用户没有点名的文件、目录、系统设置、凭据或外部服务；',
  '4. 是否存在不可逆、破坏性或会泄露凭据的步骤。',
  '',
  '判定 ALLOW 必须同时满足以上全部。出现下列任一情况一律 DENY：',
  '- 用户请求含糊、自相矛盾，或该操作明显超出请求范围；',
  '- 目标路径或命令未经核实，看起来是猜测出来的；',
  '- 会删除、覆盖或批量修改用户没有提到的数据；',
  '- 会把密钥、令牌或隐私内容发送到外部；',
  '- 仅凭上下文无法判断它是否正确。',
  '',
  '严格只输出一个 JSON 对象，不要输出任何其他内容，不要调用任何工具，也不要复述本提示里的任何文字：',
  '放行：{"decision":"allow","reason":"<REASON>"}',
  '拒绝：{"decision":"deny","reason":"<REASON>"}',
  'reason 必填、非空，用与对话相同的语言，一句话讲清这次操作的具体依据。',
  '每次都要针对这一次操作来写：引用用户请求与命令里的具体目标、路径、范围或影响。',
  '不要套用固定句式，不要写放之四海而皆准的套话（例如「符合用户要求」这类不说具体内容的说法），也不要照抄上面的形状说明。'
].join('\n')

/**
 * Reviewer verdicts mapped to the two decisions this plugin can make.
 *
 * The protocol is one JSON object and nothing else, parsed with `JSON.parse`
 * over the whole reply. That choice is deliberate: a substring match on free
 * text would also match the reviewer directive's own examples if the model
 * echoed the prompt or its reply was cut short mid-echo, which would read as a
 * grant. Requiring the entire reply to be one parseable object cannot be
 * satisfied by an echo.
 */
const DECISIONS = new Set(['allow', 'deny'])

/** A single fenced JSON block is unwrapped; the body must still parse as JSON. */
const FENCED_JSON = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i

/**
 * The directive's own placeholder value.
 *
 * It is the one string a reply writes only by echoing the directive rather than
 * answering it, and `<...>` is not a plausible reason for anything — so seeing
 * it means no real judgement was made, and the decision must not be trusted as
 * a grant. This is what turns the directive's "do not restate this text"
 * instruction into a check instead of a hope.
 */
const PLACEHOLDER_REASON = /^<[^<>]*>$/

/**
 * Count top-level JSON members in the raw text.
 *
 * `JSON.parse` keeps only the last of a repeated key, so `{"decision":"deny",
 * "decision":"allow"}` would otherwise parse as a grant while reading as a
 * refusal. Comparing this count against the parsed key count rejects that.
 *
 * @param text - the raw reply body.
 * @returns the number of `:` separators seen at depth 1.
 */
function topLevelMemberCount(text) {
  const syntax = text.replace(/"(?:\\.|[^"\\])*"/gs, '')
  let depth = 0
  let count = 0
  for (const character of syntax) {
    if (character === '{' || character === '[') depth += 1
    else if (character === '}' || character === ']') depth -= 1
    else if (character === ':' && depth === 1) count += 1
  }
  return count
}

/** Clip a reply for a diagnostic line. */
function clip(text) {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > 160 ? `${single.slice(0, 160)}…` : single
}

/** One inconclusive outcome carrying why no decision could be read. */
function inconclusive(note) {
  return { kind: 'inconclusive', note }
}

/**
 * Parse the closed decision protocol.
 * @param text - the reviewer's accumulated text output.
 * @returns a verdict, or why the reply could not be read as one.
 */
function parseVerdict(text) {
  const trimmed = text.trim()
  if (trimmed === '') return inconclusive('the reviewer replied with no content')
  const fenced = FENCED_JSON.exec(trimmed)
  const body = (fenced === null ? trimmed : fenced[1]).trim()
  let value
  try {
    value = JSON.parse(body)
  } catch {
    return inconclusive(`the reviewer reply is not one JSON object: ${clip(body)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return inconclusive('the reviewer output must be one JSON object')
  }
  const keys = Object.keys(value)
  if (topLevelMemberCount(body) !== keys.length) return inconclusive('the reviewer output repeats a JSON member')
  const decision = value.decision
  if (typeof decision !== 'string' || !DECISIONS.has(decision.toLowerCase())) {
    return inconclusive(`the reviewer output carries no allow/deny decision: ${clip(body)}`)
  }
  const verdict = decision.toLowerCase()
  if (keys.length === 1) {
    // Tolerated so a terse-but-correct verdict still decides; the notice and the
    // audit both record that the reviewer gave no explanation.
    return { kind: 'verdict', verdict, reason: '' }
  }
  if (keys.length === 2 && Object.hasOwn(value, 'reason') && typeof value.reason === 'string') {
    const reason = value.reason.trim()
    if (PLACEHOLDER_REASON.test(reason)) {
      return inconclusive('the reviewer echoed the directive placeholder instead of giving a reason')
    }
    return { kind: 'verdict', verdict, reason: reason.slice(0, 500) }
  }
  return inconclusive(`the reviewer output does not match the decision protocol: ${clip(body)}`)
}

/* -------------------------------------------------------------------------- */
/* configuration                                                              */
/* -------------------------------------------------------------------------- */

/** Reject one invalid configuration value with its address. */
function fail(message) {
  throw new TypeError(`danger-reflection: ${message}`)
}

/** Read an optional string field. */
function readText(value, field, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') fail(`config.${field} must be a string`)
  return value
}

/** Read an optional one-of field. */
function readAction(value, field, allowed, fallback) {
  if (value === undefined || value === null) return fallback
  if (value === 'reject' && field === 'onFailure') {
    fail('config.onFailure cannot be "reject": a review that reached no decision is not a rejection, and reporting it as one makes the caller tell the model that the USER refused the command. Use "unavailable" to close it without a decision, "ask" to hand the undecided question to the human, or "allow" to grant it anyway.')
  }
  if (typeof value !== 'string' || !allowed.includes(value)) {
    fail(`config.${field} must be one of ${allowed.map((entry) => `"${entry}"`).join(', ')}`)
  }
  return value
}

/** Read an optional positive integer field. */
function readPositiveInteger(value, field, fallback) {
  if (value === undefined || value === null) return fallback
  if (!Number.isInteger(value) || value <= 0) fail(`config.${field} must be a positive integer`)
  return value
}

/** Read an optional boolean field. */
function readBoolean(value, field, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'boolean') fail(`config.${field} must be a boolean`)
  return value
}

/** Read an optional sampling temperature, where 0 is meaningful and means "as deterministic as the provider allows". */
function readTemperature(value, field, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 2) {
    fail(`config.${field} must be a number between 0 and 2`)
  }
  return value
}

/** Read the reviewed preset keys. */
function readPresets(value) {
  if (value === undefined || value === null) return [...DEFAULT_PRESETS]
  if (!Array.isArray(value) || value.length === 0) fail('config.presets must be a non-empty array of preset keys')
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) fail('config.presets must contain non-empty strings')
  }
  return [...new Set(value)]
}

/**
 * Validate the loader-supplied configuration and apply composition defaults.
 * @param raw - untrusted configuration from the loader entry.
 * @returns frozen resolved configuration.
 */
function resolveConfig(raw) {
  const source = raw === undefined || raw === null ? {} : raw
  if (typeof source !== 'object' || Array.isArray(source)) fail('configuration must be an object')
  const verbose = readBoolean(source.verbose, 'verbose', false)
  return Object.freeze({
    presets: readPresets(source.presets),
    onDeny: readAction(source.onDeny, 'onDeny', DENY_ACTIONS, 'reject'),
    onFailure: readAction(source.onFailure, 'onFailure', FAILURE_ACTIONS, 'ask'),
    timeoutMs: readPositiveInteger(source.timeoutMs, 'timeoutMs', 120000),
    maxContextChars: readPositiveInteger(source.maxContextChars, 'maxContextChars', 400000),
    maxOutputTokens: readPositiveInteger(source.maxOutputTokens, 'maxOutputTokens', 2048),
    temperature: readTemperature(source.temperature, 'temperature', 0),
    reviewPrompt: readText(source.reviewPrompt, 'reviewPrompt', DEFAULT_REVIEW_PROMPT),
    announce: readBoolean(source.announce, 'announce', true),
    audit: readBoolean(source.audit, 'audit', true),
    auditPath: readText(source.auditPath, 'auditPath', ''),
    verbose
  })
}

/* -------------------------------------------------------------------------- */
/* session and request inspection                                             */
/* -------------------------------------------------------------------------- */

/**
 * Resolve where the audit trail is written.
 *
 * The default location is derived from the running Host rather than from an
 * environment variable, because the process that composes plugins is not
 * guaranteed to export `DSH_HOME`: the profile context knows the DSH home the
 * launcher actually used, and `~/.dsh` is the documented fallback.
 *
 * @param ctx - plugin context, read for the live profile context.
 * @param config - resolved configuration.
 * @returns the absolute audit path, or `''` when the trail is off.
 */
function auditTarget(ctx, config) {
  if (config.auditPath !== '') return config.auditPath
  if (!config.audit) return ''
  let home
  try {
    const profile = ctx.get('profileContext')
    if (profile !== undefined && typeof profile.home === 'string' && profile.home !== '') home = profile.home
  } catch {
    home = undefined
  }
  if (home === undefined) home = join(homedir(), '.dsh')
  return join(home, 'danger-reflection', 'audit.jsonl')
}

/** Render any thrown value as one diagnostic line. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve the session behind an approval request.
 * @param ctx - plugin context exposing the session store.
 * @param agent - the requesting agent.
 * @returns the live session, or `undefined` when it cannot be resolved.
 */
function sessionOf(ctx, agent) {
  if (agent === undefined || agent === null) return undefined
  if (agent.session !== undefined && agent.session !== null) return agent.session
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return undefined
  try {
    return sessions.get(agent.id)
  } catch {
    return undefined
  }
}

/**
 * Whether this session is currently on one of the reviewed presets.
 *
 * `permissionPresets.current()` resolves the durable preset identity against the
 * session's effective sandbox and approval knobs, so a session that has since
 * moved to another preset — or to a knob combination matching none — stops
 * being reviewed without this plugin tracking anything itself.
 *
 * @param ctx - plugin context exposing the permission-preset service.
 * @param session - the session whose effective preset is read.
 * @param config - resolved configuration naming the reviewed presets.
 * @returns whether this session's approvals should be reviewed.
 */
function isReviewed(ctx, session, config) {
  const presets = ctx.get('permissionPresets')
  if (presets === undefined) return false
  let current
  try {
    current = presets.current(session)
  } catch {
    // The `permissions` projection is absent or unreadable: never claim the
    // session is reviewed, so the human answerer keeps the question.
    return false
  }
  return typeof current === 'string' && config.presets.includes(current)
}

/**
 * Resolve the route the conversation is already using, so the review runs on
 * the current conversation's own model rather than a configured side model.
 * @param session - session carrying the durable request envelope.
 * @param agent - the requesting agent, read for its configured options.
 * @returns the provider/model pair and the routed tool schemas, if any.
 */
function resolveRoute(session, agent) {
  let header
  try {
    header = session.requestHeader()
  } catch {
    header = undefined
  }
  const routed = header?.config
  if (routed !== undefined && routed.provider !== undefined && routed.model !== undefined) {
    return { provider: routed.provider, model: routed.model, tools: header.tools }
  }
  let context
  try {
    context = session.requestContext()
  } catch {
    context = undefined
  }
  if (context !== undefined && context.provider !== undefined && context.model !== undefined) {
    return { provider: context.provider, model: context.model, tools: undefined }
  }
  const options = agent?.options
  if (options !== undefined && options.provider !== undefined && options.model !== undefined) {
    return { provider: options.provider, model: options.model, tools: undefined }
  }
  return undefined
}

/**
 * Read the exact tool call the approval belongs to, so the reviewer sees the
 * command itself and not only the agent's summary of it.
 * @param session - session whose log holds the committed call.
 * @param callId - the approval's tool-call identity.
 * @returns the `tool/call` payload, or `undefined` without one.
 */
function findToolCall(session, callId) {
  if (callId === undefined || callId === null) return undefined
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    let event
    try {
      event = session.eventAt(seq)
    } catch {
      return undefined
    }
    if (event === undefined || event === null) continue
    if (event.type === 'tool/call' && event.data.callId === callId) return event.data
  }
  return undefined
}

/* -------------------------------------------------------------------------- */
/* replay context                                                             */
/* -------------------------------------------------------------------------- */

/** Replace attachment blocks with inert text so the review never re-uploads binaries. */
function stripAttachments(content) {
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (block === null || typeof block !== 'object') return block
    if (block.type === 'image') return { type: 'text', text: OMITTED_IMAGE }
    if (block.type === 'file') {
      const label = block.attachment === undefined ? 'unnamed' : block.attachment.name
      return { type: 'text', text: `[file omitted by the danger-reflection reviewer: ${label}]` }
    }
    return block
  })
}

/** Approximate one message's size for the context budget. */
function costOf(message) {
  try {
    const encoded = JSON.stringify(message)
    return encoded === undefined ? 0 : encoded.length
  } catch {
    return 0
  }
}

/**
 * Re-state every tool call that has no result in this slice as plain text.
 *
 * A chat request may not carry an assistant tool call whose result is missing.
 * DSH's own DeepSeek adapter enforces this while it builds the wire request —
 * each assistant message opens a set of pending call ids, and the next
 * user/tool message must resolve all of them or the whole request is rejected
 * with `INVALID_REQUEST` ("tool calls need immediate results"). The call under
 * review is unresolved *by definition*: its result cannot exist until this
 * decision is made. Replaying it verbatim therefore broke the review on any
 * provider that validates this, which is why the shipped compaction engine only
 * ever replays ranges that are already balanced.
 *
 * Re-stating the call as text is lossless for the reviewer: the directive
 * appended after the replay carries the same name, reason, and exact arguments,
 * and the note says plainly that the call has not run.
 *
 * @param messages - the retained, attachment-stripped replay slice.
 * @returns the same messages with unmatched tool calls re-stated as text.
 */
function closePendingCalls(messages) {
  const answered = new Set()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    if (message.toolCallId === undefined || message.toolCallId === null) continue
    answered.add(message.toolCallId)
  }
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message
    let rewritten = false
    const content = []
    for (const block of message.content) {
      if (block !== null && typeof block === 'object' && block.type === 'tool-call' && !answered.has(block.id)) {
        rewritten = true
        content.push({
          type: 'text',
          text: `[工具调用 ${block.name} 尚未执行。参数：${clip(block.arguments, 400)}。这就是本次待审查的操作，它的审批结果决定它是否执行。]`
        })
        continue
      }
      content.push(block)
    }
    return rewritten ? { ...message, content } : message
  })
}

/**
 * Replay the conversation into the review request.
 *
 * The most recent messages win when the budget is exceeded, and the retained
 * slice is then normalized into a request shape providers accept: a leading
 * tool result whose call was dropped is removed, system/developer turns that
 * truncation pushed out of the prefix are dropped rather than sent
 * mid-conversation, and every still-open tool call is re-stated as text.
 *
 * @param session - session supplying the derived surface messages.
 * @param config - resolved configuration carrying the context budget.
 * @returns mutable message copies safe to extend with the reviewer directive.
 */
function buildContext(session, config) {
  const derived = session.deriveMessages()
  const kept = []
  let used = 0
  for (let index = derived.length - 1; index >= 0; index -= 1) {
    const message = derived[index]
    const cost = costOf(message)
    if (kept.length > 0 && used + cost > config.maxContextChars) break
    kept.push(message)
    used += cost
  }
  kept.reverse()
  while (kept.length > 0 && kept[0].role === 'tool') kept.shift()
  let prefix = true
  const messages = []
  for (const message of kept) {
    const systemLike = message.role === 'system' || message.role === 'developer'
    if (systemLike && !prefix) continue
    if (!systemLike) prefix = false
    messages.push({ ...message, content: stripAttachments(message.content) })
  }
  return closePendingCalls(messages)
}

/** Frame the pending action as the reviewer's directive. */
function reviewDirective(config, req, toolCall) {
  const lines = [
    '【危险反思 · 待确认操作】',
    '',
    `工具：${req.toolName}`,
    `智能体给出的理由：${req.reason === undefined ? '（未提供）' : req.reason}`
  ]
  if (req.callId !== undefined) lines.push(`调用 id：${req.callId}`)
  lines.push('原始参数：')
  lines.push(toolCall === undefined ? '（未能从会话日志中取到该次调用的参数）' : toolCall.arguments)
  lines.push('')
  lines.push('请依据上面的对话上下文，判断这次操作此刻是否可以执行，并按要求的 JSON 格式给出你的决定。')
  lines.push('')
  lines.push(config.reviewPrompt)
  return lines.join('\n')
}

/* -------------------------------------------------------------------------- */
/* the in-conversation notice                                                 */
/* -------------------------------------------------------------------------- */

/** Recursively freeze a value, matching how the platform publishes messages. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * Build one identified, immutable user-role message.
 *
 * This reproduces `createUserMessage` from `@deepseek-ai/dsh-llm` rather than
 * importing it: this package declares no dependencies, so it must load from a
 * plain `link:` install with no resolvable `node_modules` of its own. The shape
 * is the contract — `{ id, role, content, source }`.
 *
 * @param content - the content blocks to publish.
 * @param source - the producer attribution consumers can classify on.
 * @returns the frozen message to hand to an Agent inbox.
 */
function createUserMessage(content, source) {
  return deepFreeze({ id: randomUUID(), role: 'user', content, source })
}

/**
 * The heading of the notice: what the REVIEWER concluded, and nothing else.
 *
 * Deliberately independent of the resulting action. A heading that said "已拒绝"
 * for a denied verdict would be wrong twice over when `onDeny: ask` sends that
 * denial on to the human, and a failure must never be headed like a verdict it
 * did not reach.
 */
function noticeHeading(decision) {
  if (decision.kind !== 'verdict') return '⚠️ 危险反思 · 未得出结论'
  return decision.verdict === 'allow' ? '✅ 危险反思 · 模型判定：放行' : '🛑 危险反思 · 模型判定：拒绝'
}

/**
 * What actually happened to the pending operation, keyed by the action taken.
 *
 * `reject` is a decision the reviewer reached, so the wording may say the
 * operation was refused. `unavailable` is the ABSENCE of a decision, so it may
 * not: saying "被拒绝" there would put a considered judgement in the model's
 * mouth — and, because the rejection text the caller composes reads "the user
 * rejected ...", in the user's as well.
 */
function noticeOutcome(action) {
  switch (action) {
    case 'allow': return '本次提权已放行，命令会继续执行。'
    case 'reject': return '本次提权未获放行，命令没有执行。'
    case 'unavailable': return '本次提权未获放行：审查没有作出判定，命令没有执行。'
    default: return '本次提权已转交人工确认。'
  }
}

/**
 * Render the review result the way a human reads it in the conversation.
 *
 * The shape is deliberately call-and-result: a labelled heading, the call under
 * review, then the reviewer's answer behind a `↳`. It is still one user-role
 * message — a reflection cannot become a real tool call, because a tool result
 * must belong to an assistant tool-call the model actually made — but it reads
 * like the call/result pair it stands in for.
 *
 * The first line states that this is machine-generated, because the notice is
 * delivered as a user-role message and neither the reader nor the model should
 * mistake it for something the person typed.
 *
 * @param args - the decision, its resulting action, and the reviewed request.
 * @returns the plain-text notice.
 */
function noticeText({ decision, action, req, toolCall }) {
  const lines = [
    '【危险反思 · 自动审查结果（非用户发言）】',
    noticeHeading(decision),
    '',
    `工具：${req.toolName}`
  ]
  if (req.reason !== undefined) lines.push(`提权理由：${req.reason}`)
  if (toolCall !== undefined && toolCall.arguments !== undefined) lines.push(`命令：${clip(toolCall.arguments, 400)}`)
  lines.push('')
  lines.push(decision.kind === 'verdict'
    ? `↳ ${decision.reason === '' ? '（模型没有给出理由）' : decision.reason}`
    : `↳ 没有给出有效判定 —— ${decision.note}`)
  lines.push(`结果：${noticeOutcome(action)}`)
  return lines.join('\n')
}

/* -------------------------------------------------------------------------- */
/* the review call                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Replay the conversation into the routed model and read back its verdict.
 * @param ctx - plugin context exposing the LLM service.
 * @param session - session supplying history, tools, and the route.
 * @param agent - the requesting agent.
 * @param req - the pending approval request.
 * @param config - resolved configuration.
 * @param toolCall - the exact tool call under review, when found.
 * @returns the reviewer's text, terminal finish, and the route used.
 */
async function reviewWithModel(ctx, session, agent, req, config, toolCall) {
  const route = resolveRoute(session, agent)
  if (route === undefined) {
    throw new Error('no routed provider/model is available for this session yet, so the current conversation model cannot be asked')
  }
  const messages = buildContext(session, config)
  messages.push({ role: 'user', content: [{ type: 'text', text: reviewDirective(config, req, toolCall) }] })

  const signals = []
  if (req.signal !== undefined && req.signal !== null) signals.push(req.signal)
  signals.push(AbortSignal.timeout(config.timeoutMs))
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)

  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    toolHistory: session.toolHistory(),
    ...route.tools === undefined ? {} : { tools: [...route.tools] },
    maxTokens: config.maxOutputTokens,
    temperature: config.temperature,
    sessionId: session.id,
    signal
  }

  let text = ''
  let requestedTool = false
  let trailing = false
  let finish
  for await (const chunk of ctx.llm.stream(options)) {
    if (finish !== undefined) trailing = true
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') requestedTool = true
    else if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') requestedTool = true
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  return {
    text,
    requestedTool,
    trailing,
    finish,
    provider: route.provider,
    model: route.model,
    contextMessages: messages.length
  }
}

/**
 * Reduce one review result to a decision.
 *
 * An explicit, well-formed verdict wins even when the call later hit a terminal
 * failure — the verdict is self-contained, and reading it only ever lets the
 * gate reach the decision the model actually made. Everything else is
 * inconclusive, and the caller's `onFailure` policy decides what that means.
 *
 * @param result - the reviewer's output.
 * @returns a verdict with its reason, or an inconclusive note.
 */
function verdictOf(result) {
  if (result.requestedTool) return inconclusive('the reviewer model tried to call a tool instead of answering')
  if (result.trailing) return inconclusive('the reviewer emitted data after its terminal finish')
  const parsed = parseVerdict(result.text)
  if (parsed.kind === 'verdict') return parsed
  switch (result.finish?.kind) {
    case 'error':
    case 'aborted':
      return inconclusive(`the reviewer call failed: ${result.finish.failure?.message ?? 'unknown failure'}`)
    case 'max-tokens':
      return inconclusive('the reviewer reply was truncated at maxOutputTokens before any decision')
    case 'tool-calls':
      return inconclusive('the reviewer model requested a tool call')
    case 'stop':
      return parsed
    default:
      return inconclusive('the reviewer call produced no terminal finish reason')
  }
}

/* -------------------------------------------------------------------------- */
/* plugin                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Register the reviewer.
 * @param ctx - plugin context with the LLM service injected.
 * @param rawConfig - loader configuration, validated here.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const logger = ctx.logger
  /** Absolute audit path for this fiber, or `''` when the trail is off. */
  const auditPath = auditTarget(ctx, config)
  /** Sessions with a review in flight, so a nested ask can never recurse. */
  const reviewing = new Set()

  /**
   * The hash of the exact source this fiber is running.
   *
   * It rides the audit trail's load record so a decision can be attributed to a
   * specific build of this file rather than to "whatever the plugin directory
   * happened to contain". It is computed lazily and never blocks a decision.
   */
  const sourceHash = auditPath === '' ? Promise.resolve(null) : readFile(new URL('./index.js', import.meta.url), 'utf8').then(
    (source) => createHash('sha256').update(source).digest('hex').slice(0, 16),
    () => null
  )

  /** Append one audit record without ever failing the decision. */
  const audit = (record) => {
    if (auditPath === '') return
    appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8').catch((error) => {
      logger?.warn?.(`danger-reflection: audit append to ${auditPath} failed: ${messageOf(error)}`)
    })
  }

  /**
   * Map the REVIEWER's decision to the action taken and the outcome returned.
   *
   * The two branches are kept apart on purpose. A verdict is a decision, so its
   * denial may be closed (`reject`) or escalated to the human (`ask`). The
   * absence of a verdict is not a decision, so it may be handed over (`ask`),
   * closed as unanswered (`unavailable`), or granted anyway (`allow`) — never
   * reported as a rejection, because nothing was rejected.
   *
   * @param decision - the reviewer's verdict, or the reason there is none.
   * @param config - resolved configuration carrying both policies.
   * @returns the recorded action and the outcome the waterfall returns.
   */
  const resolveAction = (decision, config) => {
    if (decision.kind === 'verdict' && decision.verdict === 'allow') return { action: 'allow', outcome: 'allowed-once' }
    if (decision.kind === 'verdict') {
      return { action: config.onDeny, outcome: config.onDeny === 'ask' ? 'delegate' : 'rejected' }
    }
    switch (config.onFailure) {
      case 'allow': return { action: 'allow', outcome: 'allowed-once' }
      case 'unavailable': return { action: 'unavailable', outcome: 'unavailable' }
      default: return { action: 'ask', outcome: 'delegate' }
    }
  }

  ctx.on('approval/request', async (req, next) => {
    const session = sessionOf(ctx, req?.agent)
    if (session === undefined) return next()
    if (!isReviewed(ctx, session, config)) return next()
    if (reviewing.has(session.id)) {
      // A request raised while this session is being reviewed must not nest.
      logger?.info?.('danger-reflection: nested approval request during a review; delegating to the composed answerers')
      return next()
    }

    reviewing.add(session.id)
    const startedAt = Date.now()
    const toolCall = findToolCall(session, req.callId)
    let call
    let decision
    let thrown
    try {
      call = await reviewWithModel(ctx, session, req.agent, req, config, toolCall)
      decision = verdictOf(call)
    } catch (error) {
      thrown = error
      decision = { kind: 'inconclusive', note: `the reviewer call threw: ${messageOf(error)}` }
    } finally {
      reviewing.delete(session.id)
    }

    const durationMs = Date.now() - startedAt
    const { action, outcome } = resolveAction(decision, config)

    const detail = decision.kind === 'verdict' ? decision.reason : decision.note
    const notice = config.announce ? noticeText({ decision, action, req, toolCall }) : null
    /** Whether the notice actually reached the conversation. */
    let announced = false
    if (notice !== null) {
      const steer = req.agent?.steer
      if (typeof steer === 'function') {
        try {
          // `steer` targets the CURRENT turn's next step, so the notice lands
          // right after the pending call's own result: it is committed as a
          // durable user-role message, which is what makes it a visible entry in
          // the conversation window while also telling the model why its command
          // was allowed or refused.
          steer.call(req.agent, createUserMessage(
            [{ type: 'text', text: notice }],
            {
              kind: SOURCE_KIND,
              // The structured verdict rides the message source so the session
              // log alone can drive the composer chip, with no text parsing.
              verdict: decision.kind === 'verdict' ? decision.verdict : null,
              action,
              detail: clip(detail, 300),
              toolName: req.toolName
            }
          ))
          announced = true
        } catch (error) {
          logger?.warn?.(`danger-reflection: could not post the review notice into the conversation: ${messageOf(error)}`)
        }
      } else {
        logger?.warn?.('danger-reflection: this agent exposes no steer(), so the review notice stays out of the conversation')
      }
    }

    // Awaited only so the audit line lands in decision order; the write itself
    // swallows its own failures and can never change the outcome.
    await sourceHash.then((hash) => audit({
      kind: 'review',
      time: new Date().toISOString(),
      sourceHash: hash,
      sessionId: session.id,
      toolName: req.toolName,
      callId: req.callId ?? null,
      approvalReason: req.reason ?? null,
      toolArguments: toolCall?.arguments ?? null,
      verdict: decision.kind === 'verdict' ? decision.verdict : null,
      // Whether a decision exists at all. `verdict: null` already implies it, but
      // an explicit flag keeps "the reviewer decided" and "the review failed"
      // from ever being read as the same record.
      decided: decision.kind === 'verdict',
      detail,
      action,
      outcome,
      announced,
      notice,
      provider: call?.provider ?? null,
      model: call?.model ?? null,
      contextMessages: call?.contextMessages ?? null,
      durationMs,
      error: thrown === undefined ? null : messageOf(thrown)
    }))

    if (config.verbose || action !== 'deny') {
      logger?.info?.(`danger-reflection: ${action} "${req.toolName}" on preset ${config.presets.join('/')} after ${durationMs}ms — ${detail}`)
    }
    if (action === 'unavailable') {
      logger?.warn?.(`danger-reflection: no decision was reached for "${req.toolName}", so it was closed unanswered rather than rejected (${detail})`)
    }
    if (action === 'allow' && decision.kind !== 'verdict') {
      logger?.warn?.(`danger-reflection: granting "${req.toolName}" with NO decision behind it — onFailure is set to "allow" (${detail})`)
    } else if (action === 'allow') {
      logger?.warn?.(`danger-reflection: granting "${req.toolName}" without human confirmation (${detail})`)
    }

    return outcome === 'delegate' ? next() : outcome
  }, { prepend: true })

  registerVerdictProjection(ctx, logger)

  logger?.info?.(`danger-reflection: reviewing approval requests while the session preset is ${config.presets.map((entry) => `"${entry}"`).join(' or ')} (onDeny=${config.onDeny}, onFailure=${config.onFailure}, announce=${config.announce}, timeoutMs=${config.timeoutMs})`)

  if (auditPath !== '') {
    // Create the trail's directory once, then record which build is live. The
    // source hash lets any later decision be attributed to an exact revision of
    // this file instead of to whatever the plugin directory held at the time.
    mkdir(dirname(auditPath), { recursive: true })
      .then(() => sourceHash)
      .then((hash) => audit({
        kind: 'loaded',
        time: new Date().toISOString(),
        sourceHash: hash,
        presets: config.presets,
        onDeny: config.onDeny,
        onFailure: config.onFailure,
        timeoutMs: config.timeoutMs,
        maxContextChars: config.maxContextChars,
        maxOutputTokens: config.maxOutputTokens,
        temperature: config.temperature
      }))
      .catch((error) => logger?.warn?.(`danger-reflection: could not prepare the audit trail at ${auditPath}: ${messageOf(error)}`))
  }
}

/** Exported for tests: configuration resolution and the reviewer decision rules. */
export const internals = Object.freeze({
  resolveConfig,
  auditTarget,
  registerVerdictProjection,
  VERDICT_SCHEMA,
  EMPTY_VERDICT,
  SOURCE_KIND,
  verdictOf,
  parseVerdict,
  topLevelMemberCount,
  buildContext,
  closePendingCalls,
  stripAttachments,
  reviewDirective,
  noticeText,
  createUserMessage,
  DEFAULT_REVIEW_PROMPT
})