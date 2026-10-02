/**
 * Unit tests for 危险反思 (Danger Reflection).
 *
 * These drive the registered `approval/request` listener against a stub host, so
 * the reviewer's decision rules, the replayed request shape, and the
 * fail-closed paths are all verified without a live DSH runtime.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, internals, name as pluginName, inject } from '../lib/index.js'

const { resolveConfig, verdictOf } = internals

/* -------------------------------------------------------------------------- */
/* stubs                                                                      */
/* -------------------------------------------------------------------------- */

/** Build a derivation-order history the reviewer must replay. */
function history() {
  return [
    { role: 'system', content: [{ type: 'text', text: 'AGENT SYSTEM PROMPT' }] },
    { role: 'user', content: [{ type: 'text', text: '帮我清理一下构建产物' }] },
    { role: 'assistant', content: [{ type: 'text', text: '先看一下目录' }] },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'build/  dist/  src/' }] },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-2', name: 'pwsh', arguments: '{"command":"Remove-Item -Recurse -Force C:\\\\"}' }]
    }
  ]
}

/** One stub session exposing exactly the surface the plugin reads. */
function makeSession(overrides = {}) {
  const events = [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-2', name: 'pwsh', arguments: '{"command":"Remove-Item -Recurse -Force C:\\\\"}' } }
  ]
  return {
    id: 'session-test',
    seq: events.length,
    deriveMessages: () => history(),
    requestHeader: () => ({ config: { provider: 'stub-provider', model: 'stub-model' }, tools: [{ name: 'pwsh', description: 'run', parameters: {} }] }),
    requestContext: () => ({ provider: 'stub-provider', model: 'stub-model' }),
    toolHistory: () => ({ tools: [], updates: [] }),
    eventAt: (seq) => events[seq],
    ...overrides
  }
}

/**
 * A realistic tail: one resolved call/result pair, then the call under review.
 * This is the shape a real session has when an approval is pending, and it is
 * the shape that made the review fail on a validating provider.
 */
function realisticHistory() {
  return [
    { role: 'system', content: [{ type: 'text', text: 'AGENT SYSTEM PROMPT' }] },
    { role: 'user', content: [{ type: 'text', text: '帮我把那个过期的缓存目录挪开' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'pwsh', arguments: '{"command":"Get-ChildItem .dsh-fix"}' }] },
    { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'clear-stale-cache.mjs' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-2', name: 'pwsh', arguments: '{"command":"node .dsh-fix/clear-stale-cache.mjs"}' }] }
  ]
}

/**
 * Mirror the invariant `@deepseek-ai/dsh-llm-deepseek` enforces while it builds
 * the wire request: each assistant message opens a set of pending tool call ids
 * and the next user/tool message must resolve all of them, or the request is
 * rejected before it ever leaves the process.
 *
 * @param messages - the request's message list.
 * @returns the adapter's rejection reason, or `null` when it would be accepted.
 */
function deepseekWireCheck(messages) {
  const wire = []
  for (const message of messages) {
    const role = message.role === 'tool' ? 'user' : message.role
    const blocks = message.role === 'tool'
      ? [{ type: 'tool_result', id: message.toolCallId }]
      : (message.content ?? [])
        .filter((block) => block.type === 'tool-call')
        .map((block) => ({ type: 'tool_use', id: block.id }))
    const previous = wire.at(-1)
    if (previous !== undefined && previous.role === role) previous.blocks.push(...blocks)
    else wire.push({ role, blocks })
  }
  let pending = new Set()
  for (const message of wire) {
    if (message.role === 'assistant') {
      pending = new Set(message.blocks.filter((block) => block.type === 'tool_use').map((block) => block.id))
      continue
    }
    if (message.role !== 'user') continue
    for (const block of message.blocks.filter((candidate) => candidate.type === 'tool_result')) {
      if (!pending.delete(block.id)) return 'tool result has no matching call'
    }
    if (pending.size > 0) return 'tool calls need immediate results'
  }
  if (pending.size > 0) return 'history ends with unresolved tools'
  return null
}

/** One stub host capturing the registered listener and the streamed options. */
function makeHost({ reply, preset = 'danger-reflection', currentThrows = false, home = tmpdir(), steer } = {}) {
  const captured = { listener: null, listenerOptions: null, options: null, calls: 0, warnings: [], infos: [], steered: [] }
  const ctx = {
    logger: {
      info: (line) => captured.infos.push(line),
      warn: (line) => captured.warnings.push(line)
    },
    get: (key) => {
      if (key === 'permissionPresets') {
        return {
          current: () => {
            if (currentThrows) throw new Error('permissions projection is not registered')
            return preset
          }
        }
      }
      if (key === 'sessions') return { get: () => undefined }
      // Never let a test reach the real DSH home: the default audit location is
      // derived from the profile context, so the stub points it at a temp dir.
      if (key === 'profileContext') return { home: home }
      return undefined
    },
    on: (event, listener, options) => {
      assert.equal(event, 'approval/request')
      captured.listener = listener
      captured.listenerOptions = options
      return () => {}
    },
    llm: {
      stream: async function* (options) {
        captured.options = options
        captured.calls += 1
        yield* reply
      }
    }
  }
  return { ctx, captured }
}

/** Chunks for a plain text reply terminated by `stop`. */
function textReply(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } }
  ]
}

