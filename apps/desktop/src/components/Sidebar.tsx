import {
  ArrowLeft,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
} from "lucide-react";
import { navItems, settingsSections } from "../data/mockData";
import type { SettingsSectionId, ViewId } from "../types";

interface SidebarProps {
  activeView: ViewId;
  isCollapsed: boolean;
  onNavigate: (view: ViewId) => void;
  onToggle: () => void;
}

export function Sidebar({
  activeView,
  isCollapsed,
  onNavigate,
  onToggle,
}: SidebarProps) {
  return (
    <aside className="sidebar" aria-label="Navigazione principale">
      <div className="window-controls" aria-hidden="true">
        <span className="control red" />
        <span className="control yellow" />
        <span className="control green" />
      </div>

      <div className="brand-block">
        <div>
          <p className="eyebrow">Local-first</p>
          <h1>Assistant</h1>
        </div>
        <button className="icon-button" type="button" aria-label="Cerca">
          <Search size={17} />
        </button>
        <button
          className="icon-button collapse-toggle"
          type="button"
          aria-label={isCollapsed ? "Espandi menu" : "Comprimi menu"}
          onClick={onToggle}
        >
          {isCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>

      <button className="primary-action" type="button" title="Nuovo task">
        <SquarePen size={17} />
        <span>Nuovo compito</span>
      </button>

      <div className="sidebar-scroll">
        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={`nav-item ${activeView === item.id ? "active" : ""}`}
                key={item.id}
                type="button"
                onClick={() => onNavigate(item.id)}
              >
                <Icon size={17} />
                <span>{item.label}</span>
                {item.badge && <strong>{item.badge}</strong>}
              </button>
            );
          })}
        </nav>

        <div className="sidebar-group">
          <div className="sidebar-group-title">
            <span>Progetti</span>
            <button className="icon-button small-icon-button" type="button" aria-label="Nuovo progetto">
              <FolderPlus size={15} />
            </button>
          </div>
          <button className="sidebar-link" type="button">Local-first assistant</button>
        </div>

        <div className="sidebar-group">
          <div className="sidebar-group-title">
            <span>Tutti i compiti</span>
            <SlidersHorizontal size={15} />
          </div>
          <button className="sidebar-link muted" type="button">Riepilogo Acme</button>
          <button className="sidebar-link muted" type="button">Treni Napoli-Milano</button>
        </div>
      </div>

      <div className="sidebar-bottom">
        <div className="sidebar-footer compact">
          <span className="status-dot ready" />
          <div>
            <strong>Locale attivo</strong>
            <small>Gemma 4 pronto</small>
          </div>
        </div>
        <button
          className="settings-row-button"
          type="button"
          aria-label="Impostazioni"
          onClick={() => onNavigate("settings")}
        >
          <Settings size={17} />
          <span>Impostazioni</span>
        </button>
      </div>
    </aside>
  );
}

interface SettingsSidebarProps {
  activeSection: SettingsSectionId;
  isCollapsed: boolean;
  onBack: () => void;
  onSelect: (section: SettingsSectionId) => void;
  onToggle: () => void;
}

export function SettingsSidebar({
  activeSection,
  isCollapsed,
  onBack,
  onSelect,
  onToggle,
}: SettingsSidebarProps) {
  return (
    <aside className="sidebar settings-sidebar" aria-label="Impostazioni">
      <div className="window-controls" aria-hidden="true">
        <span className="control red" />
        <span className="control yellow" />
        <span className="control green" />
      </div>

      <div className="brand-block">
        <div>
          <p className="eyebrow">Impostazioni</p>
          <h1>Assistant</h1>
        </div>
        <button
          className="icon-button collapse-toggle"
          type="button"
          aria-label={isCollapsed ? "Espandi impostazioni" : "Comprimi impostazioni"}
          onClick={onToggle}
        >
          {isCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
      </div>

      <div className="sidebar-scroll">
        <button className="back-button" type="button" onClick={onBack}>
          <ArrowLeft size={16} />
          <span>Torna all'app</span>
        </button>

        <nav className="nav-list settings-nav-list">
          {settingsSections.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={`nav-item ${activeSection === item.id ? "active" : ""}`}
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
      </div>
    </aside>
  );
}
