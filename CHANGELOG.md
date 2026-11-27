# Changelog

## [0.0.4] - Unreleased

3 new features · 1 improvement · 12 bug fixes

### Added

Structure hull and security settings. Structure profiles now have a Security field (High-sec, Low-sec, Null-sec / W-space) and a Structure field (NPC station, Raitaru, Azbel, Sotiyo, Athanor, Tatara) in place of the old space modifier. The hull's role bonuses are applied automatically: Raitaru, Azbel and Sotiyo give 3 / 4 / 5% lower job cost, 1% fewer materials and 15 / 20 / 30% faster jobs, and the Tatara gives 25% faster reactions. Existing profiles keep working but start with no hull selected, so set the Security and Structure fields on each profile to get the right bonuses.

Large and extra-large structure rigs. The rig picker now includes the L-Set and XL-Set manufacturing rigs for Azbels and Sotiyos, and the M-Set reactor rigs for Athanors. Previously only M-Set engineering rigs were available, so a Sotiyo couldn't be set up with its real rigs. Reactor rigs only bonus their own formula family.

Reactions in the Schedule. Reaction jobs now appear in their own section of the Schedule with their own slot count, which defaults from your Mass Reactions and Advanced Mass Reactions skills. Reaction time uses your Reactions skill and the structure's bonuses. The critical path now covers manufacturing, reactions and invention.

### Improved

Character sync makes fewer ESI calls. Corporation assets and each character's corporation lookup were each requested twice per sync, and are now requested once.

### Fixed

Rig bonuses in low-sec and null-sec structures were scaled wrong. The space modifier field was described as a job cost discount (for example 0.75 for a Sotiyo), but the app actually used it to scale rig bonuses. A null-sec Sotiyo entered that way got rigs at 0.75x instead of 2.1x. Rig bonuses now come from the Security field, and the job cost discount comes from the Structure field.

Job cost now follows the current formula: the system cost index reduced by the structure's job cost bonus, plus facility tax and the 4% SCC surcharge. Items without a structure profile fall back to the NPC station tax of 0.25%.

Job cost was calculated from your blueprint's reduced material quantities. The game uses the blueprint's base materials (ME 0, no structure bonus) to value the job, so researched blueprints showed job costs that were too low.

Skills now use their active level instead of their trained level. A lapsed Omega account on an Alpha clone can't use skills trained past the Alpha cap, and the app was calculating with them anyway. When every character is on an Alpha clone, job costs also include the 0.25% Alpha clone tax.

Material quantities are now rounded up after applying ME, the same way the game does it. Previously they were rounded down, which could leave you one unit short (for example 3 runs needing 1 unit each at ME 10 need 3 units, not 2).

Reactions no longer get the default ME 10. Reaction formulas can't be researched, so reaction inputs were being undercounted by 10%.

Invention jobs now include their job cost. It's charged on 2% of the product's value using your Invention structure profile, and it's included when the app picks the cheapest decrypter. Previously invention had no job cost at all.

Invention time now applies the Advanced Industry skill (3% faster per level) and the structure's time bonus. Previously it always used the base time.

Corporation assets no longer pile up or get counted twice. Corp stock was added on top of a character's personal assets on every sync, so it grew with each refresh, and two directors in the same corp counted it twice. Corp assets and blueprints are now stored once per corporation. Your asset and blueprint data is cleared once after updating and fetched again on the next sync.

Characters set to "Both" for corp assets no longer lose their personal blueprints. Syncing corp blueprints was replacing the character's own blueprint list, so personal ME/TE research levels went missing.

Characters set to corp-only assets now sync their skills, industry jobs, market orders and wallet. Previously corp-only mode skipped all of them.

Launching the app and pressing Refresh now respect ESI cache times. Both used to clear every cache timer and fetch all data again, even data ESI had marked as still fresh.

## [0.0.3] - 2026-11-01

5 new features · 7 improvements · 31 bug fixes

### Added

