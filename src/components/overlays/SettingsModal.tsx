import { useUiStore } from "../../store";
import { SettingsPanel } from "../panels";
import "./SettingsModal.css";

export function SettingsModal() {
  const show    = useUiStore((s) => s.showSettings);
  const setShow = useUiStore((s) => s.setShowSettings);

  if (!show) return null;

  return (
    <div
      className="settings-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div className="settings-modal">
        <div className="settings-modal-header">
          <span className="settings-modal-title">Settings</span>
          <button className="settings-modal-close" onClick={() => setShow(false)} title="Close">×</button>
        </div>
        <div className="settings-modal-body">
          <SettingsPanel />
        </div>
      </div>
    </div>
  );
}