/** Run one approval through a freshly applied plugin. */
async function runApproval({ reply, config, hostOptions = {}, req = {}, next = async () => 'unavailable', agent, session } = {}) {
  const { ctx, captured } = makeHost({ reply, ...hostOptions })
  apply(ctx, { audit: false, ...config })
  const request = {
    agent: agent ?? {
      id: 'session-test',
      session: session ?? makeSession(),
      options: {},
      steer: (message) => captured.steered.push(message)
    },
    toolName: 'pwsh',
    callId: 'call-2',
    reason: 'escalate sandbox to danger-full-access: 需要删除整个目录',
    ...req
  }
  const outcome = await captured.listener(request, next)
  return { outcome, captured, request }
}

/* -------------------------------------------------------------------------- */
/* configuration                                                              */
/* -------------------------------------------------------------------------- */

test('plugin declares its identity and its one hard dependency', () => {
  assert.equal(pluginName, 'danger-reflection')
  assert.deepEqual(inject, ['llm'])
})

test('composition defaults are the documented fail-closed policy', () => {
  const config = resolveConfig(undefined)
  assert.deepEqual(config.presets, ['danger-reflection'])
  assert.equal(config.onDeny, 'reject')
  assert.equal(config.onFailure, 'ask')
  assert.equal(config.timeoutMs, 120000)
  assert.equal(config.audit, true, 'the audit trail is on by default')
  assert.equal(config.auditPath, '', 'no path is hard-coded; the Host derives the default location')
})

test('the default audit location is derived from the Host, not from the environment', () => {
  const withProfile = internals.auditTarget({ get: () => ({ home: 'C:/host-home' }) }, { audit: true, auditPath: '' })
  assert.match(withProfile.replace(/\\/g, '/'), /^C:\/host-home\/danger-reflection\/audit\.jsonl$/)

  const withoutProfile = internals.auditTarget({ get: () => undefined }, { audit: true, auditPath: '' })
  assert.match(withoutProfile.replace(/\\/g, '/'), /\/danger-reflection\/audit\.jsonl$/)

  assert.equal(internals.auditTarget({ get: () => ({ home: 'C:/h' }) }, { audit: false, auditPath: '' }), '', 'audit: false disables the trail')
  assert.equal(internals.auditTarget({ get: () => ({ home: 'C:/h' }) }, { audit: true, auditPath: 'D:/explicit.jsonl' }), 'D:/explicit.jsonl', 'an explicit path wins')
})

test('invalid configuration is rejected with its address', () => {
  assert.throws(() => resolveConfig({ onDeny: 'maybe' }), /config\.onDeny must be one of/)
  assert.throws(() => resolveConfig({ onFailure: 'explode' }), /config\.onFailure must be one of/)
  assert.throws(() => resolveConfig({ presets: [] }), /config\.presets must be a non-empty array/)
  assert.throws(() => resolveConfig({ timeoutMs: 0 }), /config\.timeoutMs must be a positive integer/)
  assert.throws(() => resolveConfig({ temperature: -1 }), /config\.temperature must be a number between 0 and 2/)
  assert.throws(() => resolveConfig({ temperature: 3 }), /config\.temperature must be a number between 0 and 2/)
  assert.equal(resolveConfig({ temperature: 0 }).temperature, 0, 'zero is a meaningful sampling temperature')
  assert.throws(() => resolveConfig({ auditPath: 7 }), /config\.auditPath must be a string/)
  assert.throws(() => resolveConfig({ verbose: 'yes' }), /config\.verbose must be a boolean/)
  assert.throws(() => resolveConfig({ audit: 'yes' }), /config\.audit must be a boolean/)
  assert.throws(() => resolveConfig([]), /configuration must be an object/)
})

test('reviewed presets are de-duplicated', () => {
  assert.deepEqual(resolveConfig({ presets: ['a', 'b', 'a'] }).presets, ['a', 'b'])
})

/* -------------------------------------------------------------------------- */
/* verdict parsing                                                            */
/* -------------------------------------------------------------------------- */

test('verdict parsing accepts the documented protocol and unwraps one fenced block', () => {
  const allow = internals.parseVerdict('{"decision":"allow"}')
  assert.deepEqual(allow, { kind: 'verdict', verdict: 'allow', reason: '' })

  const denied = internals.parseVerdict('{"decision":"deny","reason":"目标是整个 C 盘"}')
  assert.deepEqual(denied, { kind: 'verdict', verdict: 'deny', reason: '目标是整个 C 盘' })

  // The shipped directive asks for a reason on BOTH verdicts, and the reason is
  // the reviewer's own sentence — never a fixed phrase.
  const explained = internals.parseVerdict('{"decision":"allow","reason":"删除 build/ 属于用户点名的清理范围"}')
  assert.deepEqual(explained, { kind: 'verdict', verdict: 'allow', reason: '删除 build/ 属于用户点名的清理范围' })

  const fenced = internals.parseVerdict('```json\n{"decision":"allow"}\n```')
  assert.equal(fenced.verdict, 'allow')

  const spaced = internals.parseVerdict('  \n\t{"decision":"DENY"}\n  ')
  assert.equal(spaced.verdict, 'deny', 'case is normalized, the protocol is not')
})

test('a reply that merely echoes the directive is never a grant', () => {
  // The directive contains the literal allow example. If the model echoes the
  // prompt, or its reply is cut short mid-echo, a substring match would read as
  // a grant; whole-reply JSON parsing must not.
  const echoed = `【危险反思 · 待确认操作】\n\n工具：pwsh\n\n严格只输出一个 JSON 对象：\n- 放行：{"decision":"allow"}`
  const parsed = internals.parseVerdict(echoed)
  assert.equal(parsed.kind, 'inconclusive')
  assert.match(parsed.note, /not one JSON object/)
})

