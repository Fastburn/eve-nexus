import { useSettingsStore, useUiStore } from "../../store";
import "./ConsentDialog.css";

export function ConsentDialog() {
  const show        = useUiStore((s) => s.showConsentDialog);
  const hideDialog  = useUiStore((s) => s.setConsentDialog);
  const setConsent  = useSettingsStore((s) => s.setConsent);

  if (!show) return null;

  async function handleAccept() {
    await setConsent("Granted");
    hideDialog(false);
  }

  async function handleDecline() {
    await setConsent("Denied");
    hideDialog(false);
  }

  return (
    <div className="consent-backdrop" role="dialog" aria-modal="true" aria-labelledby="consent-title">
      <div className="consent-dialog">
        <h2 className="consent-title" id="consent-title">
          Help improve Eve Nexus
        </h2>

        <div className="consent-body">
          <p>
            Eve Nexus can send <strong>anonymous usage data</strong> to help
            prioritise development. No personal information, character names, or
            plan contents are ever collected.
          </p>
          <p>
            Data is sent via{" "}
            <strong>Plausible Analytics</strong> (privacy-friendly, no
            cookies). You can change this at any time in Settings.
          </p>
        </div>

        <div className="consent-actions">
          <button className="consent-decline" onClick={handleDecline}>
            No thanks
          </button>
          <button className="consent-accept" onClick={handleAccept}>
            Allow anonymous analytics
          </button>
        </div>
      </div>
    </div>
  );
}
