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

  useEffect(() => {
    if (show) {
      getVersion().then(setVersion).catch(() => {});
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

function OssEntry({ name, version, license }: { name: string; version: string; license: string }) {
  return (
    <div className="about-oss-entry">
      <span className="about-oss-name">{name}</span>
      <span className="about-oss-version">v{version}</span>
      <span className="about-oss-license">{license}</span>
    </div>
  );
}
