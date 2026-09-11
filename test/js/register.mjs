// Node harness for the browser modules: resolves the importmap's bare specifiers ("three", "three/addons/…",
// "game/…") to the vendored and source files and stubs the few browser globals the modules touch at import time.
// Run: node --import ./test/js/register.mjs --test test/js/*.test.mjs
import { register } from "node:module"
import { fileURLToPath } from "node:url"
import path from "node:path"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
register("./hooks.mjs", import.meta.url)
globalThis.__ROOT = ROOT

const ctx = new Proxy({}, { get: (_, p) => ({ createRadialGradient: () => ({ addColorStop() {} }), createLinearGradient: () => ({ addColorStop() {} }), measureText: () => ({ width: 10 }) }[p] ?? (() => undefined)), set: () => true })
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, getBoundingClientRect: () => ({ width: 230, height: 230 }), classList: { toggle() {} }, addEventListener() {} }) }
globalThis.self = globalThis; globalThis.window = globalThis
globalThis.addEventListener = () => {}
globalThis.location = { search: "" }
globalThis.innerWidth = 1280; globalThis.innerHeight = 720; globalThis.devicePixelRatio = 1
globalThis.performance ??= { now: () => Date.now() }
Map.groupBy ??= (items, fn) => { const m = new Map(); for (const it of items) { const k = fn(it); if (!m.has(k)) m.set(k, []); m.get(k).push(it) } return m }
