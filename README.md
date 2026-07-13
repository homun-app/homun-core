# Homun

## Your work. Your models. Your system.

Homun is a model-independent AI workspace that keeps your projects, memory, tools,
and permissions together. Use compatible cloud, open-source, or local models without
making one provider the permanent center of your work.

### Download Homun

| macOS | Windows | Linux | Other versions |
| --- | --- | --- | --- |
| [**Download for macOS**](https://github.com/homun-app/homun-releases/releases/latest) | [**Download for Windows**](https://github.com/homun-app/homun-releases/releases/latest) | [**Download for Linux**](https://github.com/homun-app/homun-releases/releases/latest) | [View all releases](https://github.com/homun-app/homun-releases/releases) |

The latest release page contains the current installers for every supported platform.

[**Website**](https://homun.app) ·
[**Documentation**](https://homun.app/docs) ·
[**Roadmap**](https://homun.app/roadmap) ·
[**Getting started**](https://homun.app/guides/getting-started/)

![Homun desktop workspace](https://raw.githubusercontent.com/homun-app/website/main/src/assets/screenshots/chat.png)

## Why Homun

### Choose the model that fits the work

Connect compatible hosted providers, use open-source models, or run local models on
suitable hardware. Your workspace remains the stable layer while its model engines
can change.

### Keep projects moving

Homun carries project context, memory, decisions, files, and future work beyond a
single conversation. An idea can become a plan, an action, and a deliverable without
starting over at every prompt.

### Connect action without giving up control

Use approved local tools, MCP servers, skills, and connected services. Homun keeps
tool activity and permissions visible, with deny-by-default boundaries for sensitive
actions.

## What you can do

- **Develop software** — explore codebases, modify files, run checks, and retain the
  decisions behind the work.
- **Create deliverables** — turn research and project context into documents,
  presentations, diagrams, and structured outputs.
- **Work through your channels** — reach Homun from WhatsApp or Telegram and control
  when a reply can be sent automatically.
- **Run automations** — begin at a chosen time or from an event, such as checking
  Gmail every morning or responding when new work arrives.
- **Use the local computer** — operate an isolated headed browser and shell that you
  can watch live and take over when needed.
- **Build durable memory** — connect entities, relations, decisions, contacts, and
  source material while retaining the ability to inspect and forget.

See the [product overview](https://homun.app/#product) for the complete picture and
the [documentation](https://homun.app/docs) for setup and capability guides.

> **No account required for core use.** You can download Homun and use its core local
> capabilities without registering. Optional online services may use an account when
> they become available.

## How it is built

A Rust gateway orchestrates the system, an Electron + React desktop app provides the
interface, and standalone sidecars handle heavier or isolated work.

| Path | Responsibility |
| --- | --- |
| `apps/desktop` | Electron + React desktop application |
| `crates/desktop-gateway` | Rust gateway, agent loop, routing, task runtime, and APIs |
| `crates/*` | Memory, inference, orchestration, skills, secrets, and capabilities |
| `runtimes/contained-computer` | Sandboxed Docker computer with browser and shell over CDP/noVNC |
| `runtimes/browser-automation` | Playwright/CDP browser driver |
| `runtimes/channel-telegram`, `channel-whatsapp` | Messaging bridges |

Read [PROJECT.md](PROJECT.md) for the founding document and the
[architecture reference](https://homun.app/reference/architecture/) for the component
map.

## Develop

You need a Rust toolchain, Node.js, and the platform dependencies required by
Electron. Desktop commands run from `apps/desktop`:

```bash
cd apps/desktop
npm install
npm run dev
npm run electron:dev

# Build a distributable package
npm run dist
```

Run the Rust and browser-automation suites from the repository root:

```bash
make test
```

The [self-hosting guide](https://homun.app/guides/self-hosting/) covers the complete
local and server setup, including the contained computer's Docker requirements.

## Security

Local-first operation and deny-by-default access are deliberate design choices. Read
the [privacy and security guide](https://homun.app/guides/security/) before enabling
tools, channels, connectors, or remote access.

## License

[Functional Source License v1.1](LICENSE.md) (FSL-1.1), converting to Apache 2.0 over
time. See [LICENSE.md](LICENSE.md) for the full terms.
