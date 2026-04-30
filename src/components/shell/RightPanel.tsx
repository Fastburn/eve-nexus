import { useUiStore } from "../../store";
import type { RightPanelTab } from "../../store";
import { NodeDetailPanel } from "../panels";
import { MonitoringPanel } from "../monitoring/MonitoringPanel";
import "./RightPanel.css";

// ── Tab definitions with inline SVG icons ─────────────────────────────────────

const TABS: { id: RightPanelTab; label: string; icon: React.ReactNode }[] = [
  {
    id: "nodeDetail",
    label: "Detail",
    icon: (
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
        <rect x="1.5" y="1.5" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3"/>
        <line x1="4" y1="4.5" x2="9" y2="4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        <line x1="4" y1="6.5" x2="9" y2="6.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
        <line x1="4" y1="8.5" x2="7" y2="8.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
      </svg>
    ),
  },
  {
    id: "monitoring",
    label: "Jobs",
    icon: (
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
        <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.3"/>
        <polyline points="6.5,3.5 6.5,6.5 8.5,8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  },
];

export function RightPanel() {
  const tab        = useUiStore((s) => s.rightPanelTab);
  const setTab     = useUiStore((s) => s.setRightPanelTab);
  const closePanel = useUiStore((s) => s.closeRightPanel);

  return (
    <div className="right-panel">
      {/* Tab bar */}
      <div className="right-panel-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`right-panel-tab${tab === t.id ? " active" : ""}`}
            onClick={() => setTab(t.id)}
            title={t.label}
          >
            {t.icon}
            <span className="right-panel-tab-label">{t.label}</span>
          </button>
        ))}
        <button
          className="right-panel-close"
          onClick={closePanel}
          title="Close panel (Esc)"
        >
          ×
        </button>
      </div>

      {/* Content */}
      <div className="right-panel-content">
        {tab === "nodeDetail"  && <NodeDetailPanel />}
        {tab === "monitoring"  && <MonitoringPanel />}
      </div>
    </div>
  );
}