test('a repeated JSON member cannot smuggle a second decision', () => {
  const smuggled = '{"decision":"deny","decision":"allow"}'
  assert.equal(internals.topLevelMemberCount(smuggled), 2, 'the guard sees both members')
  const parsed = internals.parseVerdict(smuggled)
  assert.equal(parsed.kind, 'inconclusive')
  assert.match(parsed.note, /repeats a JSON member/)
})

test('off-protocol reviewer output is inconclusive, never a grant', () => {
  const cases = [
    ['', /no content/],
    ['我不确定。', /not one JSON object/],
    ['{"decision":"maybe"}', /no allow\/deny decision/],
    ['{"decision":"allow","extra":1}', /does not match the decision protocol/],
    ['{"decision":"allow","reason":5}', /does not match the decision protocol/],
    ['["allow"]', /must be one JSON object/],
    ['null', /must be one JSON object/]
  ]
  for (const [text, pattern] of cases) {
    const parsed = internals.parseVerdict(text)
    assert.equal(parsed.kind, 'inconclusive', `${text} must not decide`)
    assert.match(parsed.note, pattern)
  }
})

test('a tool-calling or interrupted reviewer answer is inconclusive, never a grant', () => {
  const toolCall = verdictOf({ text: '', finish: { kind: 'tool-calls' }, requestedTool: true })
  assert.equal(toolCall.kind, 'inconclusive')
  assert.match(toolCall.note, /tried to call a tool/)

  const truncated = verdictOf({ text: '', finish: { kind: 'max-tokens' }, requestedTool: false })
  assert.equal(truncated.kind, 'inconclusive')
  assert.match(truncated.note, /truncated/)

  const failed = verdictOf({ text: '', finish: { kind: 'error', failure: { message: 'boom' } }, requestedTool: false })
  assert.equal(failed.kind, 'inconclusive')
  assert.match(failed.note, /boom/)

  const trailing = verdictOf({ text: '{"decision":"allow"}', finish: { kind: 'stop' }, requestedTool: false, trailing: true })
  assert.equal(trailing.kind, 'inconclusive')
  assert.match(trailing.note, /after its terminal finish/)
})

/* -------------------------------------------------------------------------- */
/* the decision, end to end                                                   */
/* -------------------------------------------------------------------------- */

test('a reviewer ALLOW becomes the approval grant', async () => {
  const { outcome, captured } = await runApproval({ reply: textReply('{"decision":"allow","reason":"与用户请求一致"}') })
  assert.equal(outcome, 'allowed-once')
  assert.equal(captured.calls, 1)
  assert.equal(captured.options.provider, 'stub-provider')
  assert.equal(captured.options.model, 'stub-model')
  assert.ok(captured.warnings.some((line) => /without human confirmation/.test(line)))
})

test('a reviewer DENY is final under the default policy', async () => {
  let delegated = false
  const { outcome } = await runApproval({
    reply: textReply('{"decision":"deny","reason":"目标是整个 C 盘，远超请求范围"}'),
    next: async () => {
      delegated = true
      return 'unavailable'
    }
  })
  assert.equal(outcome, 'rejected')
  assert.equal(delegated, false, 'a final denial must not reach the human answerer')
})

test('onDeny: ask routes the denial to the human instead', async () => {
  const { outcome } = await runApproval({
    reply: textReply('{"decision":"deny","reason":"范围过大"}'),
    config: { onDeny: 'ask' },
    next: async () => 'allowed-once'
  })
  assert.equal(outcome, 'allowed-once', 'the human answerer decided')
})

test('an inconclusive review hands the question back to the human by default', async () => {
  const { outcome, captured } = await runApproval({
    reply: textReply('我觉得应该没问题。'),
    next: async () => 'allowed-once'
  })
  assert.equal(outcome, 'allowed-once')
  assert.equal(captured.calls, 1, 'the reviewer was still consulted')
})

test('onFailure: unavailable closes without a decision, and never as a rejection', async () => {
  const { outcome, captured } = await runApproval({
    reply: textReply('没有给出结论'),
    config: { onFailure: 'unavailable' },
    next: async () => 'allowed-once'
  })
  // `unavailable` is what the caller renders as "no approval channel is
  // available". `rejected` would make it say "the user rejected escalating this
  // command" — a judgement nobody made.
  assert.equal(outcome, 'unavailable')
  assert.notEqual(outcome, 'rejected', 'a failure must never be reported as the user refusing')
  assert.ok(captured.steered[0].content[0].text.includes('审查没有作出判定'))
  assert.ok(!captured.steered[0].content[0].text.includes('被拒绝'))
  assert.ok(captured.warnings.some((line) => /closed unanswered rather than rejected/.test(line)))
})

test('onFailure no longer accepts "reject", and says why', () => {
  assert.throws(() => resolveConfig({ onFailure: 'reject' }), (error) => {
    assert.match(error.message, /cannot be "reject"/)
    assert.match(error.message, /not a rejection/)
    assert.match(error.message, /"unavailable"/)
    return true
  })
  // The verdict-side option is untouched: a denial IS a decision.
  assert.equal(resolveConfig({ onDeny: 'reject' }).onDeny, 'reject')
  assert.equal(resolveConfig({ onDeny: 'ask' }).onDeny, 'ask')
})

test('granting on failure is recorded as a grant without a decision', async () => {
  const { outcome, captured } = await runApproval({
    reply: [],
    config: { onFailure: 'allow' }
  })
  assert.equal(outcome, 'allowed-once')
  const text = captured.steered[0].content[0].text
  assert.match(text, /危险反思 · 未得出结论/, 'the heading never claims a verdict that was not reached')
  assert.ok(!text.includes('模型判定'), 'no decision is attributed to the reviewer')
  assert.ok(captured.warnings.some((line) => /with NO decision behind it/.test(line)))
})

