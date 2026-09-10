import * as THREE from "three"

// Low-poly trees, two instanced meshes per tile (trunks + canopies). Tile entries: [x, z, kind, height] with
// kind 0 street/park tree, 1 deciduous wood, 2 conifer. y is sampled from the terrain here.
const trunkGeo = new THREE.CylinderGeometry(0.12, 0.2, 1, 6)          // unit height, scaled per tree
trunkGeo.translate(0, 0.5, 0)
const roundCanopy = new THREE.IcosahedronGeometry(1, 1)               // slightly squashed sphere for broadleaf
roundCanopy.scale(1, 0.85, 1)
const coneCanopy = new THREE.ConeGeometry(1, 2.2, 7)                  // conifer
coneCanopy.translate(0, 1.1, 0)
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5a4632, roughness: 1 })
const canopyMat = new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true })
trunkMat.__shared = canopyMat.__shared = true
trunkGeo.__shared = roundCanopy.__shared = coneCanopy.__shared = true   // shared across tiles: never dispose with a tile

const GREENS = {
  0: [0x4f7d3a, 0x5e8f43, 0x6a9a4a, 0x8a9e3f, 0x7f9c52],       // street trees: lighter, varied
  1: [0x3f6b32, 0x45733a, 0x517f40, 0x386028],                  // deciduous wood
  2: [0x2f5a35, 0x2a4f2f, 0x35653a]                             // conifer
}

export function buildTrees(trees, heightAt) {
  if (!trees?.length) return null
  const byKind = [[], [], []]
  for (const t of trees) byKind[t[2] ?? 1].push(t)
  const group = new THREE.Group()
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3()
  const color = new THREE.Color()

  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length)
  let ti = 0
  for (let kind = 0; kind < 3; kind++) {
    const list = byKind[kind]
    if (!list.length) continue
    const canopies = new THREE.InstancedMesh(kind === 2 ? coneCanopy : roundCanopy, canopyMat, list.length)
    list.forEach(([x, z, , h], i) => {
      const y = heightAt(x, z)
      const r = rand(x, z)
      const trunkH = kind === 2 ? h * 0.35 : h * 0.42
      const crownR = kind === 2 ? h * 0.16 : h * (0.2 + 0.08 * r)      // broadleaf crown ≈ 40–55% of height wide
      q.setFromAxisAngle(p.set(0, 1, 0), r * Math.PI * 2)
      // trunk: unit cylinder scaled to trunk height, slightly thicker for big trees
      s.set(0.5 + h / 16, trunkH, 0.5 + h / 16)
      trunks.setMatrixAt(ti++, m.compose(p.set(x, y, z), q, s))
      // canopy sits on the trunk
      s.set(crownR, kind === 2 ? (h - trunkH) / 2.2 : crownR, crownR)
      canopies.setMatrixAt(i, m.compose(p.set(x, y + trunkH, z), q, s))
      const palette = GREENS[kind]
      color.setHex(palette[Math.floor(r * palette.length)]).multiplyScalar(0.9 + 0.2 * rand(z, x))
      canopies.setColorAt(i, color)
    })
    canopies.instanceMatrix.needsUpdate = true
    canopies.instanceColor.needsUpdate = true
    group.add(canopies)
  }
  trunks.count = ti
  trunks.instanceMatrix.needsUpdate = true
  group.add(trunks)
  return group
}

// stable pseudo-random in [0,1) from a position, so trees look the same every load
function rand(a, b) {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453
  return x - Math.floor(x)
}
