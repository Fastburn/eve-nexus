import { useSdeStore, useUiStore } from "../../store";
import "./SdeBanner.css";

export function SdeBanner() {
  const show        = useUiStore((s) => s.showSdeBanner);
  const dismiss     = useUiStore((s) => s.setSdeBanner);

  const updateInProgress  = useSdeStore((s) => s.updateInProgress);
  const downloadProgress  = useSdeStore((s) => s.downloadProgress);
  const importProgress    = useSdeStore((s) => s.importProgress);
  const lastResult        = useSdeStore((s) => s.lastResult);
  const triggerUpdate     = useSdeStore((s) => s.triggerUpdate);

  // Auto-hide on successful update.
  if (lastResult?.status === "updated" && show) {
    dismiss(false);
    return null;
  }

  if (!show) return null;

  const isDownloading = updateInProgress && downloadProgress !== null;
  const isImporting   = updateInProgress && importProgress !== null;

  return (
    <div className="sde-banner" role="status" aria-live="polite">
      {isDownloading ? (
        <div className="sde-banner-progress">
          <div className="sde-banner-progress-label">
            <span>Downloading EVE SDE…</span>
            <span>
              {downloadProgress!.bytesTotal
                ? `${Math.round((downloadProgress!.bytesReceived / downloadProgress!.bytesTotal) * 100)}%`
                : "…"}
            </span>
          </div>
          <div className="sde-banner-progress-bar">
            <div
              className="sde-banner-progress-fill"
              style={{
                width: downloadProgress!.bytesTotal
                  ? `${(downloadProgress!.bytesReceived / downloadProgress!.bytesTotal) * 100}%`
                  : "0%",
              }}
            />
          </div>
        </div>
      ) : isImporting ? (
        <div className="sde-banner-progress">
          <div className="sde-banner-progress-label">
            <span>Importing {importProgress!.table}…</span>
            <span>
              {importProgress!.tablesDone}/{importProgress!.tablesTotal}
            </span>
          </div>
          <div className="sde-banner-progress-bar">
            <div
              className="sde-banner-progress-fill"
              style={{
                width: `${(importProgress!.tablesDone / importProgress!.tablesTotal) * 100}%`,
              }}
            />
          </div>
        </div>
      ) : lastResult?.status === "failed" ? (
        <p className="sde-banner-text">
          <strong>Download failed.</strong>{" "}
          {lastResult.reason} Try again or dismiss to continue without item names.
        </p>
      ) : (
        <p className="sde-banner-text">
          <strong>Static Data (SDE) not found.</strong>{" "}
          Eve Nexus needs the EVE SDE to look up item types, materials, and
          blueprints. Download it now (≈ 30 MB).
        </p>
      )}

      <div className="sde-banner-actions">
        {!updateInProgress && (
          <button
            className="sde-banner-dl-btn"
            onClick={triggerUpdate}
            disabled={updateInProgress}
          >
            {lastResult?.status === "failed" ? "Try again" : "Download"}
          </button>
        )}
        {!updateInProgress && (
          <button
            className="sde-banner-dismiss"
            onClick={() => dismiss(false)}
            title="Dismiss (some features will be unavailable)"
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}
