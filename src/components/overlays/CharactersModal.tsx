import { useUiStore } from "../../store";
import { CharactersPanel } from "../panels";
import "./CharactersModal.css";

export function CharactersModal() {
  const show    = useUiStore((s) => s.showCharacters);
  const setShow = useUiStore((s) => s.setShowCharacters);

  if (!show) return null;

  return (
    <div
      className="chars-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Characters"
      onClick={(e) => { if (e.target === e.currentTarget) setShow(false); }}
    >
      <div className="chars-modal">
        <div className="chars-modal-header">
          <span className="chars-modal-title">Characters &amp; ESI</span>
          <button className="chars-modal-close" onClick={() => setShow(false)} title="Close">×</button>
        </div>
        <div className="chars-modal-body">
          <CharactersPanel />
        </div>
      </div>
    </div>
  );
}
