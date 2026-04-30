import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useSdeStore } from "../../store/sde";
import { useCharactersStore } from "../../store/characters";
import { useMarketStore } from "../../store/market";

export function StatusBar() {
  const [version, setVersion] = useState<string>("");

  const sdeAvailable  = useSdeStore((s) => s.available);
  const sdeVersion    = useSdeStore((s) => s.version);

  const characters    = useCharactersStore((s) => s.characters);
  const esiRefreshing = useCharactersStore((s) => s.refreshing);
  const esiError      = useCharactersStore((s) => s.error);

  const marketFetching = useMarketStore((s) => s.fetching);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  const sdeOk = sdeAvailable && sdeVersion != null;

  // ESI dot: red if error, yellow if syncing, green if characters connected, muted if none
  const esiDot = esiError
    ? "shell-statusbar-dot-error"
    : esiRefreshing || marketFetching
    ? "shell-statusbar-dot-warn"
    : characters.length > 0
    ? "shell-statusbar-dot-ok"
    : "shell-statusbar-dot-muted";

  const esiLabel = esiError
    ? "ESI error"
    : esiRefreshing
    ? "ESI syncing…"
    : marketFetching
    ? "Prices fetching…"
    : characters.length > 0
    ? `${characters.length} character${characters.length !== 1 ? "s" : ""}`
    : "No characters";

  return (
    <div className="shell-statusbar">
      {/* ESI status */}
      <div className="shell-statusbar-item" title={esiError ?? undefined}>
        <span className={`shell-statusbar-dot ${esiDot}`} />
        <span>{esiLabel}</span>
      </div>

      {/* SDE status */}
      <div className="shell-statusbar-item">
        <span className={`shell-statusbar-dot ${sdeOk ? "shell-statusbar-dot-ok" : "shell-statusbar-dot-warn"}`} />
        <span>{sdeOk ? `SDE ${sdeVersion!.buildNumber}` : "SDE loading…"}</span>
      </div>

      {/* App version */}
      {version && (
        <div className="shell-statusbar-item">
          v{version}
        </div>
      )}
    </div>
  );
}
