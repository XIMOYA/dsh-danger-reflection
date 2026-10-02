/**
 * 危险反思 — browser half.
 *
 * Why this file exists at all: the shipped permission selector maps a glyph to
 * a preset *value* through a module-local, closed table — `read-only`,
 * `workspace-write`, `danger-full-access` — and returns nothing for anything
 * else, so a host-configured preset renders with no icon element at all (its
 * label also shifts left). There is no icon registry in the Client service
 * directory, and the icon package exports no fourth permission glyph, so the
 * only way to give 危险反思 a matching glyph is to seat a component of our own.
 *
 * How it seats: `conversation.input.permission` is a `single` slot, and a second
 * registration at the SAME priority throws while a different priority is
 * accepted — "register at a different priority to shadow it (lowest renders)".
 * The shipped occupant sits at priority 0, so this one registers at
 * `priority: -10` and renders in its place. That is a deliberate, supported
 * replacement (`replaceRisk: "shadows-shipped-ui"`), and it is the trade this
 * feature accepts: the composer-bar permission control is now maintained here,
 * so it must be kept faithful to the shipped control.
 *
 * What that faithfulness means concretely: the catalog reader, the label rules,
 * the risk-confirmation gate, the CSS, and the trigger/menu structure below are
 * a port of `@deepseek-ai/dsh-client-ui-permission-presets`. The only intended
 * differences are the fourth glyph and the fact that all copy lives in this
 * plugin's own locale namespace instead of borrowing the shipped one.
 *
 * No `dsh.client.external` beyond the icon package: React is part of the frozen
 * platform module table, and the catalog's snapshot source is hand-rolled here
 * rather than imported, so nothing else has to be resolved at runtime.
 */

/** Slot this component shadows. */
const SLOT = 'conversation.input.permission'

/** Locale namespace owned by this plugin. */
const PERMISSION_ACCESS_NS = 'danger-reflection.permission'

/** Machine value of the preset that requires an explicit GUI risk gate. */
const FULL_ACCESS_PRESET = 'danger-full-access'

/** Machine value of the experimental per-call review preset, when its bundle is live. */
const AUTO_PRESET = 'auto'

