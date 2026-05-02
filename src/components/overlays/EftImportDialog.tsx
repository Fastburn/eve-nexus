import { useEffect, useRef, useState } from "react";
import { importEftFit } from "../../api/eft";
import type { EftItem } from "../../api/eft";
import { useDraggable } from "../../lib/useDraggable";
import "./EftImportDialog.css";

interface Props {
  onClose: () => void;
  onImport: (items: EftItem[], fitName: string) => Promise<void>;
}

export function EftImportDialog({ onClose, onImport }: Props) {
  const [eftText, setEftText]     = useState("");
  const [quantity, setQuantity]   = useState(1);
  const [parsing, setParsing]     = useState(false);
  const [items, setItems]         = useState<EftItem[] | null>(null);
  const [unresolved, setUnresolved] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!eftText.trim()) {
      setItems(null);
      setUnresolved([]);
      return;
    }
    setParsing(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      try {
        const result = await importEftFit(eftText);
        setItems(result.items);
        setUnresolved(result.unresolved);
      } catch {
        setItems([]);
        setUnresolved([]);
      } finally {
        setParsing(false);
      }
    }, 500);
  }, [eftText]);

  function parseFitName(): string {
    const first    = eftText.trim().split("\n")[0] ?? "";
    const inner    = first.replace(/^\[/, "").replace(/\]$/, "");
    const parts    = inner.split(",");
    const shipName = parts[0]?.trim() || "Imported Fit";
    const fitName  = parts[1]?.trim();
    return fitName ? `${shipName} — ${fitName}` : shipName;
  }

  function scaledQty(base: number) {
    return base * Math.max(1, quantity);
  }

  async function handleImport() {
    if (!items || items.length === 0) return;
    setImporting(true);
    try {
      const scaled = items.map((it) => ({ ...it, quantity: scaledQty(it.quantity) }));
      await onImport(scaled, parseFitName());
      onClose();
    } finally {
      setImporting(false);
    }
  }

  const canImport = !parsing && items && items.length > 0 && !importing;
  const { onMouseDown, style } = useDraggable();

  return (
    <div
      className="eft-backdrop"
      role="dialog"
      aria-modal="true"
    >
      <div className="eft-dialog" style={style}>
        <div className="eft-header eft-drag-handle" onMouseDown={onMouseDown}>
          <span className="eft-title">Import Ship Fit</span>
          <button className="eft-close" onClick={onClose}>×</button>
        </div>

        <div className="eft-body">
          <div>
            <div className="eft-label">EFT Fit</div>
            <textarea
              className="eft-textarea"
              placeholder={"[Ship Type, Fit Name]\nModule Name\nModule Name\nDrone Name x5\n..."}
              value={eftText}
              onChange={(e) => setEftText(e.target.value)}
              spellCheck={false}
              autoFocus
            />
          </div>

          <div className="eft-qty-row">
            <span className="eft-qty-label">Quantity (number of fits):</span>
            <input
              className="eft-qty-input"
              type="number"
              min={1}
              max={10000}
              value={quantity}
              onChange={(e) => setQuantity(Math.min(10000, Math.max(1, parseInt(e.target.value) || 1)))}
            />
          </div>

          {(parsing || items !== null) && (
            <div className="eft-preview">
              <div className="eft-preview-title">Preview</div>
              {parsing ? (
                <div className="eft-parsing">Resolving item names…</div>
              ) : (
                <div className="eft-preview-list">
                  {items!.map((it) => (
                    <div key={it.typeId} className="eft-preview-item">
                      <div className="eft-preview-dot" />
                      <span className="eft-preview-name">{it.typeName}</span>
                      <span className="eft-preview-qty">×{scaledQty(it.quantity).toLocaleString()}</span>
                    </div>
                  ))}
                  {unresolved.map((name) => (
                    <div key={name} className="eft-preview-item unresolved">
                      <div className="eft-preview-dot" />
                      <span className="eft-preview-name">{name}</span>
                      <span className="eft-preview-qty">unresolved</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="eft-footer">
          <button className="eft-btn-cancel" onClick={onClose}>Cancel</button>
          <button className="eft-btn-import" disabled={!canImport} onClick={handleImport}>
            {importing ? "Creating…" : "Create Plan"}
          </button>
        </div>
      </div>
    </div>
  );
}
