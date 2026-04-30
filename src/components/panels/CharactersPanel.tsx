import { useState } from "react";
import { useCharactersStore } from "../../store";
import { setCorpAssetsMode } from "../../api/characters";
import type { CharacterId } from "../../api";
import "./CharactersPanel.css";

const EVE_IMAGE = "https://images.evetech.net";

function CharacterPortrait({ characterId, name }: { characterId: CharacterId; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <div className="cp-portrait cp-portrait-fallback">{name[0]}</div>;
  }
  return (
    <img
      className="cp-portrait"
      src={`${EVE_IMAGE}/characters/${characterId}/portrait?size=64`}
      alt={name}
      width={36}
      height={36}
      onError={() => setFailed(true)}
    />
  );
}

export function CharactersPanel() {
  const characters  = useCharactersStore((s) => s.characters);
  const loading     = useCharactersStore((s) => s.loading);
  const refreshing  = useCharactersStore((s) => s.refreshing);
  const error       = useCharactersStore((s) => s.error);
  const add         = useCharactersStore((s) => s.add);
  const remove      = useCharactersStore((s) => s.remove);
  const refreshOne  = useCharactersStore((s) => s.refreshOne);
  const refreshAll  = useCharactersStore((s) => s.refreshAll);
  const fetchChars  = useCharactersStore((s) => s.fetch);

  const [adding, setAdding]                         = useState(false);
  const [addError, setAddError]                     = useState<string | null>(null);
  const [refreshingId, setRefreshingId]             = useState<CharacterId | null>(null);
  const [confirmRemoveId, setConfirmRemoveId]       = useState<CharacterId | null>(null);

  async function handleAdd() {
    setAdding(true);
    setAddError(null);
    try {
      await add();
    } catch (e) {
      setAddError(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function handleRefreshOne(characterId: CharacterId) {
    setRefreshingId(characterId);
    try {
      await refreshOne(characterId);
    } finally {
      setRefreshingId(null);
    }
  }

  async function handleRemove(characterId: CharacterId) {
    await remove(characterId);
    setConfirmRemoveId(null);
  }

  if (loading) {
    return (
      <div className="cp-loading">Loading characters…</div>
    );
  }

  return (
    <div className="cp">
      {/* ── Actions ── */}
      <div className="cp-actions">
        <button
          className="cp-add-btn"
          onClick={handleAdd}
          disabled={adding}
        >
          {adding ? "Opening browser…" : "+ Add Character"}
        </button>
        {characters.length > 1 && (
          <button
            className="cp-refresh-all-btn"
            onClick={refreshAll}
            disabled={refreshing}
            title="Refresh ESI data for all characters"
          >
            {refreshing ? "Refreshing…" : "↺ Refresh All"}
          </button>
        )}
      </div>

      {/* ── Errors ── */}
      {(addError || error) && (
        <div className="cp-error">{addError ?? error}</div>
      )}

      {/* ── Add hint ── */}
      {adding && (
        <div className="cp-hint">
          A browser window has opened — complete the EVE SSO login, then return here.
        </div>
      )}

      {/* ── Character list ── */}
      {characters.length === 0 ? (
        <div className="cp-empty">
          <span>No characters added yet.</span>
          <span>Click "+ Add Character" to link your EVE Online account via ESI.</span>
        </div>
      ) : (
        <div className="cp-list">
          {characters.map((c) => {
            const isRefreshing = refreshingId === c.characterId;
            const isConfirming = confirmRemoveId === c.characterId;
            return (
              <div key={c.characterId} className="cp-char-row">
                <CharacterPortrait characterId={c.characterId} name={c.characterName} />
                <div className="cp-char-info">
                  <span className="cp-char-name">{c.characterName}</span>
                  <span className="cp-char-id">#{c.characterId}</span>
                  {c.hasCorpAccess && (
                    <div className="cp-corp-mode" title="Choose which assets to include in your plans. Requires Director role for corp access.">
                      {(["personal", "both", "corp"] as const).map((m) => (
                        <button
                          key={m}
                          className={`cp-corp-btn${c.corpAssetsMode === m ? " active" : ""}`}
                          onClick={async () => {
                            await setCorpAssetsMode(c.characterId, m);
                            await fetchChars();
                          }}
                        >
                          {m === "personal" ? "Personal" : m === "corp" ? "Corp" : "Both"}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="cp-char-actions">
                  {isConfirming ? (
                    <>
                      <span className="cp-confirm-label">Remove?</span>
                      <button
                        className="cp-btn cp-btn-danger"
                        onClick={() => handleRemove(c.characterId)}
                      >
                        Yes
                      </button>
                      <button
                        className="cp-btn"
                        onClick={() => setConfirmRemoveId(null)}
                      >
                        No
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="cp-btn"
                        onClick={() => handleRefreshOne(c.characterId)}
                        disabled={isRefreshing || refreshing}
                        title="Refresh ESI data"
                      >
                        {isRefreshing ? "…" : "↺"}
                      </button>
                      <button
                        className="cp-btn cp-btn-remove"
                        onClick={() => setConfirmRemoveId(c.characterId)}
                        title="Remove character"
                      >
                        ×
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Footer note ── */}
      <div className="cp-footer-note">
        ESI data is cached and refreshed on demand. Tokens are stored securely in the OS keychain.
      </div>
    </div>
  );
}
