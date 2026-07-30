# Changelog

All notable changes to Homun are documented here, in the format the marketing site's changelog
parses. This is the single source of truth: the released version's section is written into the
GitHub Release body (from which the app shows the in-app "What's new" on update, and the website
`/changelog` renders it via the GitHub Releases API).

Section headers are `## Highlights` / `## Improvements` / `## Fixes` (H2), and each bullet is a
single line so the site captures its full text; version delimiters are `## [x.y.z] — date`.

## [Unreleased]

## [0.1.1094] — 2026-07-30

A release candidate built around deterministic recovery, security gates and reproducible installers.

## Highlights
- **Hard restarts preserve one canonical turn.** Process fencing, durable checkpoints and lease recovery now converge tasks, runs and assistant messages without duplicate ownership after a gateway crash.
- **Release builds fail closed.** GitHub produces installers only after formatting, warning-free Clippy, the complete deterministic test gate and dependency audits all pass on the same source commit.

## Improvements
- **Every installer carries a SHA-256 manifest.** macOS, Windows and Linux artifacts can be verified independently before a draft release is considered for publication.
- **The inference surface matches the runtime.** The unused MistralRS transport and its unmaintained dependency tree have been removed; supported providers continue through the common inference contract.

## Fixes
- **Transient SQLite contention no longer loses a turn.** Atomic enqueue retries use fresh transactions, while startup recovery completes before any background database writer begins.
- **Rendered document QA starts reliably in CI.** Each Chromium run uses an isolated profile, a bounded DevTools readiness contract and complete process cleanup.

## [0.1.1093] — 2026-07-26

A browser that completes real tasks, and a noticeably smoother app.

## Highlights
- **Web searches now run to the end.** Ask for something that needs the web — train times, flights, a booking form — and Homun fills the form, waits for the results and reports the real values. Multi-field searches used to stop halfway and come back as a timeout.
- **Mid-task steering.** Correct or redirect Homun while it's already working, without starting over — your message is understood and applied to the task in progress.
- **The app is much smoother.** Replies scroll without bouncing as they stream, text updates without jank even on long answers, code blocks no longer flicker, and the window opens already in the correct theme.
- **Money actions require explicit confirmation.** Logins, bookings and form-filling stay free when you ask for them; only the final payment needs an explicit go-ahead, decided by what the action actually does on the page — never by the button's wording.

## Improvements
- **Dates and times are set in one step.** For ticket-style searches the browser sets a date or a time directly instead of clicking through a calendar, so those searches reach the results reliably.
- **Suggestion fields are handled properly.** Typing a station or city and picking the right suggestion now works first time, instead of re-typing the same thing over and over.
- **Homun keeps working while it is making progress.** Its limits now measure progress rather than elapsed time, so a long task is only stopped when it is genuinely stuck — and when it repeats itself it is told to change approach instead of giving up.
- **Homun keeps writing while the window is covered.** Previously, with the app in the background, the reply would freeze and then jump ahead when you switched back.
- **Faster startup.** Secondary views load only when they are needed.

## Fixes
- **Long results pages are read in full.** A results table was being cut off before its rows, so Homun could report "nothing found" while the results were on screen.
- **Search results are read once they have loaded.** After submitting a search it waits for the page to finish fetching instead of looking too early and starting over.
- **Paying online can complete.** Filling the card's security code was consuming the payment approval, so the final payment click was always refused.
- **A finished answer is never left spinning.** A turn could keep the "writing" indicator running after it had already answered, and could show the answer twice. The answer is now always delivered and the turn closed.
- **One unclear instruction no longer breaks the rest of the conversation.** An instruction sent mid-task that could not be interpreted used to leave every later message waiting.
- **Ordinary actions are no longer blocked by internal safety checks.** Everyday clicks, and commands such as deleting a build folder, were being refused; refusals now explain what to do, and only genuinely risky actions are stopped.
- **File paths are no longer mistaken for secrets.** Asking about a file whose name contains "secret" or "token" no longer hides it from Homun.
- **Long waits are no longer mistaken for errors.** If the model stays unavailable for a while, a wait stays a wait.
- **The local model respects its timeout.** A stuck generation no longer keeps Homun busy indefinitely.

[Unreleased]: https://github.com/homun-app/homun-releases/releases
[0.1.1094]: https://github.com/homun-app/homun-releases/releases/tag/v0.1.1094
[0.1.1093]: https://github.com/homun-app/homun-releases/releases/tag/v0.1.1093
