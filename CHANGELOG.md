# Changelog

## [0.0.2] - 2026-05-14

7 new features · 11 bug fixes · 1 change

### Added

Multi-account support. Adding a second EVE account now works reliably. The login screen always prompts for fresh credentials so you can sign into a different account without it silently reusing the one already logged in. Once added, your new character's data syncs immediately. If you have multiple characters, structure market prices now work as long as at least one of them has docking access to the structure.

Skill calculations across characters. When you have multiple characters linked, the solver now uses the best skill level across all of them rather than just the first one. The Advisor panel shows a note explaining this when more than one character is active.

Movable windows. The Settings, Characters, and EFT Import windows can now be dragged to anywhere on screen. Form windows like these can only be closed with the X button so you don't accidentally lose what you were filling in. Informational windows can still be dismissed by clicking outside them.

Grid view improvements. Two new columns have been added — a 30-day adjusted price average from EVE's global market data, and a buy volume column showing the total packaged m³ of items you need to purchase. Hovering the 30-day average shows how each of your configured market hubs compares against it. Hovering the buy volume shows an estimated freight cost if you have a freight rate set.

Structure profile quality of life. When you only have one structure profile configured it is now automatically applied to new build targets. Targets without a profile are highlighted in orange so they are easy to spot.

Collapsible sidebar. The left sidebar can now be collapsed to a slim icon strip, giving more screen space to your build graph, grid, or market view. Your preference is remembered between sessions.

Save confirmation. Pressing Ctrl+S or clicking Save now shows a brief confirmation so you know it worked.

### Changed

The app now opens at 1600×900 by default with a minimum width of 1200.

### Fixed

EVE SSO authentication on Linux now works reliably. A combination of issues — the login screen silently reusing an existing session, only one auth flow being allowed at a time, and a shorter timeout — caused Linux users to see auth failures when adding accounts.

The OAuth callback page now correctly validates the CSRF state token before showing a success message. Previously, a failed or intercepted callback could show a success page despite authentication not completing.

Corporate asset data is now written atomically. A partial sync could previously leave asset quantities in an inconsistent state if interrupted mid-write.

Error messages when adding a character now show the actual failure reason. Previously they displayed `[object Object]` instead of the underlying message.

Dragging to select text in number fields no longer accidentally closes open dropdowns. Number fields in the structure profile editor no longer jump or reset while typing. The panel toggle button is hidden on views where it has no effect. The market view now expands to use the full available width.

EFT fit import now handles quantities above 4 billion correctly. Previously, any line with an extremely large quantity (technically anything over 4,294,967,295) would silently fall back to a quantity of 1, producing a wrong build plan with no warning.

Solver run counts can no longer overflow on extreme inputs. The calculation that determines how many manufacturing runs are needed now uses overflow-safe arithmetic.

Invalid price data (NaN or negative values) is now filtered out before it can reach the solver. A malformed ESI response could previously inject bad numbers that silently corrupted cost calculations.

---

## [0.0.1] - 2026-04-30

Initial release.
