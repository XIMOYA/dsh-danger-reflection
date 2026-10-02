// Minimal ASAR reader: list a subtree, extract text files, or grep inside the archive.
// Usage:
//   node asar-extract.mjs list  <asar> [subpath]
//   node asar-extract.mjs extract <asar> <subpath> <outDir>
//   node asar-extract.mjs grep  <asar> <subpath> <regex>
import fs from 'node:fs'
import path from 'node:path'

const [mode, asarPath, subPath = '', extra] = process.argv.slice(2)

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.yml', '.yaml', '.css', '.html', '.txt'])

function openAsar(p) {
  const fd = fs.openSync(p, 'r')
  const sizeBuf = Buffer.alloc(8)
  fs.readSync(fd, sizeBuf, 0, 8, 0)
  const headerSize = sizeBuf.readUInt32LE(4)
  const headerBuf = Buffer.alloc(headerSize)
  fs.readSync(fd, headerBuf, 0, headerSize, 8)
  const jsonSize = headerBuf.readUInt32LE(4)
  const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + jsonSize))
  return { fd, header, base: 8 + headerSize }
}

function walk(node, prefix, emit) {
  if (!node || typeof node !== 'object') return
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, prefix ? `${prefix}/${name}` : name, emit)
    return
  }
  emit(prefix, node)
}

const { fd, header, base } = openAsar(asarPath)
const entries = []
walk(header, '', (p, info) => entries.push({ path: p, info }))

const norm = (subPath ?? '').replace(/^\/+|\/+$/g, '')
const matches = (e) => !norm || e.path === norm || e.path.startsWith(norm + '/')

function readFile(e) {
  const buf = Buffer.alloc(e.info.size)
  fs.readSync(fd, buf, 0, e.info.size, base + Number(e.info.offset))
  return buf.toString('utf8')
}

if (mode === 'list') {
  const scoped = entries.filter((e) => matches(e) && !e.info.files)
  const top = new Map()
  for (const e of scoped) {
    const rel = norm ? e.path.slice(norm.length).replace(/^\//, '') : e.path
    if (!rel) continue
    const head = rel.includes('/') ? rel.split('/')[0] + '/' : rel
    top.set(head, (top.get(head) ?? 0) + (e.info.size ?? 0))
  }
  console.log(`total entries: ${entries.length}, matched files: ${scoped.length}`)
  for (const [k, v] of [...top].sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(12)}  ${k}`)
} else if (mode === 'extract') {
  let written = 0
  for (const e of entries) {
    if (e.info.files || e.info.unpacked || !matches(e)) continue
    const rel = norm ? e.path.slice(norm.length).replace(/^\//, '') : e.path
    if (!rel || !TEXT_EXT.has(path.extname(rel).toLowerCase())) continue
    const dest = path.join(extra, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, readFile(e))
    written++
  }
  console.log(`extracted ${written} files -> ${extra}`)
} else if (mode === 'grep') {
  const re = new RegExp(extra, 'i')
  let hits = 0
  for (const e of entries) {
    if (e.info.files || e.info.unpacked || !matches(e)) continue
    if (!TEXT_EXT.has(path.extname(e.path).toLowerCase())) continue
    const lines = readFile(e).split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) {
        console.log(`${e.path}:${i + 1}: ${lines[i].trim().slice(0, 220)}`)
        if (++hits >= 400) { console.log('... truncated at 400 hits'); fs.closeSync(fd); process.exit(0) }
      }
    }
  }
  console.log(`-- ${hits} hits --`)
}
fs.closeSync(fd)