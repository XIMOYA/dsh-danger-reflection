/**
 * Bundle-patch check: parse `cordis.patch.yml` with the same `!!js` tag support
 * DSH's own patch parser uses, then assert the shape the Loader depends on.
 *
 * A loader patch replaces `config` wholesale, and a patch that targets nothing
 * is only a warning rather than an error — so a typo here would silently drop
 * the 危险反思 option from the permission selector instead of failing loudly.
 * That is why this check is explicit.
 *
 * Run: node tools/check-patch.mjs
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const here = createRequire(import.meta.url)

/** Load the first resolvable js-yaml, preferring this profile's own copy. */
function loadYaml() {
  const candidates = [
    process.env.DSH_PROFILE_DIR === undefined ? undefined : path.join(process.env.DSH_PROFILE_DIR, 'node_modules', 'js-yaml'),
    path.join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'js-yaml')
  ].filter((candidate) => candidate !== undefined)
  for (const candidate of candidates) {
    if (existsSync(candidate)) return here(candidate)
  }
  try {
    return here('js-yaml')
  } catch {
    return undefined
  }
}

const yaml = loadYaml()
if (yaml === undefined) {
  console.error('check-patch: no js-yaml is reachable, so this check cannot run here.')
  console.error('check-patch: run it from a machine with a DSH profile, or add js-yaml to devDependencies.')
  process.exit(2)
}

// Mirror DSH: `!!js` scalars are inert markers the Loader evaluates at activation.
const jsExpression = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data) => ({ __jsExpr: data }),
  predicate: (value) => value instanceof Object && '__jsExpr' in value,
  represent: (data) => data.__jsExpr
})

const manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
const patchFile = path.join(dir, manifest.dsh?.bundle?.patch ?? './cordis.patch.yml')
const patches = yaml.load(readFileSync(patchFile, 'utf8'), { schema: yaml.DEFAULT_SCHEMA.extend([jsExpression]) })

const problems = []
const check = (ok, message) => { if (!ok) problems.push(message) }

check(Array.isArray(patches), 'patch file must be a top-level YAML array')
check(patches?.length === 2, `expected 2 patch rows, got ${patches?.length}`)

const override = patches?.find((row) => row.id === 'permission')
check(override !== undefined, 'missing the id-targeted permission override (the Loader entry id is `permission`)')
check(override?.name === '@deepseek-ai/dsh-permission-presets', 'the override must assert the module name')

const presets = override?.config?.presets ?? {}
const names = Object.keys(presets)
check(
  names.join(',') === 'read-only,workspace-write,danger-full-access,danger-reflection',
  `stock presets must be restated verbatim and danger-reflection appended last, got ${names.join(',')}`
)
check(presets['read-only']?.sandbox === 'read-only' && presets['read-only']?.approval === 'ask', 'read-only must be unchanged')
check(presets['workspace-write']?.sandbox === 'workspace-write' && presets['workspace-write']?.approval === 'ask', 'workspace-write must be unchanged')
check(presets['danger-full-access']?.sandbox === 'danger-full-access' && presets['danger-full-access']?.approval === 'never', 'danger-full-access must be unchanged')

for (const stock of ['read-only', 'workspace-write', 'danger-full-access']) {
  check(presets[stock]?.name === undefined, `${stock} must NOT carry a name: it would displace the client's own localized label`)
  check(presets[stock]?.description === undefined, `${stock} must NOT carry a description, for the same reason`)
}

const preset = presets['danger-reflection'] ?? {}
check(preset.name === '危险反思', `the new preset label must be 危险反思, got ${preset.name}`)
check(preset.sandbox === 'workspace-write', 'danger-reflection must stay confined, or no approval request would ever fire')
check(preset.approval === 'ask', 'danger-reflection must keep approval=ask: `never` short-circuits before the approval waterfall')
check(typeof preset.description === 'string' && preset.description.length > 0, 'the new preset needs copy: the client has none for a host-configured value')
check(override?.config?.defaultPreset === undefined, 'defaultPreset must stay inferred so the composition default is unchanged')

