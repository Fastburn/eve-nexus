import { useEffect, useRef, useState } from "react";
import { searchTypes } from "../../api";
import type { TypeSummary } from "../../api";
import { TypeIcon } from "./TypeIcon";
import "./TypePicker.css";

interface TypePickerProps {
  placeholder?: string;
  onSelect: (type: TypeSummary) => void;
  /** Resets the input after selection when true (default true). */
  clearOnSelect?: boolean;
}

export function TypePicker({
  placeholder = "Search for an item…",
  onSelect,
  clearOnSelect = true,
}: TypePickerProps) {
  const [query, setQuery]         = useState("");
  const [results, setResults]     = useState<TypeSummary[]>([]);
  const [open, setOpen]           = useState(false);
  const [focusIdx, setFocusIdx]   = useState(-1);

  const inputRef    = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const res = await searchTypes(query);
      setResults(res);
      setOpen(res.length > 0);
      setFocusIdx(-1);
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query]);

  // Click outside to close
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  function handleSelect(type: TypeSummary) {
    onSelect(type);
    if (clearOnSelect) {
      setQuery("");
      setResults([]);
    }
    setOpen(false);
    inputRef.current?.focus();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && focusIdx >= 0) {
      e.preventDefault();
      handleSelect(results[focusIdx]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="type-picker" ref={containerRef}>
      <input
        ref={inputRef}
        type="search"
        value={query}
        placeholder={placeholder}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
        onKeyDown={handleKeyDown}
        autoComplete="off"
      />

      {open && (
        <div className="type-picker-dropdown" role="listbox">
          {results.length === 0 ? (
            <div className="type-picker-empty">No results</div>
          ) : (
            results.map((t, i) => (
              <button
                key={t.typeId}
                className={`type-picker-item${i === focusIdx ? " focused" : ""}`}
                role="option"
                onMouseDown={(e) => { e.preventDefault(); handleSelect(t); }}
              >
                <TypeIcon typeId={t.typeId} variant="icon" size={32} displaySize={20} />
                <span className="type-picker-item-name">{t.typeName}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
