// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import "./TypeIcon.css";

// ─── CCP Image Server ─────────────────────────────────────────────────────────
// https://images.evetech.net/types/{typeId}/{variant}?size={size}
// No authentication required. Covered by CCP Developer License Agreement.
// © CCP hf. All rights reserved.

const IMAGE_BASE = "https://images.evetech.net/types";

export type ImageVariant = "icon" | "bp" | "bpc" | "render";
export type ImageSize = 32 | 64 | 128 | 256 | 512;

function imageUrl(typeId: number, variant: ImageVariant, size: ImageSize): string {
  return `${IMAGE_BASE}/${typeId}/${variant}?size=${size}`;
}

const BLUEPRINT_CATEGORY_ID = 9;

/**
 * Blueprints (categoryId 9) have no "icon" image on CCP's image server — only
 * "bp" (original) or "bpc" (copy). Pick the right variant for a build-tree node
 * so it doesn't fall all the way through the fallback chain to a "?" placeholder.
 */
export function blueprintIconVariant(node: {
  categoryId: number;
  kind: { type: string; maxRuns?: number | null };
}): ImageVariant {
  if (node.categoryId !== BLUEPRINT_CATEGORY_ID) return "icon";
  const isCopy = node.kind.type === "invention" || (node.kind.type === "manufacturing" && node.kind.maxRuns != null);
  return isCopy ? "bpc" : "bp";
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface TypeIconProps {
  typeId: number;
  /**
   * Which CCP image variant to request:
   * - "icon"   — inventory icon, exists for every published type
   * - "bp"     — blueprint original icon
   * - "bpc"    — blueprint copy icon
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
 * Fallback chain: render/bp/bpc → icon → placeholder box
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
    if (currentVariant !== "icon") {
      // render/bp/bpc don't exist for every type — fall back to icon.
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