import { Component, type ErrorInfo, type ReactNode } from "react";
import "./ErrorBoundary.css";

const GITHUB_ISSUES = "https://github.com/fastburn/eve-nexus/issues";
const DISCORD       = "https://discord.gg/U8dVEWdDBM";

interface Props  { children: ReactNode; }
interface State  { error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="eb-backdrop">
        <div className="eb-box">
          <div className="eb-icon">⚠</div>
          <h2 className="eb-title">Something went wrong</h2>
          <p className="eb-body">
            Eve Nexus hit an unexpected error. Your plans are saved automatically.
          </p>
          <details className="eb-details">
            <summary className="eb-summary">Error details</summary>
            <pre className="eb-trace">{error.message}</pre>
          </details>
          <p className="eb-report-label">Help us fix this:</p>
          <div className="eb-links">
            <a href={GITHUB_ISSUES} target="_blank" rel="noopener" className="eb-link-gh">
              Open a GitHub issue
            </a>
            <a href={DISCORD} target="_blank" rel="noopener" className="eb-link-discord">
              Report on Discord
            </a>
          </div>
          <button className="eb-reload" onClick={() => window.location.reload()}>
            Reload app
          </button>
        </div>
      </div>
    );
  }
}
