import { useEffect, useMemo, useState } from "react";
import { ChatView } from "./components/ChatView";
import { ConnectionsView } from "./components/ConnectionsView";
import { Shell } from "./components/Shell";
import { ShallowView } from "./components/ShallowView";
import { SettingsView } from "./components/SettingsView";
import { TasksView } from "./components/TasksView";
import {
  approvals,
  brainRun,
  chatMessages,
  computerSession,
  connections,
  memorySummary,
  runtimeHealth,
  tasks,
} from "./data/mockData";
import type { SettingsSectionId, ViewId } from "./types";

export default function App() {
  const [activeView, setActiveView] = useState<ViewId>("chat");
  const [previousView, setPreviousView] = useState<ViewId>("chat");
  const [settingsSection, setSettingsSection] =
    useState<SettingsSectionId>("privacy");
  const [selectedTaskId, setSelectedTaskId] = useState(tasks[1].id);
  const [drawerOpen, setDrawerOpen] = useState(() => window.innerWidth > 860);
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedTaskId) ?? tasks[0],
    [selectedTaskId],
  );
  const isSettings = activeView === "settings";

  function handleNavigate(view: ViewId) {
    if (view === "settings" && activeView !== "settings") {
      setPreviousView(activeView);
    }
    setActiveView(view);
  }

  useEffect(() => {
    function syncDrawerWithViewport() {
      setDrawerOpen(window.innerWidth > 860);
    }

    syncDrawerWithViewport();
    window.addEventListener("resize", syncDrawerWithViewport);
    return () => window.removeEventListener("resize", syncDrawerWithViewport);
  }, []);

  return (
    <Shell
      activeView={activeView}
      drawerOpen={drawerOpen}
      onBackFromSettings={() => setActiveView(previousView)}
      onNavigate={handleNavigate}
      onToggleDrawer={() => setDrawerOpen((value) => !value)}
      onSelectSettingsSection={setSettingsSection}
      settingsSection={settingsSection}
    >
      <main
        className={`workspace ${isSettings ? "settings-workspace" : ""}`}
        aria-label="Area di lavoro principale"
      >
        {activeView === "chat" && (
          <ChatView
            approvalsCount={approvals.length}
            computerSession={computerSession}
            messages={chatMessages}
            health={runtimeHealth}
            task={selectedTask}
          />
        )}
        {activeView === "tasks" && (
          <TasksView
            tasks={tasks}
            approvals={approvals}
            selectedTaskId={selectedTask.id}
            onSelectTask={setSelectedTaskId}
          />
        )}
        {activeView === "settings" && (
          <SettingsView
            health={runtimeHealth}
            connections={connections}
            section={settingsSection}
          />
        )}
        {activeView === "memory" && (
          <ShallowView
            title="Memoria"
            eyebrow="UI-safe read model"
            description="Stato sintetico della memoria locale, pronto per essere collegato al MemoryUiReadModel."
            stats={[
              { label: "Confermate", value: String(memorySummary.confirmed) },
              { label: "Candidate", value: String(memorySummary.candidates) },
              { label: "Domini", value: String(memorySummary.domains.length) },
            ]}
          />
        )}
        {activeView === "connections" && (
          <ConnectionsView connections={connections} />
        )}
        {activeView === "automations" && (
          <ShallowView
            title="Automazioni"
            eyebrow="Proposte e pianificate"
            description="Le routine diventano task durevoli con approvazioni e policy, non job nascosti."
            stats={[
              { label: "Attive", value: "3" },
              { label: "In revisione", value: "1" },
              { label: "Sospese", value: "0" },
            ]}
          />
        )}
        {activeView === "browser" && (
          <ShallowView
            title="Browser"
            eyebrow="Runtime locale"
            description="Sessioni Playwright/CDP, artifact redatti e manual blockers controllati dal task runtime."
            stats={[
              { label: "Sessione", value: "1" },
              { label: "Artifact", value: "4" },
              { label: "Approval", value: "1" },
            ]}
          />
        )}
        {activeView === "brain" && (
          <ShallowView
            title="Brain Audit"
            eyebrow="Piani spiegabili"
            description="Route, tool caricati, memory refs e step subagent sono persistiti senza raw payload."
            stats={[
              { label: "Route", value: brainRun.route },
              { label: "Round", value: String(brainRun.plannerRounds) },
              { label: "Tool", value: String(brainRun.loadedTools) },
            ]}
          />
        )}
      </main>
    </Shell>
  );
}
