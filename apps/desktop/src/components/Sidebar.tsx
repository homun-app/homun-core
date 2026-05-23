import {
  ArrowLeft,
  Bell,
  FolderPlus,
  Grid2X2,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
} from "lucide-react";
import {
  drawerProjects,
  drawerTasks,
  navItems,
  settingsSections,
} from "../data/mockData";
import type { SettingsSectionId, ViewId } from "../types";

interface NavigationRailProps {
  activeView: ViewId;
  onNavigate: (view: ViewId) => void;
  onToggleDrawer: () => void;
}

export function NavigationRail({
  activeView,
  onNavigate,
  onToggleDrawer,
}: NavigationRailProps) {
  return (
    <aside className="navigation-rail" aria-label="Navigazione rapida">
      <div className="window-controls compact" aria-hidden="true">
        <span className="control red" />
        <span className="control yellow" />
        <span className="control green" />
      </div>

      <button
        className="rail-logo"
        type="button"
        aria-label="Apri menu"
        onClick={onToggleDrawer}
      >
        <PanelLeftOpen size={18} />
      </button>

      <nav className="rail-nav">
        <button className="rail-button" type="button" aria-label="Cerca">
          <Search size={18} />
        </button>
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={`rail-button ${activeView === item.id ? "active" : ""}`}
              key={item.id}
              type="button"
              aria-label={item.label}
              title={item.label}
              onClick={() => onNavigate(item.id)}
            >
              <Icon size={18} />
            </button>
          );
        })}
      </nav>

      <div className="rail-bottom">
        <button className="rail-button" type="button" aria-label="Notifiche">
          <Bell size={18} />
        </button>
        <button
          className={`rail-button ${activeView === "settings" ? "active" : ""}`}
          type="button"
          aria-label="Impostazioni"
          onClick={() => onNavigate("settings")}
        >
          <Settings size={18} />
        </button>
      </div>
    </aside>
  );
}

interface NavDrawerProps {
  activeView: ViewId;
  onNavigate: (view: ViewId) => void;
  onToggleDrawer: () => void;
}

export function NavDrawer({
  activeView,
  onNavigate,
  onToggleDrawer,
}: NavDrawerProps) {
  return (
    <aside className="nav-drawer" aria-label="Menu principale">
      <div className="window-controls" aria-hidden="true">
        <span className="control red" />
        <span className="control yellow" />
        <span className="control green" />
      </div>

      <header className="drawer-header">
        <div>
          <strong>Assistant locale</strong>
          <small>Gemma 4 · local-first</small>
        </div>
        <button className="icon-button" type="button" aria-label="Chiudi menu" onClick={onToggleDrawer}>
          <PanelLeftClose size={18} />
        </button>
      </header>

      <button className="drawer-primary-action" type="button">
        <SquarePen size={17} />
        <span>Nuovo compito</span>
      </button>

      <nav className="drawer-nav">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={`drawer-nav-item ${activeView === item.id ? "active" : ""}`}
              key={item.id}
              type="button"
              onClick={() => onNavigate(item.id)}
            >
              <Icon size={17} />
              <span>{item.label}</span>
              {item.badge && <em>{item.badge}</em>}
            </button>
          );
        })}
      </nav>

      <div className="drawer-scroll">
        <section className="drawer-section">
          <div className="drawer-section-title">
            <span>Progetti</span>
            <button className="icon-button small-icon-button" type="button" aria-label="Nuovo progetto">
              <FolderPlus size={15} />
            </button>
          </div>
          {drawerProjects.map((project) => (
            <button className="drawer-link" type="button" key={project}>
              {project}
            </button>
          ))}
        </section>

        <section className="drawer-section">
          <div className="drawer-section-title">
            <span>Tutti i compiti</span>
            <SlidersHorizontal size={15} />
          </div>
          {drawerTasks.map((task) => (
            <button
              className={`drawer-link ${task.active ? "active" : ""}`}
              type="button"
              key={task.id}
            >
              {task.label}
            </button>
          ))}
        </section>
      </div>

      <footer className="drawer-footer">
        <div className="drawer-persistent-actions" aria-label="Azioni persistenti">
          <button className="drawer-footer-action" type="button">
            <Bell size={16} />
            <span>Notifiche</span>
          </button>
          <button
            className="drawer-footer-action drawer-settings-action"
            type="button"
            onClick={() => onNavigate("settings")}
          >
            <Settings size={16} />
            <span>Impostazioni</span>
          </button>
        </div>
        <button className="invite-card" type="button">
          <Grid2X2 size={16} />
          <span>
            <strong>Local Computer</strong>
            <small>Browser, shell, file e log</small>
          </span>
        </button>
      </footer>
    </aside>
  );
}

interface SettingsDrawerProps {
  activeSection: SettingsSectionId;
  onBack: () => void;
  onSelect: (section: SettingsSectionId) => void;
}

export function SettingsDrawer({
  activeSection,
  onBack,
  onSelect,
}: SettingsDrawerProps) {
  return (
    <aside className="nav-drawer settings-drawer" aria-label="Impostazioni">
      <div className="window-controls" aria-hidden="true">
        <span className="control red" />
        <span className="control yellow" />
        <span className="control green" />
      </div>

      <header className="drawer-header">
        <div>
          <strong>Impostazioni</strong>
          <small>Privacy, runtime e connettori</small>
        </div>
      </header>

      <button className="back-button" type="button" onClick={onBack}>
        <ArrowLeft size={16} />
        <span>Torna all'app</span>
      </button>

      <nav className="drawer-nav settings-nav">
        {settingsSections.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={`drawer-nav-item ${activeSection === item.id ? "active" : ""}`}
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
            >
              <Icon size={17} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
