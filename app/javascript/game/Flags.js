// URL flags for A/B checks and low-end machines: ?ortho=0|512|1024 (aerial photo terrain), ?pbr=0 (photo materials),
// ?env=0 (sky environment map), ?shadows=0 (contact shadows). Absent → the default passed in.
const q = new URLSearchParams(location.search)
export const flag = (name, dflt = null) => (q.has(name) ? q.get(name) : dflt)
export const off = (name) => flag(name) === "0"