test('the notice separates what the reviewer decided from what happened', async () => {
  // A denial that is passed to the human must not be headed as a rejection.
  const delegated = await runApproval({
    reply: textReply('{"decision":"deny","reason":"范围过大"}'),
    config: { onDeny: 'ask' },
    next: async () => 'allowed-once'
  })
  const delegatedText = delegated.captured.steered[0].content[0].text
  assert.match(delegatedText, /危险反思 · 模型判定：拒绝/, 'the verdict is reported as the reviewer’s')
  assert.match(delegatedText, /结果：本次提权已转交人工确认/, 'the outcome is reported as what happened')

  // A closed denial keeps both lines consistent.
  const closed = await runApproval({ reply: textReply('{"decision":"deny","reason":"范围过大"}') })
  const closedText = closed.captured.steered[0].content[0].text
  assert.match(closedText, /危险反思 · 模型判定：拒绝/)
  assert.match(closedText, /结果：本次提权未获放行，命令没有执行/)
  // And a grant says so plainly.
  const granted = await runApproval({ reply: textReply('{"decision":"allow","reason":"合规"}') })
  assert.match(granted.captured.steered[0].content[0].text, /危险反思 · 模型判定：放行/)
})

test('a throwing reviewer call follows onFailure', async () => {
  const { ctx, captured } = makeHost({ reply: [] })
  ctx.llm.stream = async function* () {
    throw new Error('provider exploded')
  }
  apply(ctx, { audit: false })
  const outcome = await captured.listener({ agent: { id: 's', session: makeSession(), options: {} }, toolName: 'pwsh' }, async () => 'unavailable')
  assert.equal(outcome, 'unavailable', 'onFailure=ask delegated')
  assert.ok(captured.infos.some((line) => /the reviewer call threw: provider exploded/.test(line)))
})

/* -------------------------------------------------------------------------- */
/* scoping                                                                    */
/* -------------------------------------------------------------------------- */

test('sessions on another preset are never reviewed', async () => {
  const { outcome, captured } = await runApproval({
    reply: textReply('{"decision":"allow"}'),
    hostOptions: { preset: 'workspace-write' },
    next: async () => 'unavailable'
  })
  assert.equal(captured.calls, 0, 'no model call for an unreviewed preset')
  assert.equal(outcome, 'unavailable', 'the human answerer kept the question')
})

test('an unreadable permission projection delegates rather than assuming', async () => {
  const { outcome, captured } = await runApproval({
    reply: textReply('{"decision":"allow"}'),
    hostOptions: { preset: 'danger-reflection', currentThrows: true }
  })
  assert.equal(captured.calls, 0)
  assert.equal(outcome, 'unavailable')
})

test('the listener is prepended so it precedes the client-contributed answerer', async () => {
  const { captured } = await runApproval({ reply: textReply('{"decision":"allow"}') })
  assert.deepEqual(captured.listenerOptions, { prepend: true })
})

test('a request with no resolvable session delegates', async () => {
  const { ctx, captured } = makeHost({ reply: textReply('{"decision":"allow"}') })
  apply(ctx, { audit: false })
  const outcome = await captured.listener({ agent: undefined, toolName: 'pwsh' }, async () => 'unavailable')
  assert.equal(outcome, 'unavailable')
  assert.equal(captured.calls, 0)
})

/* -------------------------------------------------------------------------- */
/* the in-conversation notice                                                 */
/* -------------------------------------------------------------------------- */

test('an allow posts the reviewer wording into the conversation', async () => {
  const reason = '用户要求清理构建产物，命令只删除 build/ 目录，没有触及源码。'
  const { outcome, captured } = await runApproval({
    reply: textReply(JSON.stringify({ decision: 'allow', reason }))
  })
  assert.equal(outcome, 'allowed-once')
  assert.equal(captured.steered.length, 1, 'exactly one notice per review')

  const message = captured.steered[0]
  assert.equal(message.role, 'user', 'a user-role message is what renders in the transcript')
  assert.equal(message.source.kind, 'danger-reflection', 'the notice is attributable and is not a human instruction')
  assert.equal(typeof message.id, 'string')
  assert.ok(Object.isFrozen(message), 'published messages are immutable')

  const text = message.content[0].text
  assert.match(text, /自动审查结果（非用户发言）/, 'the reader must not mistake it for something they typed')
  assert.match(text, /危险反思 · 模型判定：放行/)
  assert.ok(text.includes(`↳ ${reason}`), "the model's own wording is shown, unaltered")
  assert.match(text, /工具：pwsh/)
  assert.match(text, /提权理由：escalate sandbox to danger-full-access/)
  assert.match(text, /Remove-Item -Recurse -Force C:/, 'the command under review is shown')
  assert.match(text, /结果：本次提权已放行/)
})

test('a deny posts the refusal reason into the conversation', async () => {
  const { outcome, captured } = await runApproval({
    reply: textReply('{"decision":"deny","reason":"目标是整个 C 盘，远超用户请求范围"}')
  })
  assert.equal(outcome, 'rejected')
  const text = captured.steered[0].content[0].text
  assert.match(text, /危险反思 · 模型判定：拒绝/)
  assert.match(text, /目标是整个 C 盘，远超用户请求范围/)
  assert.match(text, /结果：本次提权未获放行，命令没有执行/)
})

test('an inconclusive review says so and reports where the question went', async () => {
  const { outcome, captured } = await runApproval({ reply: textReply('我觉得应该没问题。') })
  assert.equal(outcome, 'unavailable', 'delegated to the human')
  const text = captured.steered[0].content[0].text
  assert.match(text, /危险反思 · 未得出结论/)
  assert.ok(!text.includes('模型判定'), 'no verdict is claimed')
  assert.ok(!text.includes('被拒绝'), 'and it is certainly not called a rejection')
  assert.match(text, /没有给出有效判定/)
  assert.match(text, /结果：本次提权已转交人工确认/)
  assert.match(text, /不是 one JSON object|not one JSON object/)
})

