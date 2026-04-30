/**
 * Boot sequence — called once from main.tsx before the root is mounted.
 *
 * Order matters:
 * 1. Settings (needed by analytics, solver defaults)
 * 2. SDE status (needed to decide whether to show the download banner)
 * 3. Characters (needed for ESI refresh)
 * 4. Plans (populate the sidebar plan list)
 *
 * UI flags (consent dialog, SDE banner, update banner) are set here based on
 * the loaded data so components render into the correct initial state without
 * an extra render cycle.
 */
import { checkForAppUpdate } from "../api";
import { getWizardCompleted } from "../api/settings";
import { useSdeStore } from "./sde";
import { useCharactersStore } from "./characters";
import { usePlanStore } from "./plan";
import { useSettingsStore } from "./settings";
import { useUiStore } from "./ui";
import { useMarketStore } from "./market";

export async function initApp(): Promise<void> {
  // Run non-dependent fetches in parallel.
  await Promise.all([
    useSettingsStore.getState().init(),
    useSdeStore.getState().init(),
    useCharactersStore.getState().fetch(),
    usePlanStore.getState().fetchPlans(),
    usePlanStore.getState().loadGlobalDefaults(),
    useMarketStore.getState().loadRegions(),
  ]);

  // Check wizard completion — show wizard for fresh installs and beta upgraders.
  // The wizard handles analytics consent, so suppress the old ConsentDialog when wizard is shown.
  const wizardCompleted = await getWizardCompleted();
  if (!wizardCompleted) {
    useUiStore.getState().setShowWizard(true);
  } else {
    // Wizard already done — show legacy consent dialog only if somehow still pending.
    const consent = useSettingsStore.getState().analyticsConsent;
    if (consent === "Pending") {
      useUiStore.getState().setConsentDialog(true);
    }
  }

  const sdeAvailable = useSdeStore.getState().available;
  if (!sdeAvailable) {
    useUiStore.getState().setSdeBanner(true);
  }

  // Check for app update in the background — don't block startup.
  checkForAppUpdate()
    .then((info) => {
      if (info) useUiStore.getState().setUpdateBanner(true);
    })
    .catch(() => {
      // Update check failing is non-fatal.
    });
}
