// Copyright (C) 2026 Eve Nexus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

pub mod sde;
pub mod local;
pub mod updater;

/// Escape `%`, `_`, and `\` in a user-supplied string so it can be safely
/// embedded in a `LIKE ... ESCAPE '\'` pattern without the user controlling
/// wildcard matching.
pub fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}