const insert = patches?.find((row) => Array.isArray(row.insert))?.insert ?? []
check(insert.length === 1, `expected 1 inserted row, got ${insert.length}`)
const row = insert[0] ?? {}
check(row.id === 'danger-reflection', 'inserted row id must be danger-reflection')
check(row.name === manifest.name, 'inserted row name must be the package name')
check(row.config?.presets?.[0] === 'danger-reflection', 'the plugin must review the danger-reflection preset key')
check(row.config?.onDeny === 'reject' && row.config?.onFailure === 'ask', 'shipped policy must be deny-final with a human fallback')
// A review that reached no decision is not a decision. `rejected` would be
// rendered by the caller as "the user rejected escalating this command".
check(row.config?.onFailure !== 'reject', 'onFailure must never be "reject"')
check(['ask', 'unavailable', 'allow'].includes(row.config?.onFailure), 'onFailure must name one of the no-decision policies')
check(row.config?.temperature === 0, 'the reviewer must sample deterministically by default')
check(row.config?.announce === true, 'the review result must be visible in the conversation by default')
check(row.config?.audit === true, 'the audit trail must default on for a gate that grants without a human')
check(row.config?.auditPath === '', 'the audit path must stay Host-derived, not hard-coded')

for (const [key, target] of Object.entries(manifest.exports ?? {})) {
  if (key === './package.json') continue
  check(existsSync(path.join(dir, target)), `exports ${key} -> ${target} does not exist`)
}
check(existsSync(path.join(dir, 'locale/en.json')), 'locale/en.json is the anchor readPluginMeta resolves first')
check(existsSync(path.join(dir, 'locale/zh.json')), 'locale/zh.json carries the Chinese plugin title')
check(manifest.dependencies === undefined, 'the plugin must declare no dependencies so installation needs no registry')
check(manifest.dsh?.bundle?.patch !== undefined, 'the package must declare its bundle patch or it will not be a profile layer')

// The browser half: client-modules resolves `exports["./client"]`, requires
// `dsh.client.platform`, and rejects an `external` that names a row which cannot
// answer it — so a wrong declaration here fails activation at launch, long after
// the file was written.
const client = manifest.dsh?.client
check(client !== undefined, 'the package must declare dsh.client or the browser half never loads')
check(client?.platform === 'web', `dsh.client.platform must be "web", got ${JSON.stringify(client?.platform)}`)
check(client?.external === undefined, 'no external is needed: react and the icon package are both in the frozen baseline table')
const clientRel = manifest.exports?.['./client']
check(typeof clientRel === 'string', 'client-modules resolves exports["./client"]')
check(clientRel !== undefined && existsSync(path.join(dir, clientRel)), `exports["./client"] -> ${clientRel} does not exist`)
if (typeof clientRel === 'string' && existsSync(path.join(dir, clientRel))) {
  const source = readFileSync(path.join(dir, clientRel), 'utf8')
  check(source.includes('window.__ModuleLoader__.load('), 'the client bundle must register through the browser module loader')
  check(source.includes(`id: '${manifest.name}'`) || source.includes(`id: "${manifest.name}"`),
    `the browser module id must be the package name (${manifest.name}) so <id>/client and the bare id agree`)
  check(!/from\s+['"]node:/.test(source) && !/require\(['"]node:/.test(source), 'the browser half must not reach for Node builtins')
  check(!source.includes('dlU_AG_'), 'the browser half must own its class names, not reuse the shipped hashed ones')
}

console.log(JSON.stringify({
  patchFile: path.relative(dir, patchFile),
  presets: names,
  inserted: insert.map((entry) => entry.id),
  clientBundle: clientRel ?? null,
  problems
}, null, 2))
process.exit(problems.length === 0 ? 0 : 1)