Beta update channel. Settings now has a "Receive beta updates" toggle under Updates. With it on, the app offers beta builds through the normal update banner, and still offers stable releases when they ship. Beta builds have it on by default; stable builds have it off. Previously beta testers had to download each beta by hand because the updater only looked at stable releases.

Grid category filter chips. The build plan grid now shows filter chips in the toolbar for item categories present in the current plan. Click a chip to narrow the grid to just that category. Chips include Minerals, PI, Reactions, Ships, Modules, Drones, Charges, and Components. Multiple chips can be active at once (OR logic). Chips only appear when the current plan contains items of that type.

Schedule view. A new toolbar tab that shows a manufacturing timeline for your current build plan. Enter your available manufacturing and invention slots to see how long the full build takes, or set a target number of days and it tells you how many slots you need. Slot counts default from your character skills.

Best Source column. The grid now shows where each buy item is cheapest after freight. Flag one of your market hubs as "Local" in settings, and the column compares landed cost across all your hubs. Local hubs have no freight added; import hubs add your configured freight rate per m3. Shows the cheapest hub highlighted with savings versus the next option.

5-day price trend column. The grid shows a directional price trend for each item based on market history. A green arrow means prices are rising, red means falling. Data is pulled from ESI market history (daily averages) and cached locally with a 35-day rolling window. When you have multiple market hubs configured it picks the region with the highest trade volume.

### Improved

Facility tax now accepts two decimal places. Structure profiles previously rounded tax to one decimal, so a 0.25% alliance tax was saved as 0.3%.

Grid performance. The best-sell-price lookup is now precomputed into a map instead of scanning all prices per row. The build-tree cost calculation in the market analysis card is memoized so it no longer recomputes on every keystroke.

Database write performance. Bulk upserts for system names, structure names, and asset locations are now wrapped in transactions instead of doing per-row fsyncs.

Copy icons in the market price table now use inline icons instead of a Unicode glyph that rendered as a blank box on some platforms.

Restock's lowest-sell-price lookup is now precomputed into a map instead of scanning all price entries per row, matching the same optimization already applied to the main grid.

The market view's best-sell-price and margin lookups are now precomputed into a map instead of recalculating on every render.

Database migrations now run once per database instead of being reattempted on every app launch.

### Fixed

Profile auto-assignment now triggers correctly when loading a saved plan. Previously the backfill only watched for profile changes, not target changes, so opening a plan with unassigned targets would leave them without a profile until the next app restart.

Corp-only asset mode no longer accumulates stale personal assets. When a character is set to sync only corporate assets, personal asset data from a previous sync is now cleared before the corp merge, preventing phantom items from appearing in the asset list.

OAuth callback listener in release builds now binds to localhost only instead of all interfaces. This prevents other devices on the network from reaching the auth callback port.

Search inputs with wildcards (% and _) are now escaped in LIKE queries across type search and blueprint browsing, preventing unexpected matches when searching for names containing those characters.

Price history is no longer fetched for player structure hubs. ESI has no history endpoint for structures, so every request against one was a guaranteed failure. On plans with a structure hub configured, this alone could burn through the whole ESI error budget in a single refresh and lock out other price and asset requests for the rest of the minute.

The ESI error budget tracker no longer locks up permanently once it hits zero. It now checks the reset window and resumes making requests once the budget window has passed, instead of refusing all further requests until the app is restarted.

Market price fetching now requests all configured hubs concurrently instead of one at a time, matching what the code already claimed to do.

Fixed a race condition where refreshing multiple characters at once could invalidate a character's refresh token, since EVE SSO issues a new single-use refresh token on every use. Refreshes for the same character are now serialized so concurrent ESI calls can't step on each other. When a refresh token is found to be permanently dead, the session-expired message now names the character instead of showing a raw ID.

The Windows uninstaller now force-closes any running instance of Eve Nexus before deleting your data. Previously, if the app or a lingering background process still had its database files open, the delete-my-data step would silently fail and leave old plans and settings behind for the next install to pick back up.

