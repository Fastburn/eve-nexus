import { useEffect, useState } from "react";
import { installAppUpdate, onAppUpdateProgress } from "../../api";
import type { AppUpdateProgress } from "../../api";
import { useUiStore } from "../../store";
import "./UpdateBanner.css";

export function UpdateBanner() {
  const show       = useUiStore((s) => s.showUpdateBanner);
  const setShow    = useUiStore((s) => s.setUpdateBanner);

  const [installing, setInstalling]     = useState(false);
  const [progress, setProgress]         = useState<AppUpdateProgress | null>(null);

  useEffect(() => {
    if (!show) return;
    let unlisten: (() => void) | null = null;
    onAppUpdateProgress((p) => setProgress(p)).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [show]);

  if (!show) return null;

  async function handleInstall() {
    setInstalling(true);
    try {
      await installAppUpdate();
      // App will relaunch automatically after install.
    } catch {
      setInstalling(false);
    }
  }

  const pct =
    progress && progress.bytesTotal
      ? Math.round((progress.bytesReceived / progress.bytesTotal) * 100)
      : null;

  return (
    <div className="update-banner" role="status" aria-live="polite">
      {installing && progress ? (
        <div className="update-banner-progress">
          <div className="update-banner-progress-label">
            <span>Downloading update…</span>
            <span>{pct}%</span>
          </div>
          <div className="update-banner-progress-bar">
            <div
              className="update-banner-progress-fill"
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      ) : installing ? (
        <p className="update-banner-text">Installing update — app will restart shortly…</p>
      ) : (
        <p className="update-banner-text">
          <strong>Update available.</strong> A new version of Eve Nexus is ready to install.
        </p>
      )}

      <div className="update-banner-actions">
        {!installing && (
          <>
            <button
              className="update-banner-install-btn"
              onClick={handleInstall}
            >
              Install &amp; Restart
            </button>
            <button
              className="update-banner-dismiss"
              onClick={() => setShow(false)}
              title="Remind me later"
            >
              Later
            </button>
          </>
        )}
      </div>
    </div>
  );
}
