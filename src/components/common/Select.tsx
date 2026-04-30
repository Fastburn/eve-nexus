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
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
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
