import { ChevronRight, Search } from "lucide-react";
import { navItems } from "../data/mockData";
import type { ViewId } from "../types";

interface SidebarProps {
  activeView: ViewId;
  onNavigate: (view: ViewId) => void;
}

export function Sidebar({ activeView, onNavigate }: SidebarProps) {
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
      </div>

      <button className="primary-action" type="button">
        Nuovo task
        <ChevronRight size={16} />
      </button>

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

      <div className="sidebar-footer">
        <span className="status-dot ready" />
        <div>
          <strong>Runtime locale</strong>
          <small>Gemma 4 pronto</small>
        </div>
      </div>
    </aside>
  );
}