test('a model reply without a reason is still reported, and says so', async () => {
  const { captured } = await runApproval({ reply: textReply('{"decision":"allow"}') })
  assert.match(captured.steered[0].content[0].text, /（模型没有给出理由）/)
})

test('announce: false keeps the review out of the conversation', async () => {
  const { outcome, captured } = await runApproval({
    reply: textReply('{"decision":"allow","reason":"合规"}'),
    config: { announce: false }
  })
  assert.equal(outcome, 'allowed-once')
  assert.equal(captured.steered.length, 0)
})

test('an agent without steer() still decides, and says why the notice is missing', async () => {
  const { outcome, captured } = await runApproval({
    reply: textReply('{"decision":"allow","reason":"合规"}'),
    agent: { id: 'session-test', session: makeSession(), options: {} }
  })
  assert.equal(outcome, 'allowed-once', 'a missing notice channel must not change the decision')
  assert.ok(captured.warnings.some((line) => /exposes no steer\(\)/.test(line)))
})

test('a throwing steer() must not change the decision', async () => {
  const { outcome, captured } = await runApproval({
    reply: textReply('{"decision":"allow","reason":"合规"}'),
    agent: {
      id: 'session-test',
      session: makeSession(),
      options: {},
      steer: () => {
        throw new Error('the inbox is closed')
      }
    }
  })
  assert.equal(outcome, 'allowed-once')
  assert.ok(captured.warnings.some((line) => /could not post the review notice/.test(line)))
})

test('the notice text is rendered from the decision alone', () => {
  const allow = internals.noticeText({
    decision: { kind: 'verdict', verdict: 'allow', reason: '合规' },
    action: 'allow',
    req: { toolName: 'pwsh', reason: 'escalate sandbox to danger-full-access: 清理构建产物' },
    toolCall: { arguments: '{"command":"rm -rf build"}' }
  })
  assert.match(allow, /^【危险反思 · 自动审查结果（非用户发言）】\n✅ 危险反思 · 模型判定：放行/)
  // The shape the reader sees: a labelled heading, the call, then the answer
  // behind a result arrow — a call/result pair in one message.
  assert.match(allow, /\n工具：pwsh\n/)
  assert.match(allow, /\n↳ 合规\n结果：/)

  const failedOpen = internals.noticeText({
    decision: { kind: 'inconclusive', note: 'the reviewer call failed: boom' },
    action: 'allow',
    req: { toolName: 'pwsh' },
    toolCall: undefined
  })
  assert.match(failedOpen, /危险反思 · 未得出结论/)
  assert.ok(!failedOpen.includes('模型判定'), 'a grant with no decision behind it claims no verdict')
  assert.match(failedOpen, /boom/)
  assert.match(failedOpen, /结果：本次提权已放行/)
})

test('the notice vocabulary keeps a failure out of the rejection register', () => {
  const failure = { kind: 'inconclusive', note: 'the reviewer call failed: provider unavailable' }
  const req = { toolName: 'pwsh' }
  for (const action of ['ask', 'unavailable', 'allow']) {
    const text = internals.noticeText({ decision: failure, action, req, toolCall: undefined })
    assert.ok(!text.includes('模型判定'), `action ${action} must not report a verdict`)
    assert.ok(!text.includes('被拒绝'), `action ${action} must not say the operation was rejected`)
    assert.ok(!text.includes('驳回'), `action ${action} must not use rejection wording`)
  }
  // Only a real denial may speak in the rejection register.
  const denied = internals.noticeText({
    decision: { kind: 'verdict', verdict: 'deny', reason: '范围过大' },
    action: 'reject',
    req,
    toolCall: undefined
  })
  assert.match(denied, /模型判定：拒绝/)
  assert.match(denied, /结果：本次提权未获放行/)
})

test('the notice quotes the reviewer verbatim and never wraps it in canned phrasing', () => {
  // The wording belongs to the reviewer. Nothing in this plugin may impose a
  // stock sentence, so two different reasons must produce two different notices
  // and neither may gain a phrase the reviewer did not write.
  const first = '只删除 build/ 与 dist/，两个目录都在用户点名的清理范围里。'
  const second = '复现用户报的构建失败需要写入工作区外的临时缓存目录。'
  const render = (reason) => internals.noticeText({
    decision: { kind: 'verdict', verdict: 'allow', reason },
    action: 'allow',
    req: { toolName: 'pwsh' },
    toolCall: undefined
  })

  for (const reason of [first, second]) {
    const text = render(reason)
    assert.ok(text.includes(`↳ ${reason}`), "the reviewer's own sentence appears unaltered")
    assert.ok(!text.includes('这个操作符合用户要求'), 'no stock phrasing is injected')
    assert.ok(!text.includes('符合用户'), 'no canned "matches the user" prefix is imposed')
  }
  assert.notEqual(render(first), render(second), 'the notice is derived from the reason, not from a template')
})

test('a reply that echoes the directive placeholder is inconclusive, not a grant', () => {
  const echoed = internals.parseVerdict('{"decision":"allow","reason":"<REASON>"}')
  assert.equal(echoed.kind, 'inconclusive')
  assert.match(echoed.note, /echoed the directive placeholder/)

  // Only a bare placeholder is suspect; a real reason merely containing angle
  // brackets is still a reason.
  const real = internals.parseVerdict('{"decision":"allow","reason":"删除 <workspace>/build，属于用户点名的清理范围"}')
  assert.equal(real.verdict, 'allow')
})

