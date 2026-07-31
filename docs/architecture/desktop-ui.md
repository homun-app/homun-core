# Desktop UI (as-built)

Verificato 2026-07-31 contro `apps/desktop/src`.

## Shell e view

`ViewId` in `types.ts`:
`chat | learning | memory | connections | automations | proattivita | browser | brain | settings`.

In `App.tsx` le superfici principali montate includono:

- `chat` → `ChatView` (superficie primaria)
- `automations` → `AutomationsView`
- `learning` → `LearningView`
- `settings` → `SettingsView` (Memory vive qui, non come nav top-level)
- `browser` → `ContainedComputerView`
- plugin panels (`proattivita`, presentations, …)

**Assente:** `TasksView` / `activeView === "tasks"`. Nav statica tipica: chat +
automations (`mockData.ts`).

## Chat

- `ChatView.tsx` (~10k righe) — transcript, streaming, approval/uncertain inline,
  progress da piano canonico.
- `AdaptiveWorkspaceIsland.tsx` — sezioni `activity | browser | artifacts | sources`
  solo con stato reale; parte chiusa; cede all’inspector.
- `ComposerShell`, `RuntimeContextPanel`, `Sidebar` + `SidebarFilters`, menu layered.

Bridge verso gateway: `lib/coreBridge.ts` (turns, WS, task queue scoped, approvals).

## Dev

```bash
cd apps/desktop
npm run electron:dev   # Vite :1420 + gateway :18765
```

Niente bump versione per prove locali.
