# Eve-Nexus

![Version](https://img.shields.io/badge/version-0.0.1-blue)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey)
![License](https://img.shields.io/badge/license-AGPL--3.0-green)
![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8D8)

EVE Online industry supply chain planner. Built with Tauri 2, React, and Rust.

Eve-Nexus takes your characters' blueprints, assets, and active jobs from ESI and produces a complete build plan — showing exactly what to manufacture, what to buy, and what it will cost. It handles multi-level bill of materials recursively, accounts for on-hand stock and in-progress jobs, and surfaces market prices, buy-vs-build analysis, and system cost index data so you can make profitable decisions without a spreadsheet.

---

## Features

- **Build graph** — visual node graph of the full production chain
- **Grid view** — sortable spreadsheet with all quantities, job costs, and sell prices
- **Profitability** — revenue, material cost, job cost, and margin calculated per plan
- **Buy vs Build** — per-node comparison using live market prices
- **System cost flagging** — cost index on structure profiles, cheapest alternatives surfaced
- **Market restock planner** — track target sell quantities, surface deficits, margin threshold alerts
- **Advisor** — skill gap analysis, slot utilisation, blueprint backlog, industry tips
- **Blueprint browser** — searchable SDE catalogue with owned blueprint overlay
- **Multi-character** — assets, skills, and jobs across all authenticated characters
- **EFT fit import** — paste any ship fitting to generate a full bill of materials
- **Corp assets** — directors can include corp blueprints and assets alongside personal data
- **Multi-theme** — Default, Amarr, Caldari, Gallente, Minmatar, Jove, Light

---

## Download

Pre-built installers are available on the [Releases](https://github.com/fastburn/eve-nexus/releases/latest) page.

| Platform | Format |
|----------|--------|
| Windows  | `.exe` NSIS installer |
| Linux    | `.AppImage` / `.deb` / `.rpm` |
| macOS    | Coming soon |

No installation of Rust or Node.js required — just download and run.

---

## Prerequisites

- [Rust](https://rustup.rs/) (stable)
- [Node.js](https://nodejs.org/) 18+
- [Tauri CLI](https://tauri.app/start/prerequisites/)

```bash
cargo install tauri-cli
```

---

## Development

```bash
# Install frontend dependencies
npm install

# Run in development mode (hot-reload frontend + Rust backend)
npm run tauri dev
```

The app will open automatically. The Rust backend recompiles on save; the frontend hot-reloads via Vite.

### SDE

Eve-Nexus downloads the EVE Static Data Export (SDE) automatically on first launch. It checks for updates in the background on every start. No manual setup required.

---

## Building

```bash
# Production build for the current platform
npm run tauri build
```

Outputs are in `src-tauri/target/release/bundle/`.

---

## Project structure

```
eve-nexus/
├── src/                        # React/TypeScript frontend
│   ├── api/                    # Tauri invoke wrappers
│   ├── components/             # UI components (shell, panels, graph, grid…)
│   ├── lib/                    # Pure logic (build cost, helpers)
│   ├── store/                  # Zustand state (solver, settings, market, ui…)
│   ├── views/                  # Full-page views (MarketView, RestockView)
│   └── types/                  # Shared TypeScript types
│
└── src-tauri/                  # Rust backend
    └── src/
        ├── auth/               # ESI OAuth2 PKCE flow + token storage
        ├── commands/           # Tauri IPC command handlers
        ├── db/
        │   ├── local.rs        # SQLite — settings, hangar, plans, cache
        │   └── sde/            # EVE Static Data Export (read-only)
        ├── esi/                # ESI HTTP client + typed endpoints
        ├── solver/             # Build plan solver (BOM expansion, cost)
        └── types/              # Shared Rust types
```

---

## Key dependencies

| | |
|---|---|
| [Tauri 2](https://tauri.app/) | Desktop app framework |
| [React 19](https://react.dev/) | Frontend UI |
| [Zustand](https://zustand-demo.pmnd.rs/) | Frontend state management |
| [React Flow](https://reactflow.dev/) | Build graph canvas |
| [rusqlite](https://github.com/rusqlite/rusqlite) | Local SQLite database |
| [reqwest](https://docs.rs/reqwest) | ESI HTTP client |
| [Vite](https://vite.dev/) | Frontend build tool |

---

## Privacy

Eve Nexus collects anonymous usage analytics to help understand which features are used and how the app is performing. No personal data, character names, or in-game information is ever collected or transmitted.

Analytics are opt-in and are configured during the first-run setup. You can review or change your preference at any time in Settings.

---

## License

[GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0)

You are free to use, modify, and distribute this software under the terms of the AGPL-3.0. Any modified version that is distributed or run as a network service must also be released under the same license.

---

*Not affiliated with CCP Games. EVE Online is a registered trademark of CCP hf.*
