# Homun Core README Redesign

## Goal

Rewrite the `homun-core` README for people discovering Homun for the first time. The README should explain the product quickly, make downloads immediately accessible, and direct readers to the website and documentation. Technical repository information remains available after the product introduction.

## Primary audience

The primary audience is a prospective Homun user arriving from GitHub. Contributors and developers are the secondary audience.

## Positioning

The opening message uses the same positioning as the public website:

> Your work. Your models. Your system.

Homun is described as a model-independent AI workspace that keeps projects, memory, tools, and permissions together. It supports compatible cloud, open-source, and local models, subject to the user's configuration and hardware.

The README must not reduce Homun to a personal assistant or imply that every feature always runs locally. It should emphasize model freedom, project continuity, and user-controlled access boundaries.

## Information hierarchy

The README follows this order:

1. Homun identity and product promise.
2. Immediate download links for macOS, Windows, and Linux, plus all releases.
3. Prominent links to the website, documentation, and roadmap.
4. One large, readable product image.
5. Three reasons to choose Homun: model freedom, continuing projects, and controlled connected action.
6. Concrete examples of work Homun can perform.
7. A clear statement that the core product does not require an account.
8. Repository architecture and development instructions.
9. Security and licensing information.

## Links

- Website: `https://homun.app`
- Documentation: `https://homun.app/docs`
- Roadmap: `https://homun.app/roadmap`
- Latest release: `https://github.com/homun-app/homun-releases/releases/latest`
- Release history: `https://github.com/homun-app/homun-releases/releases`

The macOS, Windows, and Linux download actions all lead to the latest release page. This keeps the links stable while letting users choose the correct installer from the current release assets.

Documentation links currently pointing to `docs.homun.app` are replaced with their corresponding paths under `homun.app`.

## Product content

The product section stays concise and demonstrates outcomes rather than listing implementation details. Examples may include:

- developing software inside an ongoing project;
- creating documents and presentations;
- using WhatsApp or Telegram as channels;
- running scheduled or event-triggered automations with connected services such as Gmail;
- using approved tools on the local computer;
- preserving memory and decisions across conversations.

Claims must remain accurate to the current product. Future account-backed marketplace or community features are not presented as available.

## Account boundary

The README states that an account is not required to download Homun or use its core local capabilities. It does not promise that every future online service will work without an account.

## Visual treatment

Use one primary application screenshot or illustration that is readable at GitHub's content width and consistent with the current Homun visual identity. Avoid a gallery of small screenshots and avoid duplicating the complete marketing site inside the README.

The opening uses simple Markdown links or badges that render reliably on GitHub. Visual decoration must not obscure download labels or accessibility text.

## Technical content

Preserve and tighten the useful technical sections:

- repository component map;
- supported development commands;
- links to architecture, self-hosting, and security documentation;
- FSL 1.1 license and its conversion terms.

Development commands are verified against the repository before publication. Product and contributor content remain clearly separated.

## Acceptance criteria

- A new visitor can identify Homun's purpose before scrolling.
- Download, website, documentation, and roadmap links appear before the first detailed feature section.
- The README explicitly mentions cloud, open-source, and local model support.
- The README explicitly states the optional-account boundary for core use.
- No links point to the retired `docs.homun.app` structure.
- Technical setup instructions match the repository's current scripts and tooling.
- The existing user-owned untracked file `homun-tablet-full.png` is not modified or committed unless it is deliberately selected as the approved README visual.
- Markdown links and referenced local assets are validated before completion.
