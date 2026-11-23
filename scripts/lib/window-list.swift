// Fase primo-avvio (P2 e sonda): due letture del sistema, SOLA LETTURA, per
// rispondere dal DI FUORI del processo alla domanda del difetto («Homun si
// apre e non si vede niente»). Electron può dire «mostrata» (isVisible,
// evento show) mentre a schermo non c'è niente — qui si guarda quello che
// vede il WindowServer e quello che macOS considera attivo. Mai osascript
// (non serve un'automazione: sono letture).
//
//   window-list windows <pid>      (oppure: window-list <pid>)
//   window-list apps <bundle-id>
//
// windows: JSON
//   displays  quanti schermi attivi
//   screens   [{x,y,w,h}] i bounds di ogni schermo (coordinate globali, origine in alto a sinistra)
//   windows   TUTTE le finestre del processo <pid>, anche quelle fuori schermo
//             o non ordinate, con l'indice z: {pid, owner, number, layer, alpha,
//             onscreen, x, y, w, h, z}. Con <pid> = 0 sono le finestre a
//             schermo di TUTTE le app, senza pid né nomi (serve solo l'ordine)
//   z         la posizione della finestra tra TUTTE le finestre a schermo di
//             TUTTE le app (0 = la più davanti); null se non è a schermo
//
// apps: JSON — l'attivazione è per PROCESSO, ma UI e daemon di Homun sono due
// processi dello STESSO bundle: quale dei due macOS considera attivo?
//   frontmostPid     il pid dell'app in primo piano (solo il pid: niente nomi)
//   frontmostIsSame  true se l'app in primo piano è del bundle chiesto
//   apps             [{pid, policy, active, hidden, terminated, url}] dei
//             processi del bundle chiesto. policy: 0 regular, 1 accessory, 2
//             prohibited; active è NSRunningApplication.isActive
//
// Nessun titolo (kCGWindowName): non serve, e su macOS leggerlo chiede il
// permesso «Registrazione dello schermo». I nomi delle altre app non si
// stampano mai: solo quelli del processo chiesto.
import Foundation
import AppKit
import CoreGraphics

func num(_ v: Any?) -> Double {
  if let n = v as? NSNumber { return n.doubleValue }
  return 0
}

func emit(_ out: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: out, options: [])
  FileHandle.standardOutput.write(data)
}

let args = CommandLine.arguments

// ============ apps: quale processo del bundle è attivo ============
if args.count > 2 && args[1] == "apps" {
  let bundle = args[2]
  let running = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundle }
  let front = NSWorkspace.shared.frontmostApplication
  emit([
    "frontmostPid": front.map { Int($0.processIdentifier) } ?? -1,
    "frontmostIsSame": front?.bundleIdentifier == bundle,
    "apps": running.map { a in
      [
        "pid": Int(a.processIdentifier),
        "policy": Int(a.activationPolicy.rawValue),
        "active": a.isActive,
        "hidden": a.isHidden,
        "terminated": a.isTerminated,
        "url": a.bundleURL?.path ?? ""
      ] as [String: Any]
    }
  ])
  exit(0)
}

// ============ windows: le finestre del processo ============
let commandIsWindows = args.count > 2 && args[1] == "windows"
let pidArg = commandIsWindows ? args[2] : (args.count > 1 ? args[1] : "")
let wanted = Int(pidArg) ?? -1

// ---- gli schermi ----
var count: UInt32 = 0
CGGetActiveDisplayList(0, nil, &count)
var displayIds = [CGDirectDisplayID](repeating: 0, count: Int(count))
CGGetActiveDisplayList(count, &displayIds, &count)
var screens: [[String: Any]] = []
for id in displayIds.prefix(Int(count)) {
  let b = CGDisplayBounds(id)
  screens.append(["x": b.origin.x, "y": b.origin.y, "w": b.width, "h": b.height])
}

// ---- le finestre a schermo, dalla più davanti: da qui l'indice z ----
let onscreen = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
var zIndex: [Int: Int] = [:]
for (i, w) in onscreen.enumerated() {
  zIndex[Int(num(w[kCGWindowNumber as String]))] = i
}

// ---- tutte le finestre del processo chiesto (pid 0: tutte le finestre a
// schermo di tutte le app, SENZA pid né nomi: servono solo l'ordine) ----
var all = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []
if wanted <= 0 { all = onscreen }
var windows: [[String: Any]] = []
for w in all {
  let ownerPid = Int(num(w[kCGWindowOwnerPID as String]))
  if wanted > 0 && ownerPid != wanted { continue }
  let number = Int(num(w[kCGWindowNumber as String]))
  let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
  let on = w[kCGWindowIsOnscreen as String]
  windows.append([
    "pid": wanted > 0 ? ownerPid : 0,
    "owner": wanted > 0 ? ((w[kCGWindowOwnerName as String] as? String) ?? "") : "",
    "number": number,
    "layer": Int(num(w[kCGWindowLayer as String])),
    "alpha": num(w[kCGWindowAlpha as String]),
    "onscreen": ((on as? Bool) ?? ((on as? Int).map { $0 != 0 } ?? false)),
    "x": num(b["X"]),
    "y": num(b["Y"]),
    "w": num(b["Width"]),
    "h": num(b["Height"]),
    "z": zIndex[number] as Any
  ])
}

emit(["displays": Int(count), "screens": screens, "windows": windows])
