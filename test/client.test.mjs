/**
 * Contract tests for 危险反思's browser half.
 *
 * The client bundle cannot be exercised through the live GUI from here, so this
 * file runs it the way the browser module system does: it executes the script
 * with a stub `window.__ModuleLoader__`, materializes the factory with stub
 * `react` / primitives, applies the plugin to a stub Client context, and renders
 * the control with stub hooks. That reaches the two things that otherwise stay
 * unverified until a restart: the seat really is shadowed at a priority that
 * wins, and the 危险反思 row really does carry a glyph.
 *
 * Run: node --test test/
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const CLIENT_SOURCE = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const HOST_SOURCE = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8')
const MANIFEST = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

/* -------------------------------------------------------------------------- */
/* stubs                                                                      */
/* -------------------------------------------------------------------------- */

/** A `React.createElement` that builds a walkable tree instead of DOM. */
function stubReact() {
  return {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
    },
    useState(initial) {
      return [typeof initial === 'function' ? initial() : initial, () => {}]
    },
    useEffect() {}
  }
}

/** Real component identities, so assertions can name what rendered. */
function stubPrimitives() {
  function Menu() {}
  function RiskConfirmation() {}
  function IconChevronDownOutlineRegular() {}
  function PermissionIconReadOnlyRegular() {}
  function PermissionIconWorkspaceWriteRegular() {}
  function PermissionIconFullAccessRegular() {}
  return {
    Menu,
    RiskConfirmation,
    IconChevronDownOutlineRegular,
    PermissionIconReadOnlyRegular,
    PermissionIconWorkspaceWriteRegular,
    PermissionIconFullAccessRegular
  }
}

/** A `document` that records the stylesheet the bundle installs. */
function stubDocument() {
  const styles = []
  const record = (tag) => styles.push(tag)
  return {
    styles,
    document: {
      querySelector: (selector) => styles.find((style) => selector.includes(JSON.stringify(style.dataset.pluginCss))) ?? null,
      createElement: () => ({ dataset: {}, textContent: '' }),
      head: { appendChild: record }
    }
  }
}

/**
 * Execute the client bundle and materialize its factory, exactly as the browser
 * module system would.
 * @returns the registration, the plugin object, and the stubs it ran against.
 */
