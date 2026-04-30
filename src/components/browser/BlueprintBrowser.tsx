import { useCallback, useEffect, useRef, useState } from "react";
import {
  browseBlueprints,
  getIndustryCategories,
  getIndustryGroups,
} from "../../api";
import type { BlueprintEntry, IndustryCategory, IndustryGroup } from "../../api";
import { usePlanStore, useSdeStore } from "../../store";
import type { TypeId } from "../../api";
import { TypeIcon } from "../common";
import "./BlueprintBrowser.css";

// ─── Types ────────────────────────────────────────────────────────────────────

interface AddedState {
  typeId: TypeId;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Component ────────────────────────────────────────────────────────────────

export function BlueprintBrowser() {
  const sdeAvailable = useSdeStore((s) => s.available);
  const addTarget    = usePlanStore((s) => s.addTarget);
  const activePlan   = usePlanStore((s) => s.activePlan);  // null = new unsaved plan

  // ── Nav state ─────────────────────────────────────────────────────────────
  const [categories, setCategories]         = useState<IndustryCategory[]>([]);
  const [groups, setGroups]                 = useState<IndustryGroup[]>([]);
  const [blueprints, setBlueprints]         = useState<BlueprintEntry[]>([]);

  const [selectedCat, setSelectedCat]       = useState<number | null>(null);
  const [selectedGroup, setSelectedGroup]   = useState<number | null>(null);

  // ── Filter state ──────────────────────────────────────────────────────────
  const [search, setSearch]                 = useState("");
  const [ownedOnly, setOwnedOnly]           = useState(false);

  // ── Loading / errors ─────────────────────────────────────────────────────
  const [loadingCats, setLoadingCats]       = useState(false);
  const [loadingGroups, setLoadingGroups]   = useState(false);
  const [fetchError, setFetchError]         = useState<string | null>(null);
  const [loadingBps, setLoadingBps]         = useState(false);

  // ── Add-to-plan flash ─────────────────────────────────────────────────────
  const [added, setAdded]                   = useState<AddedState | null>(null);
  const addedRef                            = useRef<AddedState | null>(null);

  // ── Quantities ────────────────────────────────────────────────────────────
  const [quantities, setQuantities]         = useState<Record<TypeId, number>>({});

  // ── Search debounce ───────────────────────────────────────────────────────
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState("");

  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); };
  }, [search]);

  // ── Load categories on mount ──────────────────────────────────────────────
  useEffect(() => {
    if (!sdeAvailable) return;
    setLoadingCats(true);
    setFetchError(null);
    getIndustryCategories()
      .then(setCategories)
      .catch((e) => setFetchError(String(e)))
      .finally(() => setLoadingCats(false));
  }, [sdeAvailable]);

  // ── Load groups when category changes ────────────────────────────────────
  useEffect(() => {
    setSelectedGroup(null);
    setGroups([]);
    if (selectedCat === null) return;
    setLoadingGroups(true);
    getIndustryGroups(selectedCat)
      .then(setGroups)
      .finally(() => setLoadingGroups(false));
  }, [selectedCat]);

  // ── Load blueprints when filters change ──────────────────────────────────
  const loadBlueprints = useCallback(() => {
    if (!sdeAvailable) return;
    // Need at least a category, search, or ownedOnly to show results.
    if (selectedCat === null && !debouncedSearch.trim() && !ownedOnly) {
      setBlueprints([]);
      return;
    }
    setLoadingBps(true);
    browseBlueprints({
      categoryId: selectedCat,
      groupId: selectedGroup,
      query: debouncedSearch.trim() || null,
      ownedOnly,
    })
      .then(setBlueprints)
      .catch((e) => setFetchError(String(e)))
      .finally(() => setLoadingBps(false));
  }, [sdeAvailable, selectedCat, selectedGroup, debouncedSearch, ownedOnly]);

  useEffect(() => { loadBlueprints(); }, [loadBlueprints]);

  // ── Add to plan ───────────────────────────────────────────────────────────
  function handleAdd(entry: BlueprintEntry) {
    const qty = quantities[entry.productTypeId] ?? 1;
    addTarget({ typeId: entry.productTypeId, quantity: Math.max(1, qty), structureProfileId: null });

    // Flash confirmation.
    if (addedRef.current?.timer) clearTimeout(addedRef.current.timer);
    const timer = setTimeout(() => {
      setAdded(null);
      addedRef.current = null;
    }, 1500);
    const state: AddedState = { typeId: entry.productTypeId, timer };
    addedRef.current = state;
    setAdded(state);
  }

  function setQty(typeId: TypeId, val: string) {
    const n = parseInt(val, 10);
    setQuantities((q) => ({ ...q, [typeId]: isNaN(n) || n < 1 ? 1 : n }));
  }

  if (!sdeAvailable) {
    return (
      <div className="bp-browser">
        <div className="bp-empty">
          <span>SDE not available.</span>
          <span>Download the EVE static data to browse blueprints.</span>
        </div>
      </div>
    );
  }

  const searchActive = debouncedSearch.trim().length > 0;

  return (
    <div className="bp-browser">
      {/* Top bar */}
      <div className="bp-browser-bar">
        <div className="bp-browser-search">
          <input
            type="search"
            placeholder="Search by item or blueprint name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <label className="bp-browser-toggle" title="Show only blueprints you own — populated from your last ESI character sync">
          <input
            type="checkbox"
            checked={ownedOnly}
            onChange={(e) => setOwnedOnly(e.target.checked)}
          />
          Owned only
        </label>

        {!activePlan && (
          <span className="bp-browser-count" title="Items will be added to a new unsaved plan — save with Ctrl+S">
            New plan (unsaved)
          </span>
        )}

        {blueprints.length > 0 && (
          <span className="bp-browser-count">
            {blueprints.length} blueprint{blueprints.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {fetchError && (
        <div className="bp-error">
          Failed to load blueprints — {fetchError}
        </div>
      )}

      {/* 3-column body */}
      <div className="bp-browser-body">
        {/* Column 1 — categories */}
        <div className="bp-col">
          <div className="bp-col-header">Category</div>
          <div className="bp-col-list">
            {loadingCats ? (
              <div className="bp-loading">Loading…</div>
            ) : (
              categories.map((cat) => (
                <button
                  key={cat.categoryId}
                  className={`bp-nav-item${selectedCat === cat.categoryId ? " active" : ""}`}
                  onClick={() => {
                    setSelectedCat(
                      selectedCat === cat.categoryId ? null : cat.categoryId,
                    );
                    setSearch("");
                  }}
                >
                  <span className="bp-nav-item-name">{cat.categoryName}</span>
                  <span className="bp-nav-item-count">{cat.blueprintCount}</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Column 2 — groups */}
        <div className="bp-col">
          <div className="bp-col-header">Group</div>
          <div className="bp-col-list">
            {loadingGroups ? (
              <div className="bp-loading">Loading…</div>
            ) : selectedCat === null ? (
              <div className="bp-empty" style={{ height: "auto", padding: "var(--sp-4)" }}>
                Select a category
              </div>
            ) : groups.length === 0 ? (
              <div className="bp-empty" style={{ height: "auto", padding: "var(--sp-4)" }}>
                No groups found
              </div>
            ) : (
              groups.map((grp) => (
                <button
                  key={grp.groupId}
                  className={`bp-nav-item${selectedGroup === grp.groupId ? " active" : ""}`}
                  onClick={() =>
                    setSelectedGroup(
                      selectedGroup === grp.groupId ? null : grp.groupId,
                    )
                  }
                >
                  <span className="bp-nav-item-name">{grp.groupName}</span>
                  <span className="bp-nav-item-count">{grp.blueprintCount}</span>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Column 3 — blueprint cards */}
        <div className="bp-col">
          <div className="bp-col-header">
            Blueprints
            {searchActive && ` — "${debouncedSearch}"`}
          </div>
          <div className="bp-results">
            {loadingBps ? (
              <div className="bp-loading">Loading…</div>
            ) : blueprints.length === 0 ? (
              <div className="bp-empty">
                {selectedCat === null && !searchActive && !ownedOnly
                  ? <>
                      <span>Select a category on the left,</span>
                      <span>search by name, or enable Owned only.</span>
                    </>
                  : <span>No blueprints found.</span>
                }
              </div>
            ) : (
              blueprints.map((entry) => (
                <BlueprintCard
                  key={entry.blueprintTypeId}
                  entry={entry}
                  isAdded={added?.typeId === entry.productTypeId}
                  quantity={quantities[entry.productTypeId] ?? 1}
                  onQtyChange={(v) => setQty(entry.productTypeId, v)}
                  onAdd={() => handleAdd(entry)}
                  canAdd={true}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Blueprint card ───────────────────────────────────────────────────────────

interface CardProps {
  entry: BlueprintEntry;
  isAdded: boolean;
  quantity: number;
  onQtyChange: (val: string) => void;
  onAdd: () => void;
  canAdd: boolean;
}

function BlueprintCard({ entry, isAdded, quantity, onQtyChange, onAdd, canAdd }: CardProps) {
  const isOwned    = entry.ownership.length > 0;
  const isReaction = entry.activityId === 11;

  return (
    <div className={`bp-card${isOwned ? " owned" : ""}`}>
      <TypeIcon
        typeId={entry.productTypeId}
        variant="render"
        size={64}
        displaySize={48}
        alt={entry.productName}
      />

      <div className="bp-card-info">
        <div className="bp-card-product">{entry.productName}</div>
        <div className="bp-card-bp-name">{entry.blueprintName}</div>

        <div className="bp-card-meta">
          {isOwned ? (
            <span className="bp-badge owned">Owned</span>
          ) : (
            <span className="bp-badge unowned">Not owned</span>
          )}

          {isReaction && (
            <span className="bp-badge reaction">Reaction</span>
          )}

          {isOwned && entry.ownership.map((o) => {
            const isBpo = o.runs === -1;
            return (
              <span
                key={`${o.characterId}`}
                className={`bp-badge ${isBpo ? "bpo" : "bpc"}`}
                title={isBpo
                  ? `${o.characterName} owns the original blueprint (BPO). Can be copied and researched for ME/TE.`
                  : `${o.characterName} owns a blueprint copy (BPC) with ${o.runs} run${o.runs !== 1 ? "s" : ""} remaining. Cannot be researched.`}
              >
                {isBpo ? "BPO" : `BPC ×${o.runs}`} · ME{o.meLevel} TE{o.teLevel}
              </span>
            );
          })}
        </div>

        {isOwned && entry.ownership.length > 1 && (
          <div className="bp-ownership-list">
            {entry.ownership.map((o) => (
              <div key={o.characterId} className="bp-ownership-row">
                <span className="bp-ownership-char">{o.characterName}: </span>
                {o.runs === -1 ? "BPO" : `BPC ${o.runs} runs`} · ME{o.meLevel}/TE{o.teLevel}
              </div>
            ))}
          </div>
        )}
      </div>

      {canAdd && (
        <div className="bp-card-actions">
          <input
            className="bp-qty-input"
            type="number"
            min={1}
            value={quantity}
            onChange={(e) => onQtyChange(e.target.value)}
            title="Quantity to build"
          />
          <button
            className={`bp-add-btn${isAdded ? " added" : ""}`}
            onClick={onAdd}
          >
            {isAdded ? "✓ Added" : "+ Add to plan"}
          </button>
        </div>
      )}
    </div>
  );
}