test('the directive states the shape but forbids restating it', () => {
  const prompt = internals.DEFAULT_REVIEW_PROMPT
  assert.match(prompt, /\{"decision":"allow","reason":"<REASON>"\}/, 'the shape is still shown, for reliable formatting')
  assert.match(prompt, /不要复述本提示里的任何文字/)
  assert.match(prompt, /不要套用固定句式/, 'the wording must vary with the operation')
  assert.match(prompt, /符合用户要求/, 'the directive names that phrasing as the kind of empty filler to avoid')
})

/* -------------------------------------------------------------------------- */
/* the replayed request                                                       */
/* -------------------------------------------------------------------------- */

test('the review replays the conversation and appends the pending action', async () => {
  const { captured } = await runApproval({ reply: textReply('{"decision":"allow"}') })
  const messages = captured.options.messages
  const roles = messages.map((message) => message.role)
  assert.deepEqual(roles.slice(0, 5), ['system', 'user', 'assistant', 'tool', 'assistant'], 'history order is preserved')

  const directive = messages[messages.length - 1]
  assert.equal(directive.role, 'user')
  const text = directive.content[0].text
  assert.match(text, /【危险反思 · 待确认操作】/)
  assert.match(text, /工具：pwsh/)
  assert.match(text, /escalate sandbox to danger-full-access/)
  assert.match(text, /Remove-Item -Recurse -Force C:/, 'the exact command is shown to the reviewer')
  assert.match(text, /"decision":"allow"/, 'the required output format is restated')
})

test('the review carries the routed tool envelope so the provider accepts the prefix', async () => {
  const { captured } = await runApproval({ reply: textReply('{"decision":"allow"}') })
  assert.equal(captured.options.sessionId, 'session-test')
  assert.deepEqual(captured.options.tools, [{ name: 'pwsh', description: 'run', parameters: {} }])
  assert.deepEqual(captured.options.toolHistory, { tools: [], updates: [] })
  assert.equal(captured.options.maxTokens, 2048)
  assert.equal(captured.options.temperature, 0, 'the reviewer samples deterministically by default')
})

test('an explicit verdict still decides when the call later hit a terminal failure', () => {
  // Deliberate divergence from the shipped Auto reviewer, which demands a clean
  // `stop`: a complete, well-formed verdict is self-contained, and reading it
  // only lets the gate reach the decision the model actually made.
  const decided = verdictOf({ text: '{"decision":"deny","reason":"范围过大"}', finish: { kind: 'max-tokens' }, requestedTool: false })
  assert.deepEqual(decided, { kind: 'verdict', verdict: 'deny', reason: '范围过大' })
})

