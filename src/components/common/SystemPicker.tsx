// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { searchSolarSystems } from "../../api";
import type { SystemSearchResult } from "../../api";
import { esiErrorMessage } from "../../lib/format";
// Reuses TypePicker's CSS — same dropdown structure.
import "./TypePicker.css";

interface SystemPickerProps {
  placeholder?: string;
  /** Called when the user selects a system. */
  onSelect: (system: SystemSearchResult) => void;
  /** If set, shows this name in the input as the current value (controlled display). */
  currentName?: string | null;
}

export function SystemPicker({
  placeholder = "Search solar system…",
  onSelect,
  currentName,
}: SystemPickerProps) {
  const [query, setQuery]       = useState(currentName ?? "");
  const [results, setResults]   = useState<SystemSearchResult[]>([]);
  const [open, setOpen]         = useState(false);
  const [focusIdx, setFocusIdx] = useState(-1);
  const [searchError, setSearchError] = useState<string | null>(null);

  const inputRef     = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep input in sync if parent changes currentName (e.g. after loading saved profile).
  useEffect(() => {
    if (currentName !== undefined && currentName !== null) {
      setQuery(currentName);
    }
  }, [currentName]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim() || query === currentName) {
      setResults([]);
      setSearchError(null);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearchError(null);
      try {
        const res = await searchSolarSystems(query);
        setResults(res);
        setOpen(true); // always open so user sees "no results" instead of nothing
        setFocusIdx(-1);
      } catch (e: unknown) {
        setResults([]);
        setSearchError(esiErrorMessage(e));
        setOpen(true);
      }
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, currentName]);

  useEffect(() => {
    let downOutside = false;
    function onDown(e: MouseEvent) {
      downOutside = !(containerRef.current?.contains(e.target as Node) ?? false);
    }
    function onUp(e: MouseEvent) {
      if (downOutside && !(containerRef.current?.contains(e.target as Node) ?? false)) {
        setOpen(false);
        setSearchError(null);
        if (currentName !== undefined && currentName !== null) setQuery(currentName);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
    };
  }, [currentName]);

  function handleSelect(s: SystemSearchResult) {
    setQuery(s.systemName);
    setResults([]);
    setSearchError(null);
    setOpen(false);
    onSelect(s);
    inputRef.current?.blur();
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
      if (currentName !== undefined && currentName !== null) setQuery(currentName);
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
          {searchError ? (
            <div className="type-picker-empty" style={{ color: "var(--red)" }}
              title={searchError}>
              ESI search unavailable — check connection
            </div>
          ) : results.length === 0 ? (
            <div className="type-picker-empty">No systems found</div>
          ) : (
            results.map((s, i) => (
              <button
                key={s.systemId}
                className={`type-picker-item${i === focusIdx ? " focused" : ""}`}
                role="option"
                onMouseDown={(e) => { e.preventDefault(); handleSelect(s); }}
              >
                <span className="type-picker-item-name">{s.systemName}</span>
                <span style={{ fontSize: 10, color: "var(--text-3)", marginLeft: "auto" }}>
                  #{s.systemId}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}