The "job costs are missing" warning now names the affected item and the specific job type (Manufacturing or Reaction) that needs a structure profile, instead of a generic "some items" message. Some intermediates, like R.A.M.- components, are manufactured rather than reacted even though they share a market category with reaction outputs, which made it hard to tell which profile was actually missing.

Structure Manufacturing rigs (Standup M-Set Structure Manufacturing ME/TE) now correctly bonus fuel block production. Fuel blocks were being skipped because they fall in the "Material" SDE category rather than "Structure", which the rig's own bonus category list didn't include. Also removed a stale, misleading "Commodity" category from the Reaction rig's bonus list — no reaction ever actually produces a Commodity-category item, so it was showing an ME/TE bonus in the UI that could never apply to anything.

Fixed a rig bonus leak introduced by the fuel block fix above: since Manufacturing and Reaction rigs could now both resolve to the "Material" category, an installed rig's bonus is now filtered by job type so a Reaction rig can no longer apply its ME/TE bonus to a Manufacturing job (or vice versa).

Solar system name search no longer skips escaping for % and _ wildcards, matching the same fix already applied to type and blueprint search.

ME and TE levels loaded from a saved plan are now clamped to their valid game ranges (0-10 ME, 0-20 TE). An out-of-range value from a corrupted save could previously flow into the cost calculation and silently floor to a wrong-but-plausible result instead of being caught.

Price history entries fetched for the same item across multiple calls no longer get duplicated or left unsorted. Previously a shared history array could be mutated in place and the sort order wasn't guaranteed after merging new entries.

The build plan solver now discards results from a stale, no-longer-current request instead of overwriting newer results if an older request happens to resolve last.

Fresh installs could fail to save a local market hub, link a wallet-scoped character, or set a restock overbuild percentage, with errors like "table X has no column named Y". Three columns were added only through a migration step that ran before their table existed on a brand-new database, so the column was silently missing on first install and never retried. All three now ship as part of the table's initial schema.

Error messages from failed ESI and database calls now show the actual failure reason across the app (Market, Restock, Schedule, Advisor, Blueprint Browser, Characters, Settings, and system/structure search) instead of `[object Object]`. Several call sites were stringifying the raw error object instead of reading its message.

The "SDE not available" error now shows a real message instead of the raw internal error name.

The Blueprint Browser no longer shows stale results when filters are changed quickly. A slower response for an old filter combination could previously arrive after a newer one and overwrite it.

EVE SSO tokens are no longer written to the local database in plaintext when the OS keychain is working. Previously every token save wrote a plaintext copy to the database as a matter of course; it's now only used when a keychain write can't be verified.

Restock's market order refresh now fetches all characters' orders concurrently instead of one at a time, speeding up refresh on multi-character accounts.

The "job cost is missing" warning now explains when it's caused by having multiple structure profiles of the same job type, so eve-nexus can't guess which one to use, instead of implying none is configured. Assign one to the affected build target from the profile dropdown in the sidebar.

Fixed a crash in the build plan solver. A manual "Build" override for an item with no resolvable blueprint, such as a raw material or a discontinued item left over from a stale setting, could crash the solver instead of falling back to buying it.

Fixed a bug where switching production plans in quick succession could load the wrong plan's data. If an older plan's data arrived after a newer selection, it would silently overwrite the plan you'd actually switched to.

The Schedule view no longer fetches the manufacturing timeline twice every time you open the tab.

Error messages from failed database and static-data queries no longer show raw internal detail such as table or column names. They now show a general failure message, with the full detail still recorded in the app logs.

Deleting a plan, or loading default plan settings, now shows an error message if the operation fails instead of failing silently.

Adding or removing a character now shows an error message if it fails, instead of leaving you without feedback.

Removing a market hub while a price refresh is still in flight no longer lets stale prices for that hub reappear once the refresh completes.

A failure loading settings or static data on startup no longer prevents the rest of the app from finishing initialization.

---

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
