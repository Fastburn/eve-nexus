// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useUiStore, useSdeStore } from "../../store";
import logo from "../../assets/eve-nexus-sidebar.png";
import "./AboutDialog.css";

export function AboutDialog() {
  const show      = useUiStore((s) => s.showAbout);
  const setShow   = useUiStore((s) => s.setShowAbout);
  const sdeVersion = useSdeStore((s) => s.version);
  const [version, setVersion] = useState<string>("");
  const [tab, setTab] = useState<"about" | "changelog">("about");

  useEffect(() => {
    if (show) {
      getVersion().then(setVersion).catch(() => {});
    } else {
      setTab("about");
    }
  }, [show]);

  if (!show) return null;

  return (
    <div
      className="about-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="about-title"
      onClick={(e) => { if (e.target === e.currentTarget) setShow(false); }}
    >
      <div className="about-dialog">
        <div className="about-dialog-scroll">
          <div className="about-header">
            <img src={logo} alt="Eve Nexus" className="about-logo-img" />
            <div className="about-versions">
              {version && <span className="about-version">Eve Nexus v{version}</span>}
              {sdeVersion && (
                <span className="about-version">
                  SDE build {sdeVersion.buildNumber}
                  {" · "}{new Date(sdeVersion.releaseDate).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>

          <div className="about-tabs">
            <button
              className={`about-tab${tab === "about" ? " active" : ""}`}
              onClick={() => setTab("about")}
            >
              About
            </button>
            <button
              className={`about-tab${tab === "changelog" ? " active" : ""}`}
              onClick={() => setTab("changelog")}
            >
              What's New
            </button>
          </div>

          {tab === "changelog" && <ChangelogTab />}

          {tab === "about" && (
          <div className="about-body">
            <p>
              Eve Nexus is a local-first industry planning tool for EVE Online.
            </p>

            <div className="about-maintainer">
              <span className="about-maintainer-label">Maintainer / Creator</span>
              <span className="about-maintainer-name">Fastburn</span>
            </div>

            <div className="about-oss">
              <div className="about-oss-title">Open Source Components</div>
              <div className="about-oss-group">
                <span className="about-oss-group-label">Frontend</span>
                <div className="about-oss-list">
                  <OssEntry name="React" version="19" license="MIT" />
                  <OssEntry name="Zustand" version="5" license="MIT" />
                  <OssEntry name="@xyflow/react" version="12" license="MIT" />
                  <OssEntry name="Tauri API" version="2" license="MIT / Apache-2.0" />
                  <OssEntry name="Vite" version="7" license="MIT" />
                </div>
              </div>
              <div className="about-oss-group">
                <span className="about-oss-group-label">Backend</span>
                <div className="about-oss-list">
                  <OssEntry name="Tauri" version="2" license="MIT / Apache-2.0" />
                  <OssEntry name="Tokio" version="1" license="MIT" />
                  <OssEntry name="rusqlite" version="0.32" license="MIT" />
                  <OssEntry name="reqwest" version="0.12" license="MIT / Apache-2.0" />
                  <OssEntry name="serde" version="1" license="MIT / Apache-2.0" />
                  <OssEntry name="chrono" version="0.4" license="MIT / Apache-2.0" />
                  <OssEntry name="keyring" version="3" license="MIT / Apache-2.0" />
                  <OssEntry name="sha2" version="0.10" license="MIT / Apache-2.0" />
                  <OssEntry name="zip" version="2" license="MIT" />
                  <OssEntry name="rand" version="0.8" license="MIT / Apache-2.0" />
                  <OssEntry name="base64" version="0.22" license="MIT / Apache-2.0" />
                </div>
              </div>
            </div>

            <div className="about-legal">
              <p>
                EVE Online and all related content are the property of CCP hf.
                EVE Online, the EVE logo, EVE and all associated logos and designs
                are the intellectual property of CCP hf. All artwork, screenshots,
                characters, vehicles, storylines, world facts or other recognizable
                features of the intellectual property relating to these trademarks
                are likewise the intellectual property of CCP hf.
              </p>
              <p>
                Eve Nexus is not affiliated with or endorsed by CCP hf. Use of
                EVE&apos;s intellectual property is permitted under the{" "}
                <strong>CCP Developer License Agreement (DLA)</strong>.
              </p>
              <p>
                In-game item images are provided by the{" "}
                <strong>EVE Image Server</strong> operated by CCP hf and are used
                in accordance with CCP&apos;s image use policy.
              </p>
              <p>
                Character and market data are retrieved via the{" "}
                <strong>EVE Swagger Interface (ESI)</strong>, the official EVE
                Online REST API.
              </p>
            </div>
          </div>
          )}
        </div>

        <div className="about-dialog-footer">
          <div className="about-bugreport">
            Found a bug?{" "}
            <a href="https://github.com/fastburn/eve-nexus/issues" target="_blank" rel="noopener" className="about-bugreport-link">
              GitHub Issues
            </a>
            {" · "}
            <a href="https://discord.gg/U8dVEWdDBM" target="_blank" rel="noopener" className="about-bugreport-link">
              Discord
            </a>
          </div>
          <div className="about-markee">
            Support the project by shopping at{" "}
            <a href="https://store.markeedragon.com/affiliate.php?id=1211&redirect=index.php?cat=4" target="_blank" rel="noopener" className="about-bugreport-link">
              Markee Dragon
            </a>
            {" "}and saving 3%. Discount applies via the link, or use code <strong>NEXUS</strong> at checkout.
          </div>
          <div className="about-license">
            Released under the <strong>GNU Affero General Public License v3.0 (AGPL-3.0)</strong> · Copyright © 2026 Fastburn
          </div>
          <button className="about-close" onClick={() => setShow(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function ChangelogTab() {
  return (
    <div className="about-changelog">
      <div className="about-changelog-version">
        <span className="about-changelog-tag">0.0.2</span>
        <span className="about-changelog-date">2026-05-14</span>
      </div>
      <p className="about-changelog-summary">7 new features · 11 bug fixes · 1 change</p>

      <div className="about-changelog-section">What's New</div>
      <ul className="about-changelog-list">
        <li>Multi-account support — adding a second EVE account now works reliably. The login screen always prompts fresh so you can sign into a different account. New characters sync their data immediately after being added.</li>
        <li>Skill calculations now use the best level across all linked characters, not just the first one.</li>
        <li>Settings, Characters, and EFT Import windows can now be dragged anywhere on screen.</li>
        <li>Grid view: new 30-day adjusted price column (hover to compare against your market hubs) and buy volume column with freight cost estimate on hover.</li>
        <li>Structure profiles are automatically applied when you only have one configured. Targets without a profile are highlighted in orange.</li>
        <li>The left sidebar can now be collapsed to a slim icon strip to free up screen space. Preference is remembered between sessions.</li>
        <li>Ctrl+S and the Save button now show a brief confirmation when the plan is saved.</li>
      </ul>

      <div className="about-changelog-section">Changed</div>
      <ul className="about-changelog-list">
        <li>Default window size is now 1600×900 with a minimum width of 1200.</li>
      </ul>

      <div className="about-changelog-section">Fixed</div>
      <ul className="about-changelog-list">
        <li>EVE SSO authentication on Linux now works reliably — fixed session reuse, concurrent auth lock, and timeout issues.</li>
        <li>OAuth callback now validates the CSRF state token before showing a success page.</li>
        <li>Corporate asset sync is now atomic — a partial write can no longer leave asset quantities inconsistent.</li>
        <li>Character add errors now show the actual failure reason instead of [object Object].</li>
        <li>Dragging to select text in number fields no longer accidentally closes open dropdowns.</li>
        <li>Number fields in the structure profile editor no longer jump or reset while typing.</li>
        <li>Market view now expands to fill the full available width.</li>
        <li>The panel toggle button is hidden on views where it has no effect.</li>
        <li>EFT import no longer silently produces a quantity of 1 for very large stack sizes.</li>
        <li>Solver run counts now use overflow-safe arithmetic on extreme inputs.</li>
        <li>Invalid price data from ESI is filtered before it can reach the solver.</li>
      </ul>

      <div className="about-changelog-version" style={{ marginTop: "var(--sp-4)" }}>
        <span className="about-changelog-tag">0.0.1</span>
        <span className="about-changelog-date">2026-04-30</span>
      </div>
      <p className="about-changelog-initial">Initial release.</p>
    </div>
  );
}

function OssEntry({ name, version, license }: { name: string; version: string; license: string }) {
  return (
    <div className="about-oss-entry">
      <span className="about-oss-name">{name}</span>
      <span className="about-oss-version">v{version}</span>
      <span className="about-oss-license">{license}</span>
    </div>
  );
}