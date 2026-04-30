import { useState } from "react";
import "./TypeIcon.css";

// ─── CCP Image Server ─────────────────────────────────────────────────────────
// https://images.evetech.net/types/{typeId}/{variant}?size={size}
// No authentication required. Covered by CCP Developer License Agreement.
// © CCP hf. All rights reserved.

const IMAGE_BASE = "https://images.evetech.net/types";

export type ImageVariant = "icon" | "bp" | "render";
export type ImageSize = 32 | 64 | 128 | 256 | 512;

function imageUrl(typeId: number, variant: ImageVariant, size: ImageSize): string {
  return `${IMAGE_BASE}/${typeId}/${variant}?size=${size}`;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface TypeIconProps {
  typeId: number;
  /**
   * Which CCP image variant to request:
   * - "icon"   — inventory icon, exists for every published type
   * - "bp"     — blueprint version of the icon
   * - "render" — 3D render; ships/structures look great, falls back to "icon"
   *              automatically when the render doesn't exist
   */
  variant?: ImageVariant;
  size?: ImageSize;
  /** px value for the rendered square; defaults to the requested `size`. */
  displaySize?: number;
  alt?: string;
  className?: string;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Displays an item image from the CCP public image server.
 *
 * Render fallback chain:  render → icon → placeholder box
 * Icon  fallback chain:   icon   → placeholder box
 */
export function TypeIcon({
  typeId,
  variant = "icon",
  size = 64,
  displaySize,
  alt = "",
  className = "",
}: TypeIconProps) {
  const px = displaySize ?? size;

  // Track which variant we're currently trying.
  const [currentVariant, setCurrentVariant] = useState<ImageVariant>(variant);
  const [status, setStatus] = useState<"loading" | "loaded" | "error">("loading");

  const src = imageUrl(typeId, currentVariant, size);

  function handleLoad() {
    setStatus("loaded");
  }

  function handleError() {
    if (currentVariant === "render") {
      // Render doesn't exist for this type — fall back to icon.
      setCurrentVariant("icon");
      setStatus("loading");
    } else {
      // Nothing left to try.
      setStatus("error");
    }
  }

  return (
    <div
      className={`type-icon${status === "loading" ? " loading" : ""} ${className}`.trim()}
      style={{ width: px, height: px }}
    >
      {status === "error" ? (
        <div className="type-icon-fallback" aria-hidden="true">?</div>
      ) : (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className={status === "loaded" ? "loaded" : ""}
          onLoad={handleLoad}
          onError={handleError}
        />
      )}
    </div>
  );
}
