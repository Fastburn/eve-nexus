import { useState } from "react";
import { setWizardCompleted } from "../../api/settings";
import { useCharactersStore, useSettingsStore } from "../../store";
import logo from "../../assets/eve-nexus-sidebar.png";
import "./FirstRunWizard.css";

const TOTAL_STEPS = 5;

interface Props {
  onComplete: () => void;
}

export function FirstRunWizard({ onComplete }: Props) {
  const [step, setStep] = useState(0);
  const [adding, setAdding]   = useState(false);

  const characters  = useCharactersStore((s) => s.characters);
  const addChar     = useCharactersStore((s) => s.add);
  const setConsent  = useSettingsStore((s) => s.setConsent);

  async function handleAddCharacter() {
    setAdding(true);
    try { await addChar(); } catch { /* user closed browser, ignore */ }
    finally { setAdding(false); }
  }

  async function handleAnalytics(granted: boolean) {
    await setConsent(granted ? "Granted" : "Denied");
    await finish();
  }

  async function finish() {
    await setWizardCompleted();
    onComplete();
  }

  function next() { setStep((s) => Math.min(s + 1, TOTAL_STEPS - 1)); }
  function back() { setStep((s) => Math.max(s - 1, 0)); }

  return (
    <div className="wizard-backdrop" role="dialog" aria-modal="true">
      <div className="wizard-card">
        {/* Header */}
        <div className="wizard-header">
          <img src={logo} alt="Eve Nexus" className="wizard-logo" />
          <div className="wizard-steps">
            {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
              <div
                key={i}
                className={`wizard-step-dot${i === step ? " active" : i < step ? " done" : ""}`}
              />
            ))}
          </div>
        </div>

        {/* Step content */}
        {step === 0 && <StepWelcome onNext={next} />}
        {step === 1 && (
          <StepCharacter
            characters={characters}
            adding={adding}
            onAdd={handleAddCharacter}
            onNext={next}
            onBack={back}
          />
        )}
        {step === 2 && <StepStructure onNext={next} onBack={back} />}
        {step === 3 && <StepMarket onNext={next} onBack={back} />}
        {step === 4 && <StepAnalytics onAccept={() => handleAnalytics(true)} onDecline={() => handleAnalytics(false)} onBack={back} />}
      </div>
    </div>
  );
}

// ── Steps ─────────────────────────────────────────────────────────────────────

function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <>
      <div className="wizard-body">
        <div className="wizard-step-title">Welcome to Eve Nexus</div>
        <div className="wizard-step-body">
          <p>
            Eve Nexus is a <strong>local-first industry planning tool</strong> for EVE Online.
            It connects to your characters via ESI and builds a complete picture of your
            production chain including materials, blueprints, active jobs, market prices, and costs.
          </p>
          <p>
            This wizard takes about two minutes and gets you set up with the basics.
            Everything can be changed later in Settings.
          </p>
        </div>
      </div>
      <div className="wizard-footer">
        <span />
        <div className="wizard-nav">
          <button className="wizard-next" onClick={onNext}>Get started</button>
        </div>
      </div>
    </>
  );
}

function StepCharacter({
  characters, adding, onAdd, onNext, onBack,
}: {
  characters: { characterId: number; characterName: string }[];
  adding: boolean;
  onAdd: () => void;
  onNext: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <div className="wizard-body">
        <div className="wizard-step-title">Link your character</div>
        <div className="wizard-step-body">
          <p>
            Connect your EVE character via <strong>ESI</strong> so Eve Nexus can read your
            blueprints, assets, skills, and active jobs. This happens through the official
            EVE Online login. Your password is never shared with Eve Nexus.
          </p>
          {characters.length > 0 && characters.map((c) => (
            <div key={c.characterId} className="wizard-char-row">
              <img
                className="wizard-char-portrait"
                src={`https://images.evetech.net/characters/${c.characterId}/portrait?size=64`}
                alt={c.characterName}
              />
              <span className="wizard-char-name">{c.characterName}</span>
              <span className="wizard-char-check">✓</span>
            </div>
          ))}
          <button className="wizard-add-btn" onClick={onAdd} disabled={adding}>
            {adding ? "Opening browser…" : characters.length > 0 ? "+ Add another" : "+ Add character"}
          </button>
        </div>
      </div>
      <div className="wizard-footer">
        <button className="wizard-skip" onClick={onNext}>Skip for now</button>
        <div className="wizard-nav">
          <button className="wizard-back" onClick={onBack}>Back</button>
          <button className="wizard-next" onClick={onNext}>
            {characters.length > 0 ? "Next" : "Skip"}
          </button>
        </div>
      </div>
    </>
  );
}

function StepStructure({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return (
    <>
      <div className="wizard-body">
        <div className="wizard-step-title">Where do you manufacture?</div>
        <div className="wizard-step-body">
          <p>
            Eve Nexus uses <strong>Structure Profiles</strong> to calculate accurate job costs.
            Each profile stores your structure's location, facility tax, and rig bonuses.
          </p>
          <p>
            You can set these up now in Settings → Structure Profiles, or skip and add them
            later. Without a profile, job costs will show as unavailable until one is configured.
          </p>
        </div>
      </div>
      <div className="wizard-footer">
        <button className="wizard-skip" onClick={onNext}>Skip for now</button>
        <div className="wizard-nav">
          <button className="wizard-back" onClick={onBack}>Back</button>
          <button className="wizard-next" onClick={onNext}>Next</button>
        </div>
      </div>
    </>
  );
}

function StepMarket({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return (
    <>
      <div className="wizard-body">
        <div className="wizard-step-title">Market hubs</div>
        <div className="wizard-step-body">
          <p>
            Eve Nexus fetches live market prices from your configured hubs to power
            buy-vs-build analysis, profitability calculations, and restock planning.
          </p>
          <p>
            <strong>Jita (The Forge)</strong> is set as your default hub. You can add
            Amarr, Dodixie, or null-sec structure markets in Settings → Market Hubs.
          </p>
          <p>
            Sync your characters after setup to pull the first round of prices.
          </p>
        </div>
      </div>
      <div className="wizard-footer">
        <span />
        <div className="wizard-nav">
          <button className="wizard-back" onClick={onBack}>Back</button>
          <button className="wizard-next" onClick={onNext}>Next</button>
        </div>
      </div>
    </>
  );
}

function StepAnalytics({
  onAccept, onDecline, onBack,
}: {
  onAccept: () => void;
  onDecline: () => void;
  onBack: () => void;
}) {
  return (
    <>
      <div className="wizard-body">
        <div className="wizard-step-title">Help improve Eve Nexus</div>
        <div className="wizard-step-body">
          <p>
            Opt in to send an anonymous ping each time you launch the app. This tells us:
          </p>
          <ul>
            <li>How many people are actively using Eve Nexus</li>
            <li>Which version is most in use</li>
            <li>Supports our EVE Partner Program application, helping fund continued development</li>
          </ul>
          <p>
            <strong>No personal data, character names, or plan contents are ever sent.</strong>{" "}
            You can change this at any time in Settings.
          </p>
          <div className="wizard-analytics-btns">
            <button className="wizard-analytics-yes" onClick={onAccept}>
              Yes, send anonymous data
            </button>
            <button className="wizard-analytics-no" onClick={onDecline}>
              No thanks
            </button>
          </div>
        </div>
      </div>
      <div className="wizard-footer">
        <span />
        <div className="wizard-nav">
          <button className="wizard-back" onClick={onBack}>Back</button>
        </div>
      </div>
    </>
  );
}