window.__ModuleLoader__.load({
  id: 'dsh-danger-reflection',
  factory: (require) => {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const {
      Menu,
      RiskConfirmation,
      IconChevronDownOutlineRegular,
      PermissionIconReadOnlyRegular,
      PermissionIconWorkspaceWriteRegular,
      PermissionIconFullAccessRegular
    } = primitives

    /* ---------------------------------------------------------------------- */
    /* the glyph                                                              */
    /* ---------------------------------------------------------------------- */

    /**
     * The 危险反思 glyph: the permission shield with a watchful eye inside it.
     *
     * The shield outline is the exact path the read-only glyph uses, so this
     * sits in the same visual family rather than beside it, and the eye is two
     * symmetric arcs plus a pupil — the smallest shape that reads as "something
     * is checking this" at 16px.
     */
    function DangerReflectionGlyph({ size = 16, className, strokeWidth = 1 }) {
      return h('svg', {
        width: size,
        height: size,
        className,
        viewBox: '0 0 16 16',
        fill: 'none',
        xmlns: 'http://www.w3.org/2000/svg',
        'aria-hidden': 'true',
        strokeWidth
      },
      h('path', {
        d: 'M6.59624 2.14853C7.50155 1.80917 8.49914 1.80919 9.40444 2.14859L13.9245 3.84317V7.11961C13.9245 11.6089 10.5565 13.5975 8.00035 14.5779C5.44423 13.5975 2.07544 11.6089 2.07544 7.11961V3.84317L6.59624 2.14853Z',
        stroke: 'currentColor',
        strokeLinejoin: 'round'
      }),
      h('path', {
        d: 'M5 7.7Q8 4.9 11 7.7Q8 10.5 5 7.7Z',
        stroke: 'currentColor',
        strokeLinejoin: 'round'
      }),
      h('circle', {
        cx: 8,
        cy: 7.7,
        r: 0.95,
        stroke: 'currentColor'
      }))
    }

    /** Preset value → rendered glyph. The three shipped values, plus ours. */
    const permissionGlyphs = new Map([
      ['read-only', h(PermissionIconReadOnlyRegular, {})],
      ['workspace-write', h(PermissionIconWorkspaceWriteRegular, {})],
      [FULL_ACCESS_PRESET, h(PermissionIconFullAccessRegular, {})],
      ['danger-reflection', h(DangerReflectionGlyph, {})]
    ])

    /** Glyph for a permission option value; host-configured names outside this set get none. */
    function permissionGlyph(value) {
      return permissionGlyphs.get(value)
    }

    /* ---------------------------------------------------------------------- */
    /* copy                                                                   */
    /* ---------------------------------------------------------------------- */

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'mode': '访问模式，当前：{name}',
      'close': '关闭',
      'preset.readOnly': '仅可查看',
      'preset.workspaceWrite': '工作区内修改',
      'preset.fullAccess': '完全权限',
      'confirm.title': '确认启用完全权限？',
      'confirm.description': '启用完全权限后，智能体将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任当前任务时使用。',
      'confirm.acknowledge': '我已了解风险，并愿意继续',
      'confirm.cancel': '取消',
      'confirm.enable': '启用完全权限',
      'auto.label': 'Auto review',
      'auto.badge': 'EXP',
      'auto.description': '无沙箱运行；每次原生工具调用和 PTC 内层调用前由同一模型进行实验性审查。',
      'auto.confirm.title': '确认启用 Auto review（实验）？',
      'auto.confirm.description': 'Auto review 不使用沙箱。每次原生工具调用和 PTC 内层调用前，都会由与当前 agent 相同的模型进行审查；审查拒绝的调用由你批准或拒绝。此功能仍属实验性，可能误放行或误拒绝，并会消耗额外 token。',
      'auto.confirm.acknowledge': '我已了解这些风险，并愿意继续',
      'auto.confirm.enable': '启用 Auto review',
      'chip.allow': '✅ 危险反思 · 已放行',
      'chip.deny': '🛑 危险反思 · 已拒绝',
      'chip.undecided': '⚠️ 危险反思 · 未得出结论',
      'chip.noDecision': '（审查没有作出判定）'
    }

    /** English dictionary, kept complete against the zh key set. */
    const en = {
      'mode': 'Access mode, current: {name}',
      'close': 'Close',
      'preset.readOnly': 'Read Only',
      'preset.workspaceWrite': 'Workspace Write',
      'preset.fullAccess': 'Full access',
      'confirm.title': 'Enable Full access?',
      'confirm.description': 'Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.',
      'confirm.acknowledge': 'I understand the risks and want to continue',
      'confirm.cancel': 'Cancel',
      'confirm.enable': 'Enable Full access',
      'auto.label': 'Auto review',
      'auto.badge': 'EXP',
      'auto.description': 'Run without a sandbox after an experimental same-model review of every native tool call and PTC inner call.',
      'auto.confirm.title': 'Enable Auto review (experimental)?',
      'auto.confirm.description': 'Auto review runs without a sandbox. Before every native tool call and PTC inner call, the same model as the current agent reviews whether to allow it; you approve or reject each call it denies. This feature is experimental, can falsely allow or deny actions, and uses additional tokens.',
      'auto.confirm.acknowledge': 'I understand these risks and want to continue',
      'auto.confirm.enable': 'Enable Auto review',
      'chip.allow': '✅ Danger Reflection · allowed',
      'chip.deny': '🛑 Danger Reflection · denied',
      'chip.undecided': '⚠️ Danger Reflection · no verdict',
      'chip.noDecision': '(the review reached no decision)'
    }

    /* ---------------------------------------------------------------------- */
    /* presentation                                                           */
    /* ---------------------------------------------------------------------- */

    const PRESET_LABEL_KEYS = new Map([
      ['read-only', 'preset.readOnly'],
      ['workspace-write', 'preset.workspaceWrite'],
      [FULL_ACCESS_PRESET, 'preset.fullAccess']
    ])

    const DEFAULT_PRESET_LABELS = {
      'preset.readOnly': en['preset.readOnly'],
      'preset.workspaceWrite': en['preset.workspaceWrite'],
      'preset.fullAccess': en['preset.fullAccess']
    }

    /** Convert conventional kebab-case preset names into user-facing title case. */
    function displayPresetName(name) {
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
      return name.split('-').map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
    }

    /**
     * Render a permission preset under its product label.
     *
     * A host-supplied label wins: only the three shipped values are recognized
     * by the label table, so 危险反思 renders the name the Host sent (which is
     * why the preset's `name` matters and why no locale key is needed here).
     */
    function displayPermissionPreset(value, name, t) {
      const key = PRESET_LABEL_KEYS.get(value)
      if (key !== void 0 && (name === value || name === DEFAULT_PRESET_LABELS[key])) return t?.(key) ?? DEFAULT_PRESET_LABELS[key]
      return displayPresetName(name)
    }

    function permissionLabel(value, name, t) {
      if (value === AUTO_PRESET) return t('auto.label')
      return displayPermissionPreset(value, name, (key) => t(key))
    }

    function optionBadge(value, t) {
      return value === AUTO_PRESET ? t('auto.badge') : undefined
    }

    /** Resolve locale-owned copy for the shipped Auto option; preserve host copy for other presets. */
    function optionDescription(option, t) {
      return option.value === AUTO_PRESET ? t('auto.description') : option.description
    }

    /* ---------------------------------------------------------------------- */
    /* catalog                                                                */
    /* ---------------------------------------------------------------------- */

    /**
     * A bare snapshot source: `getSnapshot` plus `subscribe`.
     *
     * The renderer turns exactly this shape into a selector hook through a
     * `useSyncExternalStore` adapter, so the shape is the contract — and because
     * it is this small, it is written here rather than imported.
     */
    function createSnapshotStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        set(next) {
          value = next
          for (const listener of [...listeners]) listener()
        }
      }
    }

    /** One latest-result-wins catalog reader for the whole browser process. */
    class PermissionCatalogDirectory {
      /** Complete snapshot consumed by the composer seat. */
      store = createSnapshotStore({ value: null })
      /**
       * One tick per invalidation (a catalog notification or a connection-generation
       * change), published before the replacement read starts. Kept because the
       * shipped surface publishes it and a future consumer may subscribe.
       */
      invalidations = createSnapshotStore({ count: 0 })
      initialized = false
      epoch = 0
      pending
      failure = new Error('permission catalog has no complete value')
      disposed = false

      /** Subscribe to both invalidation sources before the first read, closing the install/read race. */
      constructor(ctx) {
        this.ctx = ctx
        this.connection = ctx.get('connection')
        this.stopCatalog = ctx.remote.$on('permission-presets/catalog-changed', () => {
          this.invalidate()
          this.refresh()
        })
        this.stopGeneration = this.connection.generation.subscribe(() => {
          this.syncGeneration()
        })
        this.syncGeneration()
      }

      /** Publish one invalidation tick for consumers holding displayed options. */
      invalidate() {
        this.invalidations.set({ count: this.invalidations.getSnapshot().count + 1 })
      }

      /** Force a fresh complete read for the active connection generation. */
      refresh() {
        if (this.disposed) return
        const generationId = this.connection.generation.getSnapshot()?.id
        if (generationId === undefined) return
        if (generationId !== this.generationId) {
          this.syncGeneration()
          return
        }
        this.startRead(generationId)
      }

      /** Stop subscriptions and revoke every late settlement's write access. */
      dispose() {
        if (this.disposed) return
        this.disposed = true
        ++this.epoch
        this.pending = undefined
        this.stopGeneration()
        this.stopCatalog()
      }

      /** Observe generation loss/replacement and hard-clear the old Host value. */
      syncGeneration() {
        if (this.disposed) return
        const generationId = this.connection.generation.getSnapshot()?.id
        if (this.initialized && generationId === this.generationId) return
        if (this.initialized) this.invalidate()
        this.initialized = true
        this.generationId = generationId
        ++this.epoch
        this.pending = undefined
        this.failure = new Error('permission catalog has no complete value')
        this.store.set({ value: null })
        if (generationId !== undefined) this.startRead(generationId)
      }

      /** Start one independent read; the newest epoch in the same generation wins. */
      startRead(generationId) {
        const epoch = ++this.epoch
        this.failure = new Error('permission catalog has no complete value')
        const operation = this.ctx.remote.permissionPresets.catalog().then((result) => {
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
          if (!this.accepts(epoch, generationId)) return
          this.store.set({ value: result.value })
        }).catch((error) => {
          if (!this.accepts(epoch, generationId)) return
          this.failure = error instanceof Error ? error : new Error(String(error))
          this.store.set({ value: null })
        }).finally(() => {
          if (this.pending === operation) this.pending = undefined
        })
        this.pending = operation
      }

      /** Fence by disposal, refresh epoch, and the actual Connection generation. */
      accepts(epoch, generationId) {
        return !this.disposed && epoch === this.epoch && generationId === this.generationId && this.connection.generation.getSnapshot()?.id === generationId
      }
    }

    /* ---------------------------------------------------------------------- */
    /* styles                                                                 */
    /* ---------------------------------------------------------------------- */

    /**
     * The shipped selector's rules, under this plugin's own class names and its
     * own style tag, so the control stays pixel-identical without depending on
     * another plugin's injected CSS staying mounted.
     */
    const CSS = [
      '.drPermission_trigger{border-radius:var(--dsw-radius-sm);min-width:0;max-width:220px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}',
      '.drPermission_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.drPermission_trigger:focus-visible{box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.drPermission_trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}',
      '.drPermission_triggerIcon{flex:none;display:inline-flex}',
      '.drPermission_triggerLabel{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      '.drPermission_optionLabel{align-items:baseline;gap:4px;min-width:0;max-width:100%;display:inline-flex}',
      '.drPermission_optionLabelText{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      '.drPermission_badge{color:var(--dsw-alias-label-tertiary);letter-spacing:.2px;flex:none;align-self:flex-start;margin-top:-1px;font-size:8px;font-weight:600;line-height:10px}',
      '.drPermission_chevron{color:var(--dsw-alias-label-caption);flex:none;transition:transform .12s;display:inline-flex}',
      '.drPermission_chevronOpen{transform:rotate(180deg)}',
      '.drReflection_chip{align-items:center;gap:6px;padding:2px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;display:inline-flex;max-width:100%;min-width:0}',
      '.drReflection_chipTool{color:var(--dsw-alias-label-caption);text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      '.drReflection_chipNote{color:var(--dsw-alias-label-tertiary)}',
      '@container (width<=460px){.drPermission_trigger:has(.drPermission_triggerIcon) .drPermission_triggerLabel{display:none}}'
    ].join('')

    const CSS_TAG_ID = 'dsh-danger-reflection/DangerReflectionPermission.css'

    /** Install the stylesheet once per document. */
    function installStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-danger-reflection'
      tag.dataset.pluginCss = CSS_TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    const css = {
      trigger: 'drPermission_trigger',
      triggerIcon: 'drPermission_triggerIcon',
      triggerLabel: 'drPermission_triggerLabel',
      optionLabel: 'drPermission_optionLabel',
      optionLabelText: 'drPermission_optionLabelText',
      badge: 'drPermission_badge',
      chevron: 'drPermission_chevron',
      chevronOpen: 'drPermission_chevronOpen',
      chip: 'drReflection_chip',
      chipTool: 'drReflection_chipTool',
      chipNote: 'drReflection_chipNote'
    }

    /* ---------------------------------------------------------------------- */
    /* the ambient verdict chip                                               */
    /* ---------------------------------------------------------------------- */

    /** Projection key published by this plugin's host half. */
    const VERDICT_PROJECTION = 'dangerReflection'

    /**
     * The latest 危险反思 verdict for this session, as an ambient row under the
     * composer.
     *
     * It reads the host's `dangerReflection` projection, which the host folds
     * from the committed log, so this component needs no plumbing of its own —
     * and it renders NOTHING when the capability is absent (an older host, a
     * deployment without the projection registry, or a session that has never
     * been reviewed).
     *
     * The wording follows the same rule as the conversation notice: the chip
     * reports what the reviewer DECIDED, and never dresses a missing decision up
     * as a rejection.
     */
    function DangerReflectionChip({ useProjection, t }) {
      const state = useProjection(VERDICT_PROJECTION)
      if (state === undefined || state === null) return null
      if (state.verdict === null && state.action === '') return null

      const text = typeof t === 'function' ? t : (_key, fallback) => fallback
      const undecided = state.verdict === null
      const heading = undecided
        ? text('chip.undecided', '⚠️ 危险反思 · 未得出结论')
        : state.verdict === 'allow'
          ? text('chip.allow', '✅ 危险反思 · 已放行')
          : text('chip.deny', '🛑 危险反思 · 已拒绝')
      const tool = typeof state.toolName === 'string' && state.toolName !== '' ? state.toolName : null

      return h('div', {
        className: css.chip,
        role: 'status',
        title: typeof state.detail === 'string' && state.detail !== '' ? state.detail : undefined
      },
      h('span', { className: css.optionLabelText }, heading),
      tool !== null && h('span', { className: css.chipTool }, tool),
      undecided && h('span', { className: css.chipNote }, text('chip.noDecision', '（审查没有作出判定）')))
    }

    /* ---------------------------------------------------------------------- */
    /* the control                                                            */
    /* ---------------------------------------------------------------------- */

    function PermissionSelect({ locked, select, usePermissionCatalog, useProjection, t }) {
      const selection = useProjection('permissions')
      const catalog = usePermissionCatalog((state) => state.value)
      const [pick, setPick] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [confirmation, setConfirmation] = React.useState(null)
      const [acknowledged, setAcknowledged] = React.useState(false)

      React.useEffect(() => {
        if (!locked && selection !== undefined && catalog !== null && (confirmation === null || catalog.options.some((option) => option.value === confirmation))) return
        setOpen(false)
        setAcknowledged(false)
        setConfirmation(null)
      }, [catalog, confirmation, locked, selection])

      if (selection === undefined || catalog === null) return null

      const currentValue = pick !== null && catalog.options.some((option) => option.value === pick) ? pick : selection.currentValue
      const current = catalog.options.find((option) => option.value === currentValue)
      const currentLabel = current === undefined ? permissionLabel(currentValue, currentValue, t) : permissionLabel(current.value, current.name, t)
      const busy = pick !== null || confirmation !== null

      const items = catalog.options.map((option) => {
        const icon = permissionGlyph(option.value)
        const label = permissionLabel(option.value, option.name, t)
        const badge = optionBadge(option.value, t)
        return {
          id: option.value,
          label: badge === undefined ? label : h('span', {
            className: css.optionLabel,
            'aria-label': `${label} ${badge}`
          },
          h('span', { className: css.optionLabelText }, label),
          h('sup', { className: css.badge }, badge)),
          ...icon === undefined ? {} : { icon }
        }
      })

      const submit = (id) => {
        setPick(id)
        select(id).catch(() => false).then(() => {
          setPick(null)
        })
      }

      const choose = (id) => {
        setOpen(false)
        if (id === selection.currentValue) return
        if (id === FULL_ACCESS_PRESET || id === AUTO_PRESET) {
          setAcknowledged(false)
          setConfirmation(id)
          return
        }
        submit(id)
      }

      const closeConfirmation = () => {
        setAcknowledged(false)
        setConfirmation(null)
      }

      const currentGlyph = permissionGlyph(currentValue)
      const currentBadge = optionBadge(currentValue, t)
      const currentAccessibleLabel = currentBadge === undefined ? currentLabel : `${currentLabel} ${currentBadge}`

      const anchor = h('button', {
        type: 'button',
        className: css.trigger,
        'aria-label': t('mode', { name: currentAccessibleLabel }),
        title: current === undefined ? undefined : optionDescription(current, t),
        disabled: locked || busy,
        onClick: () => {
          setOpen(!open)
        }
      },
      currentGlyph !== undefined && h('span', {
        className: css.triggerIcon,
        'aria-hidden': true
      }, currentGlyph),
      h('span', { className: css.triggerLabel }, currentLabel),
      currentBadge !== undefined && h('sup', { className: css.badge }, currentBadge),
      h('span', {
        className: open ? `${css.chevron} ${css.chevronOpen}` : css.chevron,
        'aria-hidden': true
      }, h(IconChevronDownOutlineRegular, {})))

      return h(React.Fragment, null,
        h(Menu, {
          open,
          items,
          selectedId: currentValue,
          onSelect: choose,
          onClose: () => {
            setOpen(false)
          },
          side: 'top',
          portal: true,
          anchor
        }),
        confirmation !== null && h(RiskConfirmation, {
          open: true,
          title: confirmation === AUTO_PRESET ? t('auto.confirm.title') : t('confirm.title'),
          description: confirmation === AUTO_PRESET ? t('auto.confirm.description') : t('confirm.description'),
          acknowledgeLabel: confirmation === AUTO_PRESET ? t('auto.confirm.acknowledge') : t('confirm.acknowledge'),
          cancelLabel: t('confirm.cancel'),
          closeLabel: t('close'),
          confirmLabel: confirmation === AUTO_PRESET ? t('auto.confirm.enable') : t('confirm.enable'),
          acknowledged,
          disabled: locked,
          onAcknowledgedChange: setAcknowledged,
          onCancel: closeConfirmation,
          onConfirm: () => {
            closeConfirmation()
            submit(confirmation)
          }
        }))
    }

    /* ---------------------------------------------------------------------- */
    /* plugin                                                                 */
    /* ---------------------------------------------------------------------- */

    const inject = ['connection', 'locale', 'remote', 'remote.permissionPresets', 'sessions', 'slots']

    function apply(ctx) {
      installStyles()
      const catalog = new PermissionCatalogDirectory(ctx)
      ctx.effect(() => () => catalog.dispose(), 'danger-reflection: process catalog directory')
      ctx.effect(() => ctx.locale.register(PERMISSION_ACCESS_NS, { zh, en }), 'danger-reflection: dictionaries')

      const sessions = ctx.sessions
      const t = ctx.locale.bind(PERMISSION_ACCESS_NS)

      /** Switch one session's preset through the same host command every surface uses. */
      const submit = async (sessionId, preset) => {
        const live = sessions.binding(sessionId)?.session
        if (live === undefined) throw new Error('this session is not materialized yet')
        const result = await live.command(`/permission ${preset}`)
        if (!result.ok) throw new Error(`permission switch failed: ${result.error.code}: ${result.error.message}`)
        if (!result.value.matched) throw new Error('the host offers no /permission command')
        return true
      }

      ctx.effect(() => ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        locale: PERMISSION_ACCESS_NS,
        // Lowest renders: the shipped occupant sits at 0, so this shadows it.
        priority: -10,
        inject: (sessionId) => ({
          hooks: { permissionCatalog: catalog.store },
          select: (preset) => submit(sessionId, preset)
        })
      }, PermissionSelect)), 'danger-reflection: composer permission seat')

      // The ambient chip is an ADDITIVE seat: `conversation.composer.dock` is a
      // `list` slot with `replaceRisk: "none"`, so a fresh id is added beside the
      // shipped entries instead of replacing one.
      ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: 'danger-reflection',
        order: 10,
        locale: PERMISSION_ACCESS_NS
      }, DangerReflectionChip)), 'danger-reflection: verdict chip')

      ctx.logger?.info?.('danger-reflection: seated the composer permission control and the verdict chip')
    }

    return { name: 'danger-reflection/client', inject, apply }
  }
})