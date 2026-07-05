// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import "./Select.css";

interface Option {
  value: string;
  label: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  className?: string;
  title?: string;
}

export function Select({ value, onChange, options, className = "", title }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    let downOutside = false;
    function onDown(e: MouseEvent) {
      downOutside = !(ref.current?.contains(e.target as Node) ?? false);
    }
    function onUp(e: MouseEvent) {
      if (downOutside && !(ref.current?.contains(e.target as Node) ?? false)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("mouseup", onUp);
    };
  }, [open]);

  function pick(val: string) {
    onChange(val);
    setOpen(false);
  }

  return (
    <div
      ref={ref}
      className={`x-select ${className} ${open ? "open" : ""}`}
      title={title}
    >
      <button
        type="button"
        className="x-select-trigger"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
      >
        <span className="x-select-value">{selected?.label ?? value}</span>
        <span className="x-select-arrow" aria-hidden="true" />
      </button>

      {open && (
        <ul className="x-select-list" role="listbox">
          {options.map((o) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`x-select-option${o.value === value ? " selected" : ""}`}
              onMouseDown={() => pick(o.value)}
            >
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}