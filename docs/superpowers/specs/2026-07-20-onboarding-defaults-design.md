# Onboarding defaults design

## Goal

Make a fresh or factory-reset Homun installation enter the product with the intended branded experience: dark theme, teal accent, readable local-model choices, and a working documentation link.

## Approved behavior

- Every onboarding `Documentation` link opens `https://homun.app/docs/`.
- Local-model option titles and supporting text remain legible on the dark onboarding surface.
- With no saved preference, the application starts with the `dark` theme and the existing teal accent `#157a6e`.
- An explicitly saved user theme or accent remains authoritative.
- Both completing and skipping onboarding inherit the same defaults without an intermediate theme flash.

## Design

The default is owned by the existing theme bootstrap in `accent.ts`, which runs before React renders. Changing the fallback theme from `freddo` to `dark` therefore covers all fresh-state entry paths while preserving stored preferences. The existing teal fallback remains unchanged.

The onboarding model button receives an explicit foreground color from the onboarding palette. Native buttons do not reliably inherit the parent foreground color, which currently exposes the browser's dark text default.

The documentation URL is corrected at its source in `OnboardingWizard.tsx`.

## Verification

- Extend the existing UI contract with assertions for the canonical docs URL, dark fallback theme, teal fallback accent, and explicit model-card foreground.
- Run the desktop typecheck, UI contract, production build, and Electron tests.
- Exercise onboarding with isolated fresh application data and visually confirm the model cards and first post-onboarding screen.

## Non-goals

- No redesign of onboarding layout or copy.
- No migration that overwrites an existing user's stored theme or accent.
- No release/tag operation as part of this fix unless requested separately.