test('the audit trail records the running build and every review', async () => {
  const home = await mkdtemp(join(tmpdir(), 'danger-reflection-'))
  try {
    const { ctx, captured } = makeHost({ reply: textReply('{"decision":"deny","reason":"范围过大"}'), home })
    apply(ctx, {}) // composition defaults: the trail is on
    await captured.listener(
      { agent: { id: 'session-test', session: makeSession(), options: {} }, toolName: 'pwsh', callId: 'call-2', reason: 'escalate sandbox to danger-full-access: 需要删除整个目录' },
      async () => 'unavailable'
    )

    const file = join(home, 'danger-reflection', 'audit.jsonl')
    // The load record is written asynchronously; give it a turn to land.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const records = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))

    const loaded = records.find((record) => record.kind === 'loaded')
    assert.ok(loaded !== undefined, 'the load record ties decisions to a build')
    // The recorded hash must match the module actually under test, which is what
    // makes a decision attributable to an exact revision of the source.
    const source = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
    assert.equal(loaded.sourceHash, createHash('sha256').update(source).digest('hex').slice(0, 16))
    assert.deepEqual(loaded.presets, ['danger-reflection'])
    assert.equal(loaded.temperature, 0)

    const review = records.find((record) => record.kind === 'review')
    assert.equal(review.toolName, 'pwsh')
    assert.equal(review.toolArguments, '{"command":"Remove-Item -Recurse -Force C:\\\\"}', 'the audited command is the exact logged argument')
    assert.equal(review.verdict, 'deny')
    assert.equal(review.decided, true, 'a verdict is a decision, and the record says so')
    assert.equal(review.action, 'reject')
    assert.equal(review.outcome, 'rejected')

    // And a failure is recorded as the ABSENCE of a decision, never as one.
    const failing = makeHost({ reply: textReply('没有给出结论'), home })
    apply(failing.ctx, {})
    const failedOutcome = await failing.captured.listener(
      { agent: { id: 'session-test', session: makeSession(), options: {} }, toolName: 'pwsh', callId: 'call-2' },
      async () => 'unavailable'
    )
    assert.equal(failedOutcome, 'unavailable', 'delegated to the human by default')
    await new Promise((resolve) => setTimeout(resolve, 50))
    const afterFailure = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const failure = afterFailure.filter((record) => record.kind === 'review').at(-1)
    assert.equal(failure.verdict, null)
    assert.equal(failure.decided, false, 'no decision is recorded as no decision')
    assert.notEqual(failure.action, 'reject', 'a failure is never filed as a rejection')
    assert.notEqual(failure.outcome, 'rejected')
    assert.match(failure.detail, /not one JSON object|no VERDICT|truncated|failed/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('audit: false leaves no trail at all', async () => {
  const home = await mkdtemp(join(tmpdir(), 'danger-reflection-'))
  try {
    const { ctx, captured } = makeHost({ reply: textReply('{"decision":"allow"}'), home })
    apply(ctx, { audit: false })
    await captured.listener(
      { agent: { id: 'session-test', session: makeSession(), options: {} }, toolName: 'pwsh', callId: 'call-2' },
      async () => 'unavailable'
    )
    await assert.rejects(readFile(join(home, 'danger-reflection', 'audit.jsonl'), 'utf8'), { code: 'ENOENT' })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('attachments are replaced instead of re-uploaded', () => {
  const { stripAttachments } = internals
  const stripped = stripAttachments([
    { type: 'image', attachment: { attachmentId: 'a' } },
    { type: 'file', attachment: { name: 'big.pdf' } },
    { type: 'text', text: 'keep me' }
  ])
  assert.equal(stripped[0].type, 'text')
  assert.match(stripped[0].text, /image omitted/)
  assert.match(stripped[1].text, /big\.pdf/)
  assert.deepEqual(stripped[2], { type: 'text', text: 'keep me' })
})

test('context truncation keeps the newest messages and a valid request shape', () => {
  const session = makeSession()
  const messages = internals.buildContext(session, { maxContextChars: 120 })
  assert.ok(messages.length > 0)
  assert.notEqual(messages[0].role, 'tool', 'a tool result never leads the replayed slice')
  // This assertion used to read `type === 'tool-call'` — "the pending call
  // survives truncation" — which encoded the very defect that broke the review
  // on a validating provider. The pending call must NOT survive as an open call:
  // it has no result, and a request carrying an unmatched call is rejected
  // before it is ever sent.
  const last = messages[messages.length - 1]
  assert.equal(last.content[0].type, 'text', 'the pending call is re-stated, never left open')
  assert.match(last.content[0].text, /尚未执行/)
  assert.equal(deepseekWireCheck(messages.concat([{ role: 'user', content: [{ type: 'text', text: 'directive' }] }])), null)
})

/* -------------------------------------------------------------------------- */
/* wire legality of the replayed request                                      */
/* -------------------------------------------------------------------------- */

test('the guard this protects against is real: an unresolved call breaks the request', () => {
  // The pre-fix shape: the pending call replayed verbatim, then the directive.
  const broken = realisticHistory().concat([
    { role: 'user', content: [{ type: 'text', text: '【危险反思 · 待确认操作】' }] }
  ])
  assert.equal(deepseekWireCheck(broken), 'tool calls need immediate results',
    'this is the exact rejection observed in production, so the assertions below have teeth')
})

test('the replayed request is accepted by a validating provider', async () => {
  const { captured } = await runApproval({
    reply: textReply('{"decision":"allow","reason":"清理的是本次会话自己生成的缓存目录"}'),
    session: makeSession({ deriveMessages: () => realisticHistory() })
  })
  const messages = captured.options.messages
  assert.equal(deepseekWireCheck(messages), null, 'every tool call in the request is answered')
  assert.equal(messages[messages.length - 1].role, 'user', 'the reviewer directive is last')
  assert.equal(messages[messages.length - 1].content[0].text.includes('【危险反思 · 待确认操作】'), true)
})

test('a history that closes its pairs is replayed with the calls intact', () => {
  const messages = internals.buildContext(
    makeSession({ deriveMessages: () => realisticHistory().slice(0, 4) }),
    { maxContextChars: 400000 }
  )
  const calls = messages.flatMap((message) => (message.content ?? []).filter((block) => block.type === 'tool-call'))
  assert.equal(calls.length, 1, 'the resolved call stays a real tool call, so the replay stays a true prefix')
  assert.equal(calls[0].id, 'call-1')
})

test('only the unanswered call is re-stated, and it is re-stated honestly', () => {
  const messages = internals.closePendingCalls([
    { role: 'assistant', content: [
      { type: 'tool-call', id: 'answered', name: 'pwsh', arguments: '{"command":"ls"}' },
      { type: 'tool-call', id: 'pending', name: 'pwsh', arguments: '{"command":"node .dsh-fix/clear-stale-cache.mjs"}' }
    ] },
    { role: 'tool', toolCallId: 'answered', content: [{ type: 'text', text: 'ok' }] }
  ])

  const [assistant] = messages
  assert.equal(assistant.content[0].type, 'tool-call', 'the answered call is untouched')
  assert.equal(assistant.content[0].id, 'answered')
  assert.equal(assistant.content[1].type, 'text', 'the unanswered call becomes text')
  assert.match(assistant.content[1].text, /工具调用 pwsh 尚未执行/)
  assert.match(assistant.content[1].text, /clear-stale-cache\.mjs/, 'the reviewer still sees the exact command')
  assert.match(assistant.content[1].text, /这就是本次待审查的操作/)
  assert.equal(assistant.role, 'assistant', 'the turn keeps its role, so the replay reads naturally')
  assert.equal(deepseekWireCheck(messages), null, 'with its result still attached, the slice is legal on its own')
})

test('a fully answered history is returned untouched', () => {
  const balanced = [
    { role: 'assistant', content: [{ type: 'tool-call', id: 'a', name: 'pwsh', arguments: '{}' }] },
    { role: 'tool', toolCallId: 'a', content: [{ type: 'text', text: 'ok' }] }
  ]
  const messages = internals.closePendingCalls(balanced)
  assert.equal(messages[0].content[0].type, 'tool-call')
  assert.equal(messages[0], balanced[0], 'an unaffected message keeps its identity, so nothing is copied needlessly')
})

test('a tool result is never orphaned, and a call never loses its result', () => {
  const messages = internals.closePendingCalls(realisticHistory())
  assert.equal(deepseekWireCheck(messages.concat([{ role: 'user', content: [{ type: 'text', text: 'directive' }] }])), null)
  // The resolved pair is still exactly a pair.
  assert.equal(messages[2].content[0].type, 'tool-call')
  assert.equal(messages[3].role, 'tool')
  assert.equal(messages[3].toolCallId, 'call-1')
})

/* -------------------------------------------------------------------------- */
/* the structured verdict: source, projection, chip                           */
/* -------------------------------------------------------------------------- */

/** Register the verdict projection against a stub registry. */
function projectionHarness() {
  const registered = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    get: (key) => (key === 'sessionProjections' ? {
      register: (definition) => {
        registered.push(definition)
        return () => {}
      }
    } : undefined),
    effect: (fn) => {
      fn()
      return () => {}
    }
  }
  const ok = internals.registerVerdictProjection(ctx, ctx.logger)
  return { ok, definition: registered[0] }
}

/** One committed `user/message` carrying this plugin's source. */
function noticeEvent(source, time = 42) {
  return { type: 'user/message', time, data: { id: `m-${time}`, role: 'user', content: [{ type: 'text', text: '…' }], source } }
}

test('the notice carries its verdict structurally, so the log drives the chip', async () => {
  const { captured } = await runApproval({ reply: textReply('{"decision":"allow","reason":"只删 build/"}') })
  const source = captured.steered[0].source
  assert.equal(source.kind, internals.SOURCE_KIND)
  assert.equal(source.verdict, 'allow')
  assert.equal(source.action, 'allow')
  assert.equal(source.toolName, 'pwsh')
  assert.equal(source.detail, '只删 build/')
})

test('a failure carries no verdict on the source either', async () => {
  const { captured } = await runApproval({ reply: textReply('我不确定'), config: { onFailure: 'unavailable' } })
  const source = captured.steered[0].source
  assert.equal(source.verdict, null, 'no decision is recorded as no decision')
  assert.equal(source.action, 'unavailable')
  assert.notEqual(source.action, 'reject')
})

test('the projection folds this plugin’s notices and ignores everything else', () => {
  const { ok, definition } = projectionHarness()
  assert.equal(ok, true, 'a deployment with the registry gets the chip')
  const empty = definition.init()

  // Unrelated events must return the SAME reference: the registry's change gate
  // is an Object.is check, so a fresh object here would wake every client.
  assert.equal(definition.apply(empty, noticeEvent({ kind: 'user' }, 1)), empty, 'a human message is not a review')
  assert.equal(definition.apply(empty, { type: 'assistant/message', time: 2, data: {} }), empty)
  assert.equal(definition.apply(empty, { type: 'approval/decided', time: 3, data: { id: 'a', outcome: 'rejected' } }), empty)

  const denied = definition.apply(empty, noticeEvent({
    kind: internals.SOURCE_KIND, verdict: 'deny', action: 'reject', detail: '范围过大', toolName: 'pwsh'
  }))
  assert.deepEqual(denied, { verdict: 'deny', action: 'reject', detail: '范围过大', toolName: 'pwsh', at: 42 })

  const failed = definition.apply(empty, noticeEvent({
    kind: internals.SOURCE_KIND, verdict: null, action: 'unavailable', detail: 'provider exploded', toolName: 'pwsh'
  }, 7))
  assert.equal(failed.verdict, null)
  assert.equal(failed.action, 'unavailable')
  assert.notEqual(failed.action, 'reject', 'the projection keeps a failure out of the rejection register too')
})

test('the projection survives a malformed source without inventing a verdict', () => {
  const { definition } = projectionHarness()
  const empty = definition.init()
  const junk = definition.apply(empty, noticeEvent({ kind: internals.SOURCE_KIND, verdict: 'maybe', action: 7 }))
  assert.equal(junk.verdict, null, 'an unknown verdict is no verdict')
  assert.equal(junk.action, '', 'a non-string action is dropped rather than trusted')
  assert.equal(junk.toolName, null)
})

test('the projection schema validates rather than passing through', () => {
  assert.equal(internals.VERDICT_SCHEMA.parse(internals.EMPTY_VERDICT), internals.EMPTY_VERDICT)
  const rejected = [
    null,
    [],
    'allow',
    { verdict: 'maybe', action: '', detail: '', toolName: null, at: 0 },
    { verdict: null, action: 7, detail: '', toolName: null, at: 0 },
    { verdict: null, action: '', detail: null, toolName: null, at: 0 },
    { verdict: null, action: '', detail: '', toolName: 5, at: 0 },
    { verdict: null, action: '', detail: '', toolName: null, at: 'now' },
    { verdict: null, action: '', detail: '', toolName: null }
  ]
  for (const value of rejected) {
    assert.throws(() => internals.VERDICT_SCHEMA.parse(value), TypeError, `must reject ${JSON.stringify(value)}`)
  }
})

test('a deployment without the projection registry loses only the chip', () => {
  const ctx = { logger: { info: () => {} }, get: () => undefined, effect: () => () => {} }
  assert.equal(internals.registerVerdictProjection(ctx, ctx.logger), false, 'an absent registry is not an error')
})

test('a refusing projection registry loses only the chip, never the reviewer', () => {
  const warnings = []
  const ctx = {
    logger: { info: () => {}, warn: (line) => warnings.push(line) },
    get: () => ({
      register: () => {
        throw new Error('key "dangerReflection" is not declared')
      }
    }),
    effect: (fn) => {
      fn()
      return () => {}
    }
  }
  assert.equal(internals.registerVerdictProjection(ctx, ctx.logger), false)
  assert.ok(warnings.some((line) => /composer chip stays absent/.test(line)))
  assert.ok(warnings.some((line) => /is not declared/.test(line)))
})