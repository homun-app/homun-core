# Decision 0003 - assistant-ui As Chat Architecture Reference

Date: 2026-05-25

## Context

The desktop app chat must support more than plain text. Real assistant output
includes Markdown, code, tables, diagrams, links, files, artifacts, tool
activity, approvals, suggestions and message-level actions.

assistant-ui provides a mature React chat architecture with primitives for
thread viewport, composer, attachments, message actions, suggestions, tool
activity and external-store runtimes.

## Decision

Use assistant-ui as an architecture and interaction reference, not as a direct
theme or CLI import for now.

We will not run `assistant-ui init` in the current desktop app because it pulls
in shadcn/Tailwind-oriented components and would introduce a second UI grammar.
Instead, we adapt the useful patterns into our custom React/Electron UI.

## Adopted Patterns

- Thread viewport with reliable auto-scroll and scroll-to-bottom behavior.
- Composer with send/cancel, focus management, attachments and drag/drop.
- Message renderer with Markdown, GFM, code blocks, tables and Mermaid.
- Message action bar for copy, regenerate, continue, memory/task/automation
  actions and feedback.
- Attachment model for composer previews and read-only message attachments.
- Suggestions as contextual next actions.
- Tool activity and Local Computer as progressive disclosure.
- External-store pattern: the Rust gateway/core owns thread state, messages,
  streaming, tasks, approvals, artifacts and policy; React renders read models
  and sends commands.

## Consequences

- Chat Experience Foundation becomes an early roadmap phase, before further
  cabling of complex browser/tool/connettori flows.
- React components must stay modular: `ChatView` should orchestrate layout, not
  own rendering logic for Markdown, attachments, actions and activity.
- Any new operational feature must be testable through the chat surface without
  exposing raw payloads or internal task/runtime vocabulary.
- assistant-ui remains a reference to re-evaluate later if its external-store
  runtime becomes worth adopting directly.
