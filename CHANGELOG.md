# Changelog

All notable changes to Homun are documented here, in the format the marketing site's changelog
parses. This is the single source of truth: the released version's section is written into the
GitHub Release body (from which the app shows the in-app "What's new" on update, and the website
`/changelog` renders it via the GitHub Releases API).

Section headers are `## Highlights` / `## Improvements` / `## Fixes` (H2), and each bullet is a
single line so the site captures its full text; version delimiters are `## [x.y.z] — date`.

## [Unreleased]

## Improvements
- **The app is much smoother.** Replies scroll without bouncing as they stream, the text updates without jank even on long answers, and code blocks no longer flicker as they arrive.
- **Cleaner, faster startup.** The window opens already in the correct theme — no white flash — and the app loads faster because secondary views load only when they're needed.
- **Homun keeps writing while the window is covered.** Previously, with the app in the background, the reply would freeze and then jump ahead when you switched back.

## Fixes
- **Long waits are no longer mistaken for errors.** If the model stays unavailable for a while, a wait stays a wait — no error message while Homun is still recovering.
- **The local model respects its timeout.** A stuck generation no longer keeps Homun busy indefinitely.

## [0.1.1079] — 2026-07-24

New browser engine and mid-task steering.

## Highlights
- **Mid-task steering.** Correct or redirect Homun while it's already working, without starting over — your message is understood and applied to the task in progress.
- **Automatic recovery when the model blips.** If the model becomes briefly unavailable during a task, the turn waits and resumes where it left off instead of failing — one answer, no lost work, no duplicates.
- **Money actions require explicit confirmation.** Logins, bookings and form-filling stay free when you ask for them; only the final payment needs an explicit go-ahead, decided by what the action actually does on the page — never by the button's wording.

## Improvements
- **A browser that's better at filling forms.** Reliable selection from suggestion fields (dropdowns like a station picker), so it no longer gets stuck re-typing the same thing.
- **The browser keeps going while it's making progress.** Its time budget resets on every successful step, with an overall safety cap: on slower models it no longer gives up in the middle of a form — it stops only when it's genuinely stuck.
- **More robust web searches.** Better page reading, fewer dead-end attempts, and results returned more faithfully.

[Unreleased]: https://github.com/homun-app/homun-releases/releases
[0.1.1079]: https://github.com/homun-app/homun-releases/releases/tag/v0.1.1079
