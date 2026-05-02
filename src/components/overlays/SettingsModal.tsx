import { useUiStore } from "../../store";
import { useDraggable } from "../../lib/useDraggable";
import { SettingsPanel } from "../panels";
import "./SettingsModal.css";

export function SettingsModal() {
  const show    = useUiStore((s) => s.showSettings);
  const setShow = useUiStore((s) => s.setShowSettings);
  const { onMouseDown, style } = useDraggable();

  if (!show) return null;

  return (
    <div
      className="settings-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div className="settings-modal" style={style}>
        <div className="settings-modal-header settings-modal-drag-handle" onMouseDown={onMouseDown}>
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