function materialize() {
  const registrations = []
  const page = stubDocument()
  const sandbox = {
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
    document: page.document,
    console
  }
  vm.createContext(sandbox)
  new vm.Script(CLIENT_SOURCE, { filename: 'lib/client.js' }).runInContext(sandbox)
  assert.equal(registrations.length, 1, 'the bundle registers exactly one module')

  const React = stubReact()
  const primitives = stubPrimitives()
  const required = []
  const plugin = registrations[0].factory((specifier) => {
    required.push(specifier)
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require(${specifier})`)
  })
  return { registration: registrations[0], plugin, React, primitives, required, styles: page.styles }
}

/** The permission catalog the stub Host serves. */
const CATALOG = {
  defaultPreset: 'workspace-write',
  defaultOptions: [],
  options: [
    { value: 'read-only', name: 'read-only' },
    { value: 'workspace-write', name: 'workspace-write' },
    { value: 'danger-full-access', name: 'danger-full-access' },
    { value: 'danger-reflection', name: '危险反思', description: '沙箱范围与「工作区写入」相同…' }
  ]
}

/** A Client context covering exactly the services the bundle injects. */
function stubContext() {
  const captured = { occupants: [], injections: [], locales: [], infos: [], commands: [] }
  const ctx = {
    logger: { info: (line) => captured.infos.push(line), warn: () => {} },
    get: (key) => (key === 'connection' ? ctx.connection : undefined),
    connection: { generation: { getSnapshot: () => ({ id: 'gen-1' }), subscribe: () => () => {} } },
    remote: {
      $on: () => () => {},
      permissionPresets: { catalog: async () => ({ ok: true, value: CATALOG }) }
    },
    locale: {
      register: (ns, dicts) => {
        captured.locales.push({ ns, dicts })
        return () => {}
      },
      bind: (ns) => {
        const entry = captured.locales.find((candidate) => candidate.ns === ns)
        const dicts = entry === undefined ? { zh: {}, en: {} } : entry.dicts
        return (key, params) => {
          const template = dicts.en[key] ?? dicts.zh[key] ?? key
          return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_, name) => String(params[name]))
        }
      }
    },
    sessions: {
      binding: () => ({
        session: {
          command: async (line) => {
            captured.commands.push(line)
            return { ok: true, value: { matched: true } }
          }
        }
      })
    },
    slots: {
      inject: (key, callback) => {
        captured.injections.push({ key, effect: callback() })
        return () => {}
      },
      register: (options, component) => {
        captured.occupants.push({ options, component })
        return () => {}
      }
    },
    effect: (fn) => {
      fn()
      return () => {}
    }
  }
  return { ctx, captured }
}

/** Apply the plugin and return the seat it registered. */
function seat() {
  const materialized = materialize()
  const { ctx, captured } = stubContext()
  materialized.plugin.apply(ctx)
  const occupant = captured.occupants[0]
  assert.ok(occupant !== undefined, 'apply seats a slot occupant')
  return { ...materialized, ctx, captured, occupant }
}

/** Render the control and return the menu element plus the confirmation slot. */
function renderControl({ React, occupant }, currentValue, overrides = {}) {
  const element = occupant.component({
    locked: false,
    select: async () => true,
    usePermissionCatalog: (selector) => selector({ value: CATALOG }),
    useProjection: () => ({ currentValue }),
    t: (key) => key,
    ...overrides
  })
  const [menu, confirmation] = element.props.children
  assert.equal(menu.type.name, 'Menu', 'the dropdown is the shipped primitive')
  return { menu, confirmation }
}

/* -------------------------------------------------------------------------- */
/* the bundle                                                                 */
/* -------------------------------------------------------------------------- */

test('the client bundle parses as a browser script and registers under the package name', () => {
  const { registration } = materialize()
  assert.equal(registration.id, MANIFEST.name, 'the browser module id is the package name')
  assert.equal(typeof registration.factory, 'function')
})

test('the factory materializes with only react and the icon package', () => {
  const { plugin, required } = materialize()
  assert.deepEqual(required, ['react', '@deepseek-ai/dsh-client-ui-primitives'], 'nothing else must resolve at runtime')
  assert.equal(plugin.name, 'danger-reflection/client')
  assert.equal(typeof plugin.apply, 'function')
  // Spread into this realm first: a vm-created array fails deepStrictEqual on
// prototype identity alone, which says nothing about the declaration.
  assert.deepEqual([...plugin.inject], ['connection', 'locale', 'remote', 'remote.permissionPresets', 'sessions', 'slots'])
})

test('the manifest declares the client half and needs no external beyond the baseline', () => {
  assert.equal(MANIFEST.exports['./client'], './lib/client.js', 'client-modules resolves exports["./client"]')
  assert.equal(MANIFEST.dsh.client.platform, 'web')
  assert.equal(MANIFEST.dsh.client.external, undefined, 'react and the icon package are both baseline: no external is required')
  assert.ok(Array.isArray(MANIFEST.dsh.client.inject))
})

test('the host half never pulls in the browser half', () => {
  assert.ok(!/\.\/client\.js/.test(HOST_SOURCE), 'the host must not import the browser bundle')
  assert.ok(!/__ModuleLoader__/.test(HOST_SOURCE))
})

/* -------------------------------------------------------------------------- */
/* the seat                                                                   */
/* -------------------------------------------------------------------------- */

test('apply shadows the shipped seat at a priority that wins', async () => {
  const { occupant, captured } = seat()
  assert.equal(occupant.options.name, 'conversation.input.permission', 'it replaces the composer permission control')
  assert.equal(occupant.options.priority, -10, 'lowest renders, and the shipped occupant sits at 0')
  assert.equal(occupant.options.locale, 'danger-reflection.permission', 'its copy lives in this plugin’s own namespace')
  assert.equal(typeof occupant.component, 'function')

  const face = occupant.options.inject('session-1')
  assert.equal(typeof face.select, 'function')
  assert.equal(typeof face.hooks.permissionCatalog.getSnapshot, 'function', 'the catalog is a bare snapshot source')
  assert.equal(typeof face.hooks.permissionCatalog.subscribe, 'function')

  // Selecting must go through the same host command every other surface uses.
  await face.select('danger-reflection')
  assert.deepEqual(captured.commands, ['/permission danger-reflection'])
})

test('apply owns its locale namespace and installs its own stylesheet', () => {
  const { captured, styles } = seat()
  const locale = captured.locales.find((entry) => entry.ns === 'danger-reflection.permission')
  assert.ok(locale !== undefined, 'no borrowing of the shipped permission.access namespace')
  assert.deepEqual(Object.keys(locale.dicts.en).sort(), Object.keys(locale.dicts.zh).sort(), 'the dictionaries stay key-complete')
  assert.equal(locale.dicts.zh['confirm.title'], '确认启用完全权限？', 'the shipped copy is preserved, so the control reads the same')

  assert.equal(styles.length, 1, 'exactly one stylesheet is installed')
  assert.equal(styles[0].dataset.plugin, 'dsh-danger-reflection')
  assert.ok(styles[0].textContent.includes('.drPermission_trigger{'), 'it carries its own copy of the rules')
  assert.ok(!styles[0].textContent.includes('dlU_AG_'), 'it does not reuse the shipped hashed class names')

  assert.ok(captured.infos.some((line) => /seated the composer permission control/.test(line)))
})

/* -------------------------------------------------------------------------- */
/* the glyph                                                                  */
/* -------------------------------------------------------------------------- */

test('every preset row carries a glyph, including the host-configured one', () => {
  const materialized = seat()
  const { menu } = renderControl(materialized, 'danger-reflection')

  const glyphs = menu.props.items.map((item) => ({ id: item.id, glyph: item.icon?.type?.name ?? null }))
  assert.deepEqual(glyphs, [
    { id: 'read-only', glyph: 'PermissionIconReadOnlyRegular' },
    { id: 'workspace-write', glyph: 'PermissionIconWorkspaceWriteRegular' },
    { id: 'danger-full-access', glyph: 'PermissionIconFullAccessRegular' },
    { id: 'danger-reflection', glyph: 'DangerReflectionGlyph' }
  ], 'the host-configured preset now has an icon of its own, and no shipped row lost one')

  // The trigger shows the current preset's glyph too — this is the collapsed
  // state the screenshot showed as bare.
  const trigger = menu.props.anchor
  const triggerIcon = trigger.props.children[0]
  assert.equal(triggerIcon.type, 'span', 'the trigger reserves the icon slot')
  assert.equal(triggerIcon.props.children.type.name, 'DangerReflectionGlyph')
  assert.equal(trigger.props['aria-label'], 'mode', 'the accessible label still comes from the dictionary')
  assert.equal(trigger.props.disabled, false)
})

test('the glyph is absent only where the preset is unknown to both sides', () => {
  const materialized = seat()
  const hostOnly = {
    ...CATALOG,
    options: [...CATALOG.options, { value: 'some-other-preset', name: 'Some Other' }]
  }
  const element = materialized.occupant.component({
    locked: false,
    select: async () => true,
    usePermissionCatalog: (selector) => selector({ value: hostOnly }),
    useProjection: () => ({ currentValue: 'some-other-preset' }),
    t: (key) => key
  })
  const menu = element.props.children[0]
  assert.equal(menu.props.items.at(-1).icon, undefined, 'other host presets behave exactly as DSH shipped them')
})

test('the new glyph matches the design set it joins', () => {
  const materialized = seat()
  const { menu } = renderControl(materialized, 'danger-reflection')
  const element = menu.props.items.find((item) => item.id === 'danger-reflection').icon
  const artwork = element.type(element.props)

  assert.equal(artwork.type, 'svg')
  assert.equal(artwork.props.viewBox, '0 0 16 16', 'same artboard as the shipped permission glyphs')
  assert.equal(artwork.props.strokeWidth, 1, 'the shipped Regular glyphs use a 1px stroke')
  assert.equal(artwork.props.fill, 'none')
  assert.equal(artwork.props['aria-hidden'], 'true', 'decorative, like its siblings')

  const [shield, lens, pupil] = artwork.props.children
  assert.ok(shield.props.d.includes('6.59624 2.14853'), "the shield is the read-only glyph's own outline, so the family matches")
  assert.equal(shield.props.stroke, 'currentColor')
  assert.equal(lens.props.d, 'M5 7.7Q8 4.9 11 7.7Q8 10.5 5 7.7Z', 'an eye: two symmetric arcs')
  assert.equal(pupil.type, 'circle')
  assert.equal(pupil.props.r, 0.95)
})

/* -------------------------------------------------------------------------- */
/* the ambient verdict chip                                                   */
/* -------------------------------------------------------------------------- */

/** The chip occupant, seated alongside the permission control. */
function chipSeat() {
  const materialized = seat()
  const chip = materialized.captured.occupants.find((entry) => entry.options.id === 'danger-reflection')
  assert.ok(chip !== undefined, 'the chip is seated under its own id')
  return { ...materialized, chip }
}

test('the chip is an additive seat beside the shipped composer entries', () => {
  const { chip, captured } = chipSeat()
  assert.equal(chip.options.name, 'conversation.composer.dock', 'the ambient dock, not the permission seat')
  assert.equal(chip.options.id, 'danger-reflection', 'a fresh id adds a cell; reusing a shipped id would replace it')
  assert.equal(chip.options.order, 10)
  assert.equal(captured.occupants.length, 2, 'the permission control is still seated too')
  assert.deepEqual(captured.injections.map((entry) => entry.key).sort(),
    ['conversation.composer.dock', 'conversation.input.permission'])
})

test('the chip renders the reviewer’s verdict', () => {
  const { chip } = chipSeat()
  const render = (state) => chip.component({ useProjection: () => state, t: (_key, fallback) => fallback })

  const allowed = render({ verdict: 'allow', action: 'allow', detail: '只删 build/', toolName: 'pwsh' })
  assert.match(allowed.props.children[0].props.children, /危险反思 · 已放行/)
  assert.equal(allowed.props.children[1].props.children, 'pwsh', 'the reviewed tool is named')
  assert.equal(allowed.props.children[2], false, 'no undecided note when a verdict exists')
  assert.equal(allowed.props.title, '只删 build/', 'the reviewer’s wording is the tooltip')

  const denied = render({ verdict: 'deny', action: 'reject', detail: '范围过大', toolName: 'pwsh' })
  assert.match(denied.props.children[0].props.children, /危险反思 · 已拒绝/)
})

test('the chip never paints a missing decision as a rejection', () => {
  const { chip } = chipSeat()
  const render = (state) => chip.component({ useProjection: () => state, t: (_key, fallback) => fallback })

  const undecided = render({ verdict: null, action: 'unavailable', detail: 'provider exploded', toolName: 'pwsh' })
  assert.match(undecided.props.children[0].props.children, /危险反思 · 未得出结论/)
  assert.equal(undecided.props.children[2].props.children, '（审查没有作出判定）')
  const painted = JSON.stringify(undecided)
  assert.ok(!painted.includes('已拒绝'), 'a failure is not a rejection in the chip either')
  assert.ok(!painted.includes('模型判定'), 'and no verdict is claimed')
})

test('the chip stays out of the way when there is nothing to say', () => {
  const { chip } = chipSeat()
  const render = (state) => chip.component({ useProjection: () => state, t: (_key, fallback) => fallback })

  assert.equal(render(undefined), null, 'no projection capability, no chip')
  assert.equal(render(null), null)
  assert.equal(render({ verdict: null, action: '', detail: '', toolName: null, at: 0 }), null, 'never reviewed, no chip')
})

test('the chip works without a translator rather than throwing', () => {
  const { chip } = chipSeat()
  const rendered = chip.component({
    useProjection: () => ({ verdict: 'allow', action: 'allow', detail: '', toolName: null }),
    t: undefined
  })
  assert.match(rendered.props.children[0].props.children, /已放行/, 'falls back to the built-in wording')
  assert.equal(rendered.props.children[1], false, 'no tool name, no tool label')
})

/* -------------------------------------------------------------------------- */
/* behaviour preserved from the shipped control                               */
/* -------------------------------------------------------------------------- */

test('the port keeps the shipped risk gate for the presets that have one', () => {
  assert.match(CLIENT_SOURCE, /id === FULL_ACCESS_PRESET \|\| id === AUTO_PRESET/, 'the acknowledgement gate survives the port')
  const materialized = seat()
  assert.equal(renderControl(materialized, 'danger-full-access').confirmation, false, 'no gate is shown before a choice is made')
  assert.equal(renderControl(materialized, 'danger-reflection').confirmation, false)
})

test('the port keeps the shipped presentation rules', () => {
  const materialized = seat()
  const { menu } = renderControl(materialized, 'workspace-write')
  // A shipped value with no host label renders its localized product label.
  assert.equal(menu.props.items[1].label, 'preset.workspaceWrite')
  // A host-supplied label is used verbatim for a value the label table does not know.
  assert.equal(menu.props.items[3].label, '危险反思')
  assert.equal(menu.props.selectedId, 'workspace-write')
  // The trigger keeps the host description as its tooltip.
  const materializedReflection = seat()
  const reflection = renderControl(materializedReflection, 'danger-reflection')
  assert.equal(reflection.menu.props.anchor.props.title, CATALOG.options[3].description)
})