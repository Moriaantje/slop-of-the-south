import { fileURLToPath } from "node:url"
import path from "node:path"
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
export async function resolve(spec, ctx, next) {
  if (spec === "three") return { url: "file://" + path.join(ROOT, "vendor/javascript/three.js"), shortCircuit: true }
  if (spec.startsWith("three/addons/")) return { url: "file://" + path.join(ROOT, "vendor/javascript", spec.replace("three/", "three--").replaceAll("/", "--")), shortCircuit: true }
  if (spec.startsWith("game/")) return { url: "file://" + path.join(ROOT, "app/javascript", spec + ".js"), shortCircuit: true }
  return next(spec, ctx)
}
