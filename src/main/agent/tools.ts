// Tool base — stessi nomi e semantica dei tool verificati nel local-exec-daemon originale.
import type { ToolDef } from './llm'
import * as sandbox from '../sandbox'
import { resolveSecretRefs } from './secrets'
import { formatTaskDone } from '../../shared/agent-message'
import { MAX_GROUP_MEMBERS, coordinatorNowText } from './group-turns'
import { WAKE_SUMMARY_MAX_CHARS } from './subagents'
import {
  writeMemory, updateMemory, deleteMemory, listMemories, searchMemoriesByQuery,
  type MemoryTier, type MemoryScope
} from './memory'
import { readSkillFor, readSkillFileFor, writeSkillFromBot, SKILL_USER_ONLY_REFUSAL } from './skills'

/** Fase 10 (punto 1): limiti della creazione di bot da parte di un bot. */
export const MAX_CREATE_AGENTS_PER_TURN = 6
export const MAX_AGENTS_TOTAL = 20

/**
 * Fase token · nucleo (R8.1): l'istruzione al momento giusto — il result
 * RIUSCITO di write_document/edit_document chiude con questa riga (quello
 * fallito no): per i modelli piccoli l'istruzione più recente vince, e la
 * regola del messaggio breve arriva DOPO il salvataggio, quando serve. Il
 * simulatore dell'eval usa le stesse righe.
 */
export const WRITE_DOCUMENT_REPLY_RULE =
  'Saved: the user sees the document card. Reply with one or two sentences; do not repeat or summarize the content.'
export const EDIT_DOCUMENT_REPLY_RULE =
  'Saved: the user sees the document card. Reply with one or two sentences; do not repeat or summarize what you changed.'

/**
 * Fase token · nucleo (R8.3): il testo VERO del result di recall_memory
 * quando la ricerca non trova nulla — l'eval lo usa come result simulato di
 * default (niente più «ok» che non dice niente).
 */
export const NO_MEMORY_FOUND = 'No memory found for this search.'

export const toolDefs: ToolDef[] = [
  {
    name: 'send_to_user',
    description: 'Sends a message to the user in chat (markdown). In group turns it is the ONLY way to talk to the user: free text stays private. A brief progress message before long work, then the final result.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message (markdown) to show in chat' },
        urgent: { type: 'boolean', description: 'true only for what the user must act on within hours (never summaries)' }
      },
      required: ['text']
    }
  },
  // fase risposta (R2): il progresso dei lavori lunghi, fuori dai gruppi —
  // la descrizione segue il senso di Rakazo (longWorkProgressGuidance): mai
  // la risposta finale, mai un report; la risposta completa va nel testo
  // normale della risposta
  {
    name: 'message_user',
    description: 'Sends the user a SHORT progress message while long work is still running: a sentence or two, a few per turn, never the final answer (that is the text of your final reply). Capped at 500 characters.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The progress note to show in chat (max 500 characters)' },
        urgent: { type: 'boolean', description: 'true only for what the user must act on within hours (never summaries)' }
      },
      required: ['text']
    }
  },
  {
    name: 'ask_user',
    description: 'Asks the user a question with clickable choices: creates a widget in chat and ENDS the turn (the answer arrives as a new message). Prefer options over free text.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The question to show' },
        helpText: { type: 'string', description: 'Brief explanation of why you are asking (optional)' },
        options: {
          type: 'array',
          description: 'The clickable options (2-4)',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Button label' },
              value: { type: 'string', description: 'Associated value (default: label)' },
              description: { type: 'string', description: 'Short description (optional)' },
              style: { type: 'string', enum: ['primary', 'default'], description: '"primary" for the recommended action (optional)' }
            },
            required: ['label']
          }
        },
        multiSelect: { type: 'boolean', description: 'True to allow multiple selections with confirmation (optional)' },
        allowCustom: { type: 'boolean', description: 'True to add a free-text field (optional)' },
        dismissOnMoveOn: { type: 'boolean', description: 'True if the widget may be bypassed when the user writes something else (optional)' }
      },
      required: ['prompt']
    }
  },
  {
    name: 'draft_external',
    description: 'Prepares an outbound send (email, message, …) as a DRAFT with Send/Discard/Edit buttons: it is sent ONLY when the user clicks Send. If a send tool exists for the channel, set via to it.',
    parameters: {
      type: 'object',
      properties: {
        channel: { type: 'string', enum: ['email', 'slack', 'other'], description: 'Send channel' },
        to: { type: 'string', description: 'Recipient' },
        subject: { type: 'string', description: 'Subject (email, optional)' },
        body: { type: 'string', description: 'Message body' },
        via: {
          type: 'object',
          description: 'Send tool to run on confirmation (optional: filled when only one exists)',
          properties: {
            tool: { type: 'string', description: 'the send tool name for this channel' },
            args: { type: 'object', description: 'Arguments of the send tool', additionalProperties: true }
          },
          required: ['tool', 'args']
        }
      },
      required: ['channel', 'to', 'body']
    }
  },
  {
    name: 'run-command',
    description: 'Runs a shell command in the sandbox: stdout, stderr, exit code. Long commands (builds, tests, downloads): background: true returns a shellId at once; the outcome arrives later (await_shell reads it).',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command to run' },
        workingDirectory: { type: 'string', description: 'Optional working directory (default: the computer home)' },
        timeout: { type: 'number', description: 'Timeout in seconds (default 120; background commands use the 6-hour cap)' },
        background: { type: 'boolean', description: 'true to start it and continue the turn (outcome arrives later)' }
      },
      required: ['command']
    }
  },
  {
    name: 'await_shell',
    description: 'Waits for a background command (max 60 s, then the current state): status, exit code, last log lines. kill: true terminates; if still running, report and move on.',
    parameters: {
      type: 'object',
      properties: {
        shellId: { type: 'string', description: 'Id returned by run-command with background: true' },
        timeout_sec: { type: 'number', description: 'Seconds to wait (default 60, maximum 60)' },
        kill: { type: 'boolean', description: 'True to terminate the command (optional)' }
      },
      required: ['shellId']
    }
  },
  {
    name: 'copy_to_box',
    description: 'Copies a file from the user Mac into the bots computer (max 200 MB): always asks the user with a card. Sensitive Mac folders are excluded.',
    parameters: {
      type: 'object',
      properties: {
        mac_path: { type: 'string', description: 'File path on the Mac' },
        box_path: { type: 'string', description: 'Destination in the box' }
      },
      required: ['mac_path', 'box_path']
    }
  },
  {
    name: 'copy_from_box',
    description: 'Brings a file to the user Mac (max 200 MB): always asks with a card. Writes to ~/Downloads/Homun/, never overwrites.',
    parameters: {
      type: 'object',
      properties: {
        box_path: { type: 'string', description: 'File path on the computer' },
        mac_path: { type: 'string', description: 'Destination on the Mac (optional: default ~/Downloads/Homun/)' }
      },
      required: ['box_path']
    }
  },
  {
    name: 'read-file',
    description: "Reads the content of a file on the agent's computer.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path or relative to home' },
        offset: { type: 'number', description: 'Starting line (optional)' },
        limit: { type: 'number', description: 'Maximum number of lines (optional)' }
      },
      required: ['path']
    }
  },
  {
    name: 'write-file',
    description: "Writes a file on the agent's computer (creates missing directories).",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        content: { type: 'string', description: 'Full text content' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'list-directory',
    description: "Lists the content of a directory on the agent's computer.",
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (default home)' }
      },
      required: ['path']
    }
  },
  {
    name: 'use-app',
    description: 'Controls the user own Mac: screenshot, open_url {url} (instead of typing an address), open_app, type, key, click {x,y}. type/key/click REQUIRES `app`: it comes to the front.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['screenshot', 'open_url', 'open_app', 'type', 'key', 'click', 'double_click', 'right_click'], description: 'Action to perform' },
        url: { type: "string", description: "URL to open in the user's browser (action open_url; only http: and https:)" },
        x: { type: 'number', description: 'X coordinate in screenshot pixels' },
        y: { type: 'number', description: 'Y coordinate in screenshot pixels' },
        text: { type: 'string', description: 'Text to type (action type)' },
        key: { type: 'string', description: 'Key combo (action key)' },
        app: { type: 'string', description: 'REQUIRED for type/key/click: the app (e.g. Safari)' }
      },
      required: ['action']
    }
  },
  {
    name: 'list-credentials',
    description: 'Lists the vault: secret NAMES ({{secret:NAME}} in commands) and site LOGINS (id, label, origins, TOTP). Values NEVER appear; fill a login with fill_credential.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'find_contacts',
    description: "Searches the user's contacts in the vault (name, email, phone, notes) by keywords: at most 10 results, with the values VISIBLE (they serve to write drafts, which still go through draft_external).",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords (name, email, phone)' }
      },
      required: ['query']
    }
  },
  {
    name: 'update_memory',
    description: 'Writes, updates or deletes a persistent memory. tier core = stable facts, log = dated rules; scope agent = this bot, user = all bots. write creates; update/delete need the id from write or recall.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['write', 'update', 'delete'], description: "Action on the memory" },
        id: { type: 'string', description: 'Memory id (for update/delete)' },
        content: { type: 'string', description: 'The memory content (for write/update)' },
        tier: { type: 'string', enum: ['core', 'log'], description: "core = stable fact, log = operating rule" },
        scope: { type: 'string', enum: ['agent', 'user'], description: "agent = this bot only (default), user = all bots" }
      },
      required: ['action', 'content', 'tier']
    }
  },
  {
    name: 'recall_memory',
    description: "Searches your memories (the bot's own and those shared by the user) by keywords, case-insensitive. Returns the first 10 with id, tier and scope: use the ids for update_memory.",
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search' }
      },
      required: ['query']
    }
  },
  {
    name: 'skill',
    description: 'Loads an available skill. Without file: its full instructions and support-file list. With file: that file content — file must be one of the listed paths.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name (as listed in "# Available skills")' },
        file: { type: 'string', description: 'Optional support file to read (exactly one of the listed paths)' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_skill',
    description: 'Creates or updates a skill (reusable procedure) whose description says WHEN to use it, not only what it does. Needs the user\'s approval; your skills only, imported ones cannot change.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name (1-64 chars, [a-z0-9-], single hyphens)' },
        description: { type: 'string', description: 'When to use the skill — what it does AND when (one line, shown in the system prompt)' },
        content: { type: 'string', description: 'The complete skill instructions (markdown)' }
      },
      required: ['name', 'description', 'content']
    }
  },
  {
    name: 'search_connectors',
    description: 'Searches connectable apps and MCP servers across three sources by trust: verified catalog, plugins, public registry. Each line: id (for offer_connector and friends), source, trust.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords (e.g. "email", "issues", "payments"); empty = the whole catalog' }
      },
      required: ['query']
    }
  },
  {
    name: 'offer_connector',
    description: 'Offers the user to connect a catalog app: a card in chat with a Connect button and your reason. The connection happens only from the user click. Find ids with search_connectors.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Connector id from the catalog (search_connectors)' },
        reason: { type: 'string', description: 'Why this app would help (one sentence, shown in the card)' }
      },
      required: ['id', 'reason']
    }
  },
  {
    name: 'add_mcp_server',
    description: 'Proposes adding an MCP server (registry:<name> from search_connectors, or url:https://…): a card with name, trust and what it needs (OAuth, key, variables); added only by the user click.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'registry:<name> (from search_connectors) or url:https://…' },
        reason: { type: 'string', description: 'Why this server is needed (one sentence, shown in the card)' }
      },
      required: ['id', 'reason']
    }
  },
  {
    name: 'install_plugin',
    description: 'Proposes installing a plugin from a marketplace (plugin:<name>@<marketplace>): a card shows the skills and MCP servers that arrive and what does NOT run here; installed only by the user click.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'plugin:<name>@<marketplace> (from search_connectors)' },
        reason: { type: 'string', description: 'Why this plugin is needed (one sentence, shown in the card)' }
      },
      required: ['id', 'reason']
    }
  },
  {
    name: 'send_to_agent',
    description: "Sends a message to another bot: it arrives as <messaggio_da_agente> evidence and they can reply. ids from list_agents.",
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Recipient bot id (from list_agents)' },
        text: { type: 'string', description: 'Message (self-contained: they do not see this chat)' }
      },
      required: ['agentId', 'text']
    }
  },
  {
    name: 'list_agents',
    description: 'Lists the other bots (name, id, description, status) and your groups (id, members, coordinator).',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'create_agent',
    description: 'Creates another bot: name + COMPLETE ROLE PROMPT (task, deliveries, boundaries). Work arrives via send_to_agent/group.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name' },
        role: { type: 'string', description: 'COMPLETE role prompt' },
        section: { type: 'string', description: 'Sidebar section, e.g. "Dinner team"' }
      },
      required: ['name', 'role']
    }
  },
  {
    name: 'update_agent',
    description: 'Modifies a bot you created (name, role, section).',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Bot id' },
        name: { type: 'string', description: 'New name' },
        role: { type: 'string', description: 'New complete role prompt' },
        section: { type: 'string', description: 'New sidebar section' }
      },
      required: ['agentId']
    }
  },
  {
    name: 'delete_agent',
    description: 'Deletes a bot you created, with chats and memories: ALWAYS asks the user (card). The main bot stays.',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Id of your bot to delete' }
      },
      required: ['agentId']
    }
  },
  {
    name: 'create_group',
    description: 'Creates a work group with some of the bots (you are a member). Then the kickoff in post_to_group.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name' },
        description: { type: 'string', description: 'Purpose and rules' },
        memberIds: { type: 'array', items: { type: 'string' }, description: 'Member ids (max 6; you are added)' },
        coordinatorId: { type: 'string', description: 'Coordinator (a member)' }
      },
      required: ['name', 'description', 'memberIds']
    }
  },
  {
    name: 'update_group',
    description: 'Modifies one of your groups: name, rules, members, coordinator.',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'number', description: 'Group id' },
        name: { type: 'string', description: 'New name' },
        description: { type: 'string', description: 'New rules' },
        addMemberIds: { type: 'array', items: { type: 'string' }, description: 'Ids to add' },
        removeMemberIds: { type: 'array', items: { type: 'string' }, description: 'Ids to remove' },
        coordinatorId: { type: 'string', description: 'New coordinator' }
      },
      required: ['groupId']
    }
  },
  {
    name: 'web_search',
    description: 'Searches the web: title, URL and excerpt per result (5 by default, max 10) with the source used. If disabled or unavailable, say so in one line.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        max_results: { type: 'number', description: 'How many results (default 5, maximum 10)' }
      },
      required: ['query']
    }
  },
  {
    name: 'web_fetch',
    description: 'Downloads and READS a web page as text (no credentials in the URL): max 20,000 characters per call, then continue with offset. Challenge pages (403/429/503, captcha) are not bypassed.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http/https URL of the page' },
        offset: { type: 'number', description: 'Character offset to continue a long page (optional)' }
      },
      required: ['url']
    }
  },
  {
    name: 'post_to_group',
    description: 'Writes a message in one of your groups: the ONLY way to write in the group. In a group turn the group is set; otherwise pass groupId. One message per turn; @name calls a member, @all everyone.',
    parameters: {
      type: 'object',
      properties: {
        groupId: { type: 'number', description: 'Group id (outside group turns; inside it is implicit)' },
        text: { type: 'string', description: 'The message for the group' },
        replyTo: { type: 'number', description: 'Id of the message you reply to (optional)' }
      },
      required: ['text']
    }
  },
  {
    name: 'pass',
    description: 'In group turns: stay silent for this turn (explicit choice). Free text does NOT publish anything in the group: you write only with post_to_group.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'propose_rule_change',
    description: 'Proposes an approval rule in natural language ("continue on your own when…", "always stop when…"), e.g. after many approvals. Saved only if the user accepts.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['allow', 'block'], description: "allow = continue when it matches; block = always ask" },
        text: { type: 'string', description: 'The rule in natural language (one sentence)' },
        why: { type: 'string', description: 'Why it helps (shown in the card)' }
      },
      required: ['kind', 'text']
    }
  },
  {
    name: 'create_task',
    description: 'Opens a TASK for long work in its own thread and context (it does NOT see this chat: the brief carries goal, constraints, sources). It starts when the turn ends; ask_user still reaches the user.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title (shown in the card in chat)' },
        brief: { type: 'string', description: 'The complete task with the necessary context: it is all the task will see of this conversation' }
      },
      required: ['title', 'brief']
    }
  },
  {
    name: 'update_task',
    description: 'Closes one of your tasks with the outcome: status done or failed plus a BRIEF summary, which returns to the main chat. ALWAYS close a task when it ends (or fails).',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Task id (from creation with create_task)' },
        status: { type: 'string', enum: ['done', 'failed'], description: 'Final outcome' },
        summary: { type: 'string', description: 'Brief summary: result, key data, obstacles' }
      },
      required: ['id', 'status', 'summary']
    }
  },
  {
    name: 'spawn_subagent',
    description: 'Launches a subagent in PARALLEL on a self-contained brief (own context, this chat not visible). For INDEPENDENT pieces of work. Brief: goal, boundaries, result format (min 200 characters).',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short work title (shown in the card)' },
        brief: { type: 'string', description: 'goal, boundaries, result format (min 200 characters)' }
      },
      required: ['title', 'brief']
    }
  },
  {
    name: 'check_subagent',
    description: 'The status of one of your subagents: state, elapsed time and deadline, last activity, number of steps; summary and report when it has finished.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Subagent id (sub_…, from the spawn)' } },
      required: ['id']
    }
  },
  {
    name: 'message_subagent',
    description: 'Sends a message to one of your subagents: if queued or working it receives it in its turn; if it had finished (done/failed) this REOPENS it on this message. Stopped and expired ones do not reopen.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Subagent id (sub_…)' },
        text: { type: 'string', description: 'The message for the subagent (updates, corrections, questions)' }
      },
      required: ['id', 'text']
    }
  },
  {
    name: 'stop_subagent',
    description: 'Immediately stops one of your subagents: interrupts its turn and cancels its queued jobs. The batch result still arrives when the others finish.',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Subagent id (sub_…)' } },
      required: ['id']
    }
  },
  {
    name: 'update_state',
    description: 'Modifies your state: target memory acts like the memory tool; target routine does create/update/pause/resume/delete (cron, timezone). New routines start paused.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['routine', 'memory'], description: 'What to modify' },
        action: { type: 'string', enum: ['create', 'update', 'pause', 'resume', 'delete', 'write'], description: 'Action (write: memory)' },
        id: { type: 'number', description: 'Routine id (or memory id as string)' },
        name: { type: 'string', description: 'Routine name (create)' },
        description: { type: 'string', description: 'Description' },
        prompt: { type: 'string', description: 'Prompt the routine runs' },
        schedule: { type: 'string', description: '5-field cron, e.g. "30 8 * * 1-5"' },
        trigger: { type: 'object', description: 'Schedule-type trigger from the app', additionalProperties: true },
        provenance: { type: 'string', enum: ['template', 'agent'], description: "'template' only in a template kickstart" },
        timezone: { type: 'string', description: 'Time zone, e.g. Europe/Rome' },
        activate: { type: 'boolean', description: 'true: ask approval, born active; default born paused' },
        content: { type: 'string', description: 'Memory content' },
        tier: { type: 'string', enum: ['core', 'log'], description: 'Memory tier' },
        scope: { type: 'string', enum: ['agent', 'user'], description: 'Memory scope' }
      },
      required: ['target', 'action']
    }
  },
  {
    name: 'write_document',
    description: 'Saves a library document (Markdown, max 200 KB): no id creates it, with id a NEW version. Charts as ```vega-lite or ```mermaid blocks. The text goes here, NOT in chat: one or two sentences there.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Document title' },
        content: { type: 'string', description: 'The complete GFM Markdown' },
        id: { type: 'string', description: 'Existing document id (lib_…) for a new version (optional)' }
      },
      required: ['title', 'content']
    }
  },
  {
    name: 'edit_document',
    description: 'Modifies a library document with EXACT replacements: each edits[i].old must appear EXACTLY ONCE (the error says how many times); edits apply in order as ONE new version.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id (lib_…)' },
        edits: {
          type: 'array',
          description: 'The edits in order',
          items: {
            type: 'object',
            properties: {
              old: { type: 'string', description: 'The text to replace (unique in the document)' },
              new: { type: 'string', description: 'The new text' }
            },
            required: ['old', 'new']
          }
        }
      },
      required: ['id', 'edits']
    }
  },
  {
    name: 'read_document',
    description: "Reads a library document: the Markdown with title, version and author (version? for a previous version). A document coming from external data arrives as untrusted data.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Document id (lib_…)' },
        version: { type: 'number', description: 'Specific version (optional: default the latest)' }
      },
      required: ['id']
    }
  },
  {
    name: 'visualize',
    description: 'Creates a chart in the library and a card in chat. vega-lite: JSON spec, data only inline (max 5000 rows); mermaid: the source. Never HTML or JavaScript.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Chart title' },
        kind: { type: 'string', enum: ['vega-lite', 'mermaid'], description: 'The chart type' },
        spec: { type: 'string', description: "The Vega-Lite spec (JSON) or the Mermaid source" }
      },
      required: ['title', 'kind', 'spec']
    }
  },
  {
    name: 'save_to_library',
    description: 'Brings a file you produced into the user library (max 50 MB). path like read-file (relative to home or /workspace/…).',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: "File path on the bots' computer" },
        title: { type: 'string', description: 'Library title (default: file name)' }
      },
      required: ['path']
    }
  },
  {
    name: 'list_library',
    description: 'Lists the user library (documents, charts, files): id, type, title, author, version, pinned first (max 20 rows). Filter by kind or title query.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Title filter' },
        kind: { type: 'string', enum: ['document', 'chart', 'file'], description: 'Only this type' },
        limit: { type: 'number', description: 'Max rows (default 20)' }
      },
      required: []
    }
  },
  {
    name: 'export_from_library',
    description: "Exports a library entry to ~/Downloads/Homun (user confirmation): documents as md/html/pdf, charts as svg/mmd, files as they are.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entry id (lib_…)' },
        format: { type: 'string', enum: ['md', 'html', 'pdf', 'svg', 'mmd', 'file'], description: 'Export format' }
      },
      required: ['id', 'format']
    }
  },
  {
    name: 'fill_credential',
    description: 'Fills a vault login into the open browser page: value from vault to field, never through chat, only on its exact origin, approved by card. Requires one of username_ref, password_ref, totp_ref.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Login id (from list-credentials)' },
        username_ref: { type: 'string', description: 'Ref of the username field (optional)' },
        password_ref: { type: 'string', description: 'Ref of the password field (optional)' },
        totp_ref: { type: 'string', description: 'Ref of the TOTP code field (optional)' }
      },
      required: ['id']
    }
  },
  {
    name: 'request_secure_input',
    description: 'Asks sensitive data with a SECURE FORM card (login: origin, username, password, TOTP; secret: name and value): encrypted into the vault; you see only the outcome. To save a credential, use this.',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['login', 'secret'], description: 'What to ask for' },
        label: { type: 'string', description: 'Login label (for kind login)' },
        origin: { type: 'string', description: 'https origin of the site, pre-filled in the form (for kind login, optional)' },
        name: { type: 'string', description: 'Proposed secret name (for kind secret)' },
        reason: { type: 'string', description: 'Why it is needed (one sentence, shown in the form)' }
      },
      required: ['kind', 'reason']
    }
  },
  {
    name: 'save_contact',
    description: "Saves a contact in the user's vault (with their confirmation on a card): name, emails, phones, address and notes. A new contact is saved ONLY with this tool.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Contact name' },
        emails: { type: 'array', items: { type: 'string' }, description: 'Email addresses' },
        phones: { type: 'array', items: { type: 'string' }, description: 'Phone numbers' },
        address: { type: 'string', description: 'Address (optional)' },
        notes: { type: 'string', description: 'Notes (optional)' }
      },
      required: ['name']
    }
  }
]

/**
 * Fase 19a (V5/V6/V7): i tool dello SCHERMO del bot — il computer NEL BOX
 * (dove gira il suo browser), da non confondere con use-app che controlla il
 * MAC dell'utente. Offerti SOLO dove esiste il browser (il loop li aggiunge
 * insieme ai browser_*): senza desktop non hanno senso. request_takeover è
 * per TUTTI i modelli (anche senza visione); computer_observe e computer_act
 * restituiscono un'immagine e vengono tolti quando la visione è falsa.
 */
export const computerToolDefs: ToolDef[] = [
  {
    name: 'request_takeover',
    description:
      'Asks the user to take over your screen for logins, 2FA, CAPTCHA, payments or other human steps. The turn ends; when they are done you receive a message and continue.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Short reason shown to the user (e.g. "login needed on example.com")' }
      },
      required: ['reason']
    }
  },
  {
    name: 'computer_observe',
    description:
      'Captures the screen of YOUR computer in the sandbox (where the browser runs — NOT the user Mac, that is use-app): screen size and the image. Look before coordinate actions.',
    parameters: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'computer_act',
    description:
      'Up to 24 ordered actions on the sandbox screen: click {x,y}, move, down, up, type, key, scroll, wait. Pixel coordinates from computer_observe; ends with a fresh screenshot (observe: false skips).',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description: 'The actions in order',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['click', 'move', 'down', 'up', 'type', 'key', 'scroll', 'wait'], description: 'Action kind' },
              x: { type: 'number', description: 'X in screen pixels (click/move/down/up/scroll)' },
              y: { type: 'number', description: 'Y in screen pixels (click/move/down/up/scroll)' },
              button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button (click)' },
              double: { type: 'boolean', description: 'Double click (click)' },
              text: { type: 'string', description: 'Text to type (type), max 2000 characters' },
              key: { type: 'string', description: 'Key or combo in xdotool syntax (key), e.g. ctrl+l, Return, Tab' },
              direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
              amount: { type: 'number', description: 'Wheel notches 1-20 (scroll, default 3)' },
              ms: { type: 'number', description: 'Milliseconds to wait (wait), max 5000' }
            },
            required: ['kind']
          }
        },
        observe: { type: 'boolean', description: 'True (default) to capture the screen at the end' }
      },
      required: ['actions']
    }
  }
]

/**
 * Fase 12 (punto 3): wake_parent NON sta in toolDefs — esiste solo nel turno
 * del FIGLIO (il loop lo aggiunge alla lista del figlio; nel padre non
 * compare e, se chiamato, riceve il rifiuto).
 */
export const wakeParentToolDef: ToolDef = {
  name: 'wake_parent',
  description: `Closes your work and delivers to the PARENT: status 'done' or 'failed', a CONDENSED summary (max ${WAKE_SUMMARY_MAX_CHARS} characters) and the path of the report you wrote. ALWAYS call it at the end, even if the brief failed.`,
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'failed'], description: 'Final outcome' },
      summary: { type: 'string', description: 'The condensed summary for the parent, with verified links' },
      report_path: { type: 'string', description: 'Path of the detailed report in the shared home (convention: subagents/<your id>/report.md)' }
    },
    required: ['status', 'summary']
  }
}

export interface ToolExecResult {
  output: string
  meta: Record<string, unknown>
  images?: string[]  // base64 (png/jpeg/gif/webp) per modelli vision
}

/** Azione su una memoria (update_memory e update_state target 'memory'). */
function runMemoryAction(agentId: string, input: Record<string, unknown>): ToolExecResult {
  const action = String(input.action ?? 'write')
  if (action === 'write') {
    const content = String(input.content ?? '')
    if (!content.trim()) return { output: 'Empty memory content: nothing written.', meta: {} }
    const r = writeMemory(agentId, {
      content,
      tier: input.tier === 'core' ? 'core' : 'log',
      ...(input.scope === 'user' ? { scope: 'user' as MemoryScope } : {}),
      source: 'agent'
    })
    return { output: `Memory created (id ${r.id}, tier ${r.tier}, scope ${r.scope}).`, meta: { memoryId: r.id } }
  }
  if (action === 'update') {
    const r = updateMemory(agentId, {
      id: String(input.id ?? ''),
      ...(input.content !== undefined ? { content: String(input.content) } : {}),
      ...(input.tier === 'core' || input.tier === 'log' ? { tier: input.tier as MemoryTier } : {}),
      ...(input.scope === 'agent' || input.scope === 'user' ? { scope: input.scope as MemoryScope } : {})
    })
    return { output: `Memory ${r.id} updated (tier ${r.tier}, scope ${r.scope}).`, meta: { memoryId: r.id } }
  }
  if (action === 'delete') {
    const existed = deleteMemory(agentId, String(input.id ?? ''))
    return { output: existed ? `Memory ${input.id} deleted.` : `Memory ${input.id} not found (already deleted?).`, meta: {} }
  }
  return { output: `Invalid memory action: "${action}" (write | update | delete).`, meta: {} }
}

/** Contesto del turno in cui gira il tool (correzione A5): chi ha aperto il turno. */
export interface ToolTurnContext {
  turnInitiator?: string
  /** fase 8 (correzione B3): il turno gira nel sotto-transcript di questo task (dentro un task si chiude SOLO quello). */
  taskId?: number
  /** fase 14 (punto 6): il turno è contaminato (web/email/MCP letti) — le scritture in libreria diventano tainted. */
  contaminated?: boolean
  /** fase 14 (punto 6): il turno è nato da un messaggio diretto dell'utente (solo una sua scrittura pulita toglie tainted). */
  userTurn?: boolean
  /**
   * M3 (fase 0.3.1001): il turno è aperto da un messaggio diretto dell'utente
   * (niente initiator, non automatico, non contaminato) — solo qui
   * update_state create activate:true crea la routine GIÀ ATTIVA dopo la
   * card. Altrove activate è ignorato e la routine nasce in pausa.
   */
  routineActivateOk?: boolean
}

/** Azione su una routine (update_state target 'routine'): validazione cron con parseCron del daemon. */
async function runRoutineAction(agentId: string, input: Record<string, unknown>, ctx: ToolTurnContext = {}): Promise<ToolExecResult> {
  const { parseCron } = await import('../../daemon/cron')
  const { createRoutine, updateRoutine, getRoutine, deleteRoutine } = await import('../store/db')
  const action = String(input.action ?? '')
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

  if (action === 'create') {
    const name = str(input.name)
    const prompt = str(input.prompt)
    if (!name) return { output: 'Routine not created: the name is missing (field name).', meta: {} }
    if (!prompt) return { output: 'Routine not created: the prompt is missing.', meta: {} }
    // fase 7: trigger opzionale di tipo schedule (stessa validazione delle
    // routine utente); poll e webhook restano configurabili solo dall'utente
    let trigger: import('../../shared/types').RoutineTrigger | null = null
    if (input.trigger !== undefined && input.trigger !== null) {
      const t = input.trigger as import('../../shared/types').RoutineTrigger
      if (!t || typeof t !== 'object' || t.type !== 'schedule') {
        return {
          output: 'Invalid trigger: update_state accepts only schedule-type triggers (cron or "every X"); email/webhook/poll triggers are configured by the user in Settings → routines.',
          meta: {}
        }
      }
      // fase 18a (E0): gli errori di forma sono UiText — il result del tool è
      // per il MODELLO, sempre inglese (l'RPC della UI usa uiLanguage())
      const { triggerShapeErrors } = await import('../../shared/triggers')
      const { formatUi } = await import('../../shared/ui-text')
      const errors = triggerShapeErrors(t).map((e) => formatUi(e, 'en'))
      if (t.kind === 'cron' && !parseCron(t.cron)) errors.unshift(`invalid cron: "${t.cron}" (5 fields, e.g. "0 9 * * *")`)
      if (errors.length) return { output: `Invalid trigger: ${errors.join('; ')}.`, meta: {} }
      trigger = t
    }
    const schedule = str(input.schedule) ?? (trigger?.type === 'schedule' && trigger.kind === 'cron' ? trigger.cron : '')
    if (!trigger && (!schedule || !parseCron(schedule))) {
      return { output: `Invalid schedule: "${schedule ?? ''}" — use a 5-field cron, e.g. "0 9 * * *", or a schedule trigger.`, meta: {} }
    }
    // le routine dell'agente nascono SEMPRE in pausa; correzione A5: la
    // provenance 'template' è accettata SOLO nel turno di kickstart di un
    // template (initiator TEMPLATE_IMPORT) — da qualsiasi altro turno la
    // routine è dell'agente.
    // M3 (fase 0.3.1001): create activate:true nel turno DELL'UTENTE nasce
    // GIÀ ATTIVA dopo la card di consenso informato (ask nel gate); le
    // routine da template restano comunque in pausa, e fuori dal turno
    // dell'utente activate è ignorato
    const provenance = input.provenance === 'template' && ctx.turnInitiator === 'TEMPLATE_IMPORT' ? 'template' : 'agent'
    const activate = input.activate === true && ctx.routineActivateOk === true && provenance !== 'template'
    const r = createRoutine(agentId, name, prompt, schedule, {
      enabled: activate ? 1 : 0, provenance,
      description: str(input.description) ?? '', timezone: str(input.timezone) ?? '',
      ...(trigger ? { trigger } : {})
    })
    if (activate) {
      return {
        output: `Routine "${name}" created ACTIVE (id ${r.id}, provenance ${provenance}, schedule "${schedule || 'from trigger'}"): the user approved it with one card and it will run by itself.`,
        meta: { automation: { action: 'create', id: r.id, name, active: true } }
      }
    }
    const why = input.activate === true
      ? ' (activate ignored: the routine was not requested in a direct message from the user, so it is born paused)'
      : ''
    return {
      output: `Routine "${name}" created PAUSED (id ${r.id}, provenance ${provenance}, schedule "${schedule || 'from trigger'}"): it will not run until the user activates it with resume.${why}`,
      meta: { automation: { action: 'create', id: r.id, name } }
    }
  }

  const id = Number(input.id)
  if (!Number.isInteger(id) || id <= 0) return { output: `Invalid routine id: ${JSON.stringify(input.id)} (the numeric id from creation is required).`, meta: {} }
  if (action === 'delete') {
    const cur = getRoutine(id)
    if (!cur) return { output: `Routine ${id} not found.`, meta: {} }
    deleteRoutine(id)
    return { output: `Routine "${cur.title}" (id ${id}) deleted.`, meta: { automation: { action: 'delete', id, name: cur.title } } }
  }
  const cur = getRoutine(id)
  if (!cur) return { output: `Routine ${id} not found: check the id with the user or in Settings → routines.`, meta: {} }

  if (action === 'pause') {
    updateRoutine(id, { enabled: 0 })
    return { output: `Routine "${cur.title}" paused.`, meta: { automation: { action: 'pause', id, name: cur.title } } }
  }
  if (action === 'resume') {
    updateRoutine(id, { enabled: 1 })
    return { output: `Routine "${cur.title}" activated (schedule "${cur.schedule}").`, meta: { automation: { action: 'resume', id, name: cur.title } } }
  }
  if (action === 'update') {
    const schedule = str(input.schedule)
    if (schedule !== undefined && !parseCron(schedule)) {
      return { output: `Invalid schedule: "${schedule}" — use a 5-field cron, e.g. "0 9 * * *".`, meta: {} }
    }
    updateRoutine(id, {
      ...(str(input.name) !== undefined ? { title: str(input.name) } : {}),
      ...(str(input.prompt) !== undefined ? { prompt: str(input.prompt) } : {}),
      ...(schedule !== undefined ? { schedule } : {}),
      ...(str(input.description) !== undefined ? { description: str(input.description) } : {}),
      ...(str(input.timezone) !== undefined ? { timezone: str(input.timezone) } : {})
    })
    return { output: `Routine "${cur.title}" updated.`, meta: { automation: { action: 'update', id, name: str(input.name) ?? cur.title } } }
  }
  return { output: `Invalid routine action: "${action}" (create | update | pause | resume | delete).`, meta: {} }
}

export async function executeTool(
  agentId: string,
  tool: string,
  input: Record<string, unknown>,
  ctx: ToolTurnContext = {}
): Promise<ToolExecResult> {
  switch (tool) {
    case 'run-command': {
      const raw = String(input.command ?? '')
      // §5.6: i riferimenti {{secret:NOME}} si risolvono SOLO qui, al momento
      // dell'esecuzione — il valore entra nell'env del processo, mai nel comando
      const { revealSecret, listSecretNames } = await import('../vault')
      const res = await resolveSecretRefs(raw, revealSecret)
      if (res.missing.length) {
        return {
          output: `Credentials not present in the vault: ${res.missing.join(', ')}. Available names: ${listSecretNames().join(', ') || '(empty)'}`,
          meta: { vault: true, missing: res.missing }
        }
      }
      // fase 11 (punto 3): i comandi LUNGHI girano in background — lo STESSO
      // gate permessi è già passato (sta a monte, nel loop); qui parte e torna
      // subito lo shellId, l'esito arriverà come job SHELL_DONE (o await_shell)
      if (input.background === true) {
        const { startBackgroundShell, backgroundShellPaths } = await import('./shells')
        const started = await startBackgroundShell(agentId, res.command, res.env, res.used.map((s) => s.name))
        if (!started.ok) return { output: started.error, meta: {} }
        return {
          output: `Command started in background (shellId ${started.shellId}): the turn continues. When it finishes you receive a system message with the outcome and last lines, or read it right away with await_shell({shellId: "${started.shellId}"}). Log: ${backgroundShellPaths(started.shellId).log}. Cap: 6 hours.`,
          meta: { shellId: started.shellId, background: true }
        }
      }
      // fase 11b (0a): anche il foreground parte col wrapper costante delle
      // shell in background (riga shell_jobs compresa) e il daemon attende al
      // più la soglia di promozione: finisce → result come prima; non finisce
      // → resta in background (SHELL_DONE / await_shell); tetti pieni → come
      // prima, col timeout e la nota del perché
      const timeoutMs = Math.min(600, Number(input.timeout ?? 120)) * 1000
      const { runForegroundShell } = await import('./shells')
      const r = await runForegroundShell(agentId, res.command, res.env, res.used.map((s) => s.name), { timeoutMs })
      return { output: r.output, meta: r.meta }
    }
    case 'await_shell': {
      // fase 11 (punto 3): attesa/kill di un comando in background — i comandi
      // sono già passati dal gate di run-command all'avvio
      const { awaitShell } = await import('./shells')
      const out = await awaitShell(agentId, String(input.shellId ?? ''), {
        ...(input.timeout_sec !== undefined && input.timeout_sec !== null ? { timeoutSec: Number(input.timeout_sec) } : {}),
        ...(input.kill === true ? { kill: true } : {})
      })
      return { output: out, meta: { shell: true } }
    }
    case 'read-file': {
      let content = await sandbox.readFileInBox(agentId, String(input.path ?? ''))
      const off = Number(input.offset ?? 0)
      const lim = Number(input.limit ?? 0)
      const lines = content.split('\n')
      if (off || lim) content = lines.slice(off, lim ? off + lim : undefined).join('\n')
      if (content.length > 100_000) content = content.slice(0, 100_000) + '\n…[truncated]'
      return { output: content, meta: {} }
    }
    case 'write-file': {
      // fase 19b (T4.1): la scrittura finisce nel feed «Attività» (bytes =
      // lunghezza UTF-8 del contenuto). Un errore nel REGISTRARE non fa
      // fallire il tool (regola di Rakazo: il feed è una vista)
      const path = String(input.path ?? '')
      const content = String(input.content ?? '')
      try {
        await sandbox.writeFileInBox(agentId, path, content)
      } catch (e) {
        const { recordComputerAction } = await import('./computer-activity')
        recordComputerAction({ agentId, kind: 'write_file', target: path, error: e instanceof Error ? e.message : String(e) })
        throw e
      }
      const { recordComputerAction } = await import('./computer-activity')
      recordComputerAction({ agentId, kind: 'write_file', target: path, bytes: Buffer.byteLength(content, 'utf8') })
      return { output: `Written ${input.path}`, meta: {} }
    }
    case 'list-directory': {
      const out = await sandbox.listDirectoryInBox(agentId, String(input.path ?? '.'))
      return { output: out, meta: {} }
    }
    case 'use-app': {
      const { executeUseApp } = await import('../computeruse')
      const r = await executeUseApp(input as unknown as Parameters<typeof executeUseApp>[0])
      // fase use-app (U4): la bandierina dell'Accessibilità mancante arriva al
      // loop, che conta gli errori del turno e ferma tutto al secondo
      return { output: r.output, meta: { computerUse: true, error: r.error ?? false, ...(r.accessibilityError ? { accessibilityError: true } : {}) }, images: r.images }
    }
    case 'list-credentials': {
      // fase 14 (punto 7c): i NOMI dei secret (come prima) + i login senza
      // utente né password (id, etichetta, origini, TOTP sì/no); i contatti
      // non ci sono (hanno find_contacts)
      const { listSecretNames, listLogins } = await import('../vault')
      const names = listSecretNames()
      const logins = await listLogins()
      const lines: string[] = []
      if (names.length) lines.push('SECRET (in commands: {{secret:NAME}}):', ...names.map((n) => `- ${n}`))
      if (logins.length) {
        lines.push(
          'LOGIN (for the browser, filled with fill_credential):',
          ...logins.map((l) => `- ${l.id} · "${l.label}" · ${l.origins.join(', ')}${l.hasTotp ? ' · with TOTP' : ''}`)
        )
      }
      return {
        output: lines.length ? lines.join('\n') : '(vault empty)',
        meta: { vault: true }
      }
    }
    case 'find_contacts': {
      // fase 14 (punto 7f): valori VISIBILI (servono a scrivere bozze, che
      // passano comunque da draft_external); al massimo 10 risultati
      const query = String(input.query ?? '')
      const { searchContacts } = await import('../vault')
      const found = await searchContacts(query)
      if (!found.length) return { output: `No contacts found for "${query.slice(0, 60)}".`, meta: {} }
      const lines = found.map((c) => {
        const bits = [
          c.emails.length ? `email: ${c.emails.join(', ')}` : '',
          c.phones.length ? `tel: ${c.phones.join(', ')}` : '',
          c.address ? `address: ${c.address}` : '',
          c.notes ? `notes: ${c.notes}` : ''
        ].filter(Boolean).join(' · ')
        return `- ${c.name} (${c.id})${bits ? ` · ${bits}` : ''}`
      })
      return { output: lines.join('\n'), meta: { contacts: found.length } }
    }
    case 'write_document': {
      // fase 14 (punto 2): crea o aggiorna il documento; la card la appende il
      // loop da meta.libraryCard (segue la destinazione dei messaggi del turno)
      const { writeDocument, documentResultText } = await import('./library')
      const r = writeDocument(agentId, input, { contaminated: ctx.contaminated, userTurn: ctx.userTurn })
      if (!r.ok) return { output: `Document not saved: ${r.error}`, meta: { error: true } }
      return {
        // R8.1: il result riuscito chiude con la regola del messaggio breve
        output: `${documentResultText(r.value)}\n${WRITE_DOCUMENT_REPLY_RULE}`,
        meta: { libraryCard: { type: 'document', id: r.value.id, title: r.value.title, version: r.value.version } }
      }
    }
    case 'edit_document': {
      const { editDocument, documentResultText } = await import('./library')
      const r = editDocument(agentId, input, { contaminated: ctx.contaminated, userTurn: ctx.userTurn })
      if (!r.ok) return { output: `Document not modified: ${r.error}`, meta: { error: true } }
      return {
        // R8.1: come write, con «what you changed» al posto di «the content»
        output: `${documentResultText(r.value)}\n${EDIT_DOCUMENT_REPLY_RULE}`,
        meta: { libraryCard: { type: 'document', id: r.value.id, title: r.value.title, version: r.value.version } }
      }
    }
    case 'read_document': {
      // fase 14 (punti 2 e 6): il contenuto; se la voce è tainted il meta lo
      // dice e il loop lo incarta nel blocco dato esterno (+ contaminazione)
      const { readDocument } = await import('./library')
      const r = readDocument(input)
      if (!r.ok) return { output: r.error, meta: { error: true } }
      const v = r.value
      const header = `# ${v.title}\n(version ${v.version} by ${v.authorName}${v.versions.length > 1 ? `, versions: ${v.versions.join(', ')}` : ''})\n\n`
      return {
        output: header + v.content,
        meta: { libraryRead: v.id, ...(v.tainted ? { libraryTainted: v.id } : {}) }
      }
    }
    case 'visualize': {
      // fase 14 (punto 3): validazione + resa SVG nel daemon; la card la
      // appende il loop da meta.libraryCard
      const { saveChart } = await import('./library')
      const r = await saveChart(agentId, input, { contaminated: ctx.contaminated, userTurn: ctx.userTurn })
      if (!r.ok) return { output: `Chart not created: ${r.error}`, meta: { error: true } }
      return {
        output: `Chart "${r.value.title}" (${r.value.id}, ${r.value.kind}) saved in the library.`,
        meta: { libraryCard: { type: 'chart', id: r.value.id, title: r.value.title } }
      }
    }
    case 'save_to_library': {
      // fase 14 (punto 4): nessuna card di conferma — la libreria è interna
      const { getSaveFileFromBox } = await import('./library')
      const r = await getSaveFileFromBox()(agentId, input, {}, { contaminated: ctx.contaminated, userTurn: ctx.userTurn })
      if (!r.ok) return { output: `File not saved to the library: ${r.error}`, meta: { error: true } }
      return {
        output: `File "${r.value.title}" (${r.value.id}, ${r.value.name}, ${r.value.size} bytes) saved in the library.`,
        meta: {}
      }
    }
    case 'list_library': {
      // fase 14 (punto 4): se c'è almeno una voce tainted l'INTERO result è
      // un dato esterno (il meta lo dice, il loop incarta e contamina)
      const { listLibrary, formatLibraryRows } = await import('./library')
      const { rows, anyTainted } = listLibrary(input)
      return { output: formatLibraryRows(rows), meta: { ...(anyTainted ? { libraryTainted: 'list' } : {}) } }
    }
    case 'update_memory':
      return runMemoryAction(agentId, input)
    case 'web_search': {
      // fase 15 (S2/S6): la CATENA dei provider (chiave Ollama se c'è, poi i
      // keyless You.com → Exa → Tavily) con passaggio automatico al successivo;
      // senza chiave la ricerca FUNZIONA lo stesso. L'output resta DATO NON
      // FIDATO per il loop (blocco evidenza + contaminazione)
      const query = String(input.query ?? '').trim()
      if (!query) return { output: 'Missing query: write the search in the query field.', meta: {} }
      const { searchWeb, webSearchToolOutput, clampMaxResults, WEB_SEARCH_INACTIVE, WEB_SEARCH_UNAVAILABLE } = await import('./web-tools')
      const r = await searchWeb(query, clampMaxResults(input.max_results))
      if (!r.ok) {
        return {
          output: r.error === 'inactive' ? WEB_SEARCH_INACTIVE : WEB_SEARCH_UNAVAILABLE,
          // il motivo per provider (tipo e status) per la UI — MAI la query
          meta: r.error === 'all-failed' ? { searchFailed: r.failures } : {}
        }
      }
      return {
        output: webSearchToolOutput(r.results, r.provider.label),
        meta: { webContent: r.results.length > 0, results: r.results.length, provider: r.provider.name }
      }
    }
    case 'web_fetch': {
      // fase 11 (punto 2): lettura LOCALE con difese SSRF, limiti e conversione;
      // cache per URL di 15 minuti; al modello al più 20k caratteri con offset
      const { getWebFetchFn, webFetchWindowOutput } = await import('./web-tools')
      const rawUrl = String(input.url ?? '')
      const offset = input.offset !== undefined && input.offset !== null ? Number(input.offset) : undefined
      const outcome = await getWebFetchFn()(rawUrl)
      if (!outcome.ok) {
        return {
          output: outcome.reason,
          meta: { ...(outcome.blocked ? { blocked: true } : {}), ...(outcome.unsupported ? { unsupported: true } : {}) }
        }
      }
      // fase 11b (punto 2): pagina costruita in JavaScript e browser
      // disponibile → il result lo dice al modello (con un blocco o un captcha
      // non si arriva qui: nessun suggerimento da quelle pagine)
      let hint = ''
      if (outcome.jsBuilt) {
        try {
          const { browserAvailable } = await import('./browser')
          const { JS_PAGE_HINT } = await import('./web-guard')
          if (browserAvailable()) hint = '\n\n' + JS_PAGE_HINT
        } catch {
          // browser non interrogabile: nessun suggerimento
        }
      }
      return {
        output: webFetchWindowOutput(outcome.text, offset) + hint,
        meta: { webContent: true, finalUrl: outcome.finalUrl, ...(outcome.jsBuilt ? { jsBuilt: true } : {}) }
      }
    }
    case 'recall_memory': {
      // fase 12 (punto 1): il figlio legge la memoria del PADRE (sola lettura:
      // update_memory non è nella whitelist del figlio)
      const owner = sandbox.boxOwnerOf(agentId)
      const found = searchMemoriesByQuery(listMemories(owner), String(input.query ?? ''))
      if (!found.length) return { output: NO_MEMORY_FOUND, meta: {} }
      const lines = found.map((r) => `- [${r.id}] (${r.tier}/${r.scope}, aggiornata ${new Date(r.updatedAt).toISOString().slice(0, 10)}) ${r.content.replace(/\n+/g, ' ')}`)
      return { output: lines.join('\n'), meta: { memoryIds: found.map((r) => r.id) } }
    }
    case 'skill': {
      // fase skill (S3.2): senza file le istruzioni + l'elenco dei file di
      // supporto; con file SOLO se il percorso è esattamente uno dell'elenco.
      // fase 12: le skill del figlio sono quelle del PADRE. Una skill
      // importata (GitHub o plugin) è testo NON FIDATO: meta.webContent → il
      // loop mette il blocco dati esterni e contamina il turno (decisione 3).
      // K5 (fase skill · catalogo): una skill «solo con /» NON si carica da
      // qui — né intera né a pezzi col tool
      const name = String(input.name ?? '')
      const file = input.file === undefined ? undefined : String(input.file)
      const base = readSkillFor(agentId, name)
      if (base?.userOnly) return { output: SKILL_USER_ONLY_REFUSAL, meta: {} }
      if (file === undefined) {
        if (!base) return { output: `Skill "${name}" not found (or not enabled for this bot).`, meta: {} }
        return { output: base.output, meta: { skill: name, ...(base.webContent ? { webContent: true } : {}) } }
      }
      const f = readSkillFileFor(agentId, name, file)
      if (!f) {
        return {
          output: base
            ? `No file "${file}" in this skill. The files are:\n${base.files.map((x) => `- ${x}`).join('\n')}`
            : `Skill "${name}" not found (or not enabled for this bot).`,
          meta: {}
        }
      }
      return { output: f.output, meta: { skill: name, file, ...(f.webContent ? { webContent: true } : {}) } }
    }
    case 'update_skill': {
      // fase skill (S3.3): la libreria unica — crea con enabledFor [questo
      // bot] e source 'bot'; aggiorna mantenendo enabledFor; rifiuta plugin
      // e importate; un nome già usato da una skill NON visibile è un errore
      const r = writeSkillFromBot(agentId, {
        name: String(input.name ?? ''),
        description: String(input.description ?? ''),
        content: String(input.content ?? '')
      })
      if (!r.ok) return { output: r.error, meta: {} }
      return {
        output: `Skill "${r.name}" ${r.created ? 'created (enabled for this bot only: the user chooses which other bots use it)' : 'updated'} — immediately available in "# Available skills".`,
        meta: { skill: r.name }
      }
    }
    case 'search_connectors': {
      // fase 13 (punto 1): la porta unica su tre fonti — il runner del daemon
      // porta catalogo + marketplace + registro; il meta dice se ci sono righe
      // DI TERZI (registro/marketplace): il loop le mette nel blocco dati
      // esterni e contamina il turno
      const { runConnectorsSearch } = await import('../connectors/search-runtime')
      const out = await runConnectorsSearch(String(input.query ?? ''))
      return { output: out.text, meta: out.thirdParty ? { thirdParty: true } : {} }
    }
    case 'update_state': {
      if (input.target === 'memory') return runMemoryAction(agentId, input)
      if (input.target === 'routine') return runRoutineAction(agentId, input, ctx)
      return { output: `Invalid update_state target: ${JSON.stringify(input.target)} (routine | memory).`, meta: {} }
    }
    case 'list_agents': {
      // fase 7: gli ALTRI bot dell'utente; fase 10: anche i gruppi di cui il
      // bot è membro (id, membri, coordinatore) per post_to_group
      const dbMod = await import('../store/db')
      const groupsMod = await import('../store/groups')
      const others = dbMod.listAgents().filter((a) => a.id !== agentId)
      const lines = others.length
        ? others.map((a) => `- ${a.name} (id ${a.id}) · status: ${a.status}${a.description ? ` · ${a.description}` : ''}`)
        : ['No other bots: you are the user\'s only agent.']
      const nameOf = (id: string): string => dbMod.listAgents().find((a) => a.id === id)?.name ?? id
      const groups = groupsMod.groupsOfMember(agentId)
      if (groups.length) {
        lines.push('', 'GROUPS you belong to (write with post_to_group; @name calls a member, @all = everyone):')
        for (const g of groups) {
          const members = groupsMod.groupMemberIds(g.id).map(nameOf)
          lines.push(`- ${g.name} (group id ${g.id}, members: ${members.join(', ')})${g.coordinator_id ? ` — coordinator: ${nameOf(g.coordinator_id)}` : ''}`)
        }
      }
      return { output: lines.join('\n'), meta: {} }
    }
    case 'create_agent': {
      // fase 10 (punto 1): il bot crea altri bot — role è il prompt di ruolo
      // completo e diventa la description; NESSUN kickstart (difetto di Grok):
      // il bot nuovo non riceve turni finché qualcuno non gli scrive
      const name = String(input.name ?? '').trim()
      const role = String(input.role ?? '').trim()
      const section = input.section !== undefined ? String(input.section ?? '').trim() : ''
      if (!name || !role) {
        return { output: 'Bot not created: name and role are required (the complete role prompt: task, who it delivers to, what NOT to do without the user\'s ok).', meta: {} }
      }
      const dbMod = await import('../store/db')
      if (dbMod.listAgents().length >= MAX_AGENTS_TOTAL) {
        return { output: `Bot not created: there are already ${MAX_AGENTS_TOTAL} bots (the cap). Delete one with delete_agent or talk to the user about it.`, meta: {} }
      }
      const created = dbMod.createAgent(name, role, { createdBy: agentId, ...(section ? { section } : {}) })
      // fase 16c (C3.3): con models.main il bot nuovo nasce «Come gli altri»
      // (null/null: seguirà il principale quando cambia); senza, il turno di
      // sempre — defaultModel del provider attivo (capability "tools"
      // verificata), ripiego sul modello del creatore
      const { assignDefaultModel, newAgentModel } = await import('./model-defaults')
      type ModelDefaultsMap = import('./model-defaults').ModelDefaultsMap
      let providerId: string | null = null
      let model: string | null = null
      let followsMain = false
      try {
        const providersMod = await import('./providers')
        const main = dbMod.getSetting<import('../../shared/types').MainModel | null>('models.main', null)
        if (newAgentModel(main) === 'follows-main') {
          followsMain = true
        } else {
          const assignment = await assignDefaultModel({
            listProviders: dbMod.listProviders,
            getOverrides: () => dbMod.getSetting<ModelDefaultsMap>('providers.modelDefaults', {}),
            // come la RPC agents:create-from-template: il provider completo si
            // risolve per id (la dipendenza accetta la forma ridotta)
            supportsTools: (p, m) => {
              const full = providersMod.getProvider(p.id)
              return full
                ? providersMod.modelSupportsTools(full, m)
                : Promise.resolve({ ok: false, checked: false, error: 'provider not found' })
            }
          })
          if (assignment?.model) {
            providerId = assignment.providerId
            model = assignment.model
          }
        }
      } catch {
        // verifica non disponibile: sotto col ripiego, i modelli del creatore
      }
      if (!followsMain && !model) {
        // fase 16c correzioni (R3.3): il ripiego sul modello del CREATORE
        // passa da resolveAgentModel (main = null: qui interessa SOLO il
        // modello proprio) — con l'elenco dei provider attivi la copia avviene
        // solo se il provider del creatore è ancora collegato (regola R3.6:
        // provider, modello e credenziale vincono insieme); se no il figlio
        // nasce null/null e segue il principale, come un bot nuovo
        const { resolveAgentModel } = await import('../../shared/agent-model')
        const creator = dbMod.getAgent(agentId)
        const resolvedCreator = resolveAgentModel(
          creator ?? {},
          null,
          dbMod.listProviders().map((x) => ({ id: x.id, enabled: x.enabled }))
        )
        if (resolvedCreator && !resolvedCreator.followsMain) {
          providerId = resolvedCreator.providerId
          model = resolvedCreator.model
        }
      }
      if (!followsMain && providerId && model) dbMod.updateAgent(created.id, { providerId, model })
      return {
        output: `Bot "${name}" created (id ${created.id}${section ? `, section "${section}"` : ''}), ${followsMain ? 'model follows the main model (same as the others)' : `provider ${providerId ?? '—'} model ${model ?? 'NOT assigned'}`}. The role you gave it is its description. It does NOT start on its own and does NOT greet the user: write to it yourself (send_to_agent) or assign it work in the group.`,
        meta: { createdAgentId: created.id }
      }
    }
    case 'update_agent': {
      // fase 10 (punto 1): senza card solo per i PROPRI bot (il loop bypassa il
      // gate); per gli altri la card è il consenso dell'utente. Il principale mai.
      const dbMod = await import('../store/db')
      const target = dbMod.getAgent(String(input.agentId ?? ''))
      if (!target) return { output: `Bot not found ("${String(input.agentId ?? '')}"): find the exact id with list_agents.`, meta: {} }
      // fase 12 (punto 1): un id di FIGLIO non si aggiorna da qui
      const refusal = dbMod.subagentRefusal(target.id)
      if (refusal) return { output: refusal, meta: {} }
      const main = (await import('../../daemon/presence')).mainAgentOf(dbMod.listAgents(), dbMod.getSetting<string | null>('mainAgentId', null))
      if (main?.id === target.id) {
        return { output: 'The main bot cannot be modified from tools: it is the user\'s point of contact.', meta: {} }
      }
      const patch: { name?: string; description?: string; section?: string } = {}
      if (input.name !== undefined && String(input.name).trim()) patch.name = String(input.name).trim()
      if (input.role !== undefined && String(input.role).trim()) patch.description = String(input.role).trim()
      if (input.section !== undefined) patch.section = String(input.section ?? '').trim()
      if (!Object.keys(patch).length) {
        return { output: 'Nothing to update: name, role or section is required.', meta: {} }
      }
      dbMod.updateAgent(target.id, patch)
      return { output: `Bot "${target.name}" updated (${Object.keys(patch).join(', ')}).`, meta: { updatedAgentId: target.id } }
    }
    case 'delete_agent': {
      // fase 10 (punto 1): SEMPRE con card (il gate chiede) e SOLO bot creati
      // da questo agente — l'esecuzione ricontrolla comunque la proprietà
      const dbMod = await import('../store/db')
      const { cancelAgentJobs } = await import('../store/jobs')
      const target = dbMod.getAgent(String(input.agentId ?? ''))
      if (!target) return { output: `Bot not found ("${String(input.agentId ?? '')}").`, meta: {} }
      const main = (await import('../../daemon/presence')).mainAgentOf(dbMod.listAgents(), dbMod.getSetting<string | null>('mainAgentId', null))
      if (main?.id === target.id) {
        return { output: 'The main bot cannot be deleted.', meta: {} }
      }
      // fase 12 (punto 1): un id di FIGLIO non si elimina da qui (muore col padre)
      const delRefusal = dbMod.subagentRefusal(target.id)
      if (delRefusal) return { output: delRefusal, meta: {} }
      if (target.createdBy !== agentId) {
        return { output: `"${target.name}" is not a bot you created: you can only delete your own. Talk to the user or the creator.`, meta: {} }
      }
      // come agents:delete della RPC: prima si ferma il turno, poi la coda
      const loopMod = await import('./loop')
      loopMod.interrupt(target.id)
      cancelAgentJobs(dbMod.db(), target.id)
      const elections = dbMod.deleteAgent(target.id)
      // fase 16b (S1.1): i gruppi che hanno eletto un nuovo coordinatore
      // ricevono la riga di sistema nel gruppo
      if (elections.length) {
        const groupsMod = await import('../store/groups')
        for (const el of elections) {
          const name = dbMod.getAgent(el.coordinatorId)?.name ?? el.coordinatorId
          groupsMod.addGroupMessage({
            groupId: el.groupId, authorKind: 'system', authorId: null, authorName: 'sistema',
            text: coordinatorNowText(name)
          })
        }
      }
      return {
        output: `Bot "${target.name}" deleted with its chats, memories and routines.`,
        meta: { deletedAgentId: target.id, ...(elections.length ? { groupChanged: elections[0]!.groupId } : {}) }
      }
    }
    case 'create_group': {
      // fase 10 (punto 2): max 6 bot + l'utente; il creatore entra se manca
      const name = String(input.name ?? '').trim()
      const description = String(input.description ?? '').trim()
      const memberIds = [...new Set(Array.isArray(input.memberIds) ? input.memberIds.map((m) => String(m)) : [])]
      if (!name || !description) {
        return { output: 'Group not created: name and description are required (purpose and rules: every member reads them on every turn).', meta: {} }
      }
      const dbMod = await import('../store/db')
      const groupsMod = await import('../store/groups')
      const agents = dbMod.listAgents()
      // fase 12 (punto 1): un id di figlio non è un bot — messaggio esplicito
      for (const id of memberIds) {
        const refusal = dbMod.subagentRefusal(id)
        if (refusal) return { output: `Group not created: ${refusal}.`, meta: {} }
      }
      const missing = memberIds.filter((id) => !agents.some((a) => a.id === id))
      if (missing.length) {
        return { output: `Group not created: these ids are not existing bots (${missing.join(', ')}): find the ids with list_agents.`, meta: {} }
      }
      const coordinatorId = input.coordinatorId !== undefined && input.coordinatorId !== null ? String(input.coordinatorId) : null
      const total = new Set([...memberIds, agentId])
      if (coordinatorId && !total.has(coordinatorId)) {
        return { output: 'The coordinator must be a member of the group: add it to the memberIds.', meta: {} }
      }
      if (total.size > MAX_GROUP_MEMBERS) {
        return { output: `Too many members: a group has at most ${MAX_GROUP_MEMBERS} bots (including you) besides the user.`, meta: {} }
      }
      // fase 16b (S1.1): senza coordinatorId il coordinatore è chi crea il
      // gruppo (già membro automatico): un gruppo senza coordinatore non esiste
      const group = groupsMod.createGroup(name, description, agentId, memberIds, coordinatorId)
      const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
      const members = groupsMod.groupMemberIds(group.id).map(nameOf)
      return {
        output: `Group "${name}" created (group id ${group.id}). Members: ${members.join(', ')} + the user (always in). Coordinator: ${nameOf(group.coordinator_id ?? agentId)}. Now write the kickoff message with post_to_group({groupId: ${group.id}, text}): goal, constraints, who does what with @mentions.`,
        meta: { groupChanged: group.id }
      }
    }
    case 'update_group': {
      // fase 10 (punto 2): il creatore senza card (loop pre-gate), i membri con
      // card; i non membri non possono toccare il gruppo
      const dbMod = await import('../store/db')
      const groupsMod = await import('../store/groups')
      const groupId = Number(input.groupId)
      const group = groupsMod.getGroup(groupId)
      if (!group) return { output: `Group ${Number.isFinite(groupId) ? groupId : JSON.stringify(input.groupId)} not found.`, meta: {} }
      if (group.created_by !== agentId && !groupsMod.isGroupMember(groupId, agentId)) {
        return { output: `You are not a member of the group "${group.name}": you cannot modify it.`, meta: {} }
      }
      const add = [...new Set(Array.isArray(input.addMemberIds) ? input.addMemberIds.map((m) => String(m)) : [])]
      const remove = [...new Set(Array.isArray(input.removeMemberIds) ? input.removeMemberIds.map((m) => String(m)) : [])]
      // fase 16b correzioni (P4): l'ESITO si valida PRIMA di modificare —
      // membri finali = (attuali + aggiunte − rimozioni), 1 ≤ n ≤ 6. Vale per
      // TUTTE le squadre (anche create dall'utente, dove la regola «il creatore
      // non si toglie» non protegge nessuno): al rifiuto non si applica NIENTE,
      // nemmeno nome e descrizione.
      const finalMembers = new Set([...groupsMod.groupMemberIds(groupId), ...add].filter((id) => !remove.includes(id)))
      if (finalMembers.size < 1 || finalMembers.size > MAX_GROUP_MEMBERS) {
        return { output: `A group needs between 1 and ${MAX_GROUP_MEMBERS} bots: nothing was changed.`, meta: {} }
      }
      if (input.name !== undefined || input.description !== undefined) {
        groupsMod.updateGroup(groupId, {
          ...(input.name !== undefined && String(input.name).trim() ? { name: String(input.name).trim() } : {}),
          ...(input.description !== undefined && String(input.description).trim() ? { description: String(input.description).trim() } : {})
        })
      }
      const agents = dbMod.listAgents()
      if (add.length) {
        // fase 12 (punto 1): un id di figlio non è un bot — messaggio esplicito
        for (const id of add) {
          const refusal = dbMod.subagentRefusal(id)
          if (refusal) return { output: `Member not added: ${refusal}.`, meta: { groupChanged: groupId } }
        }
        const missing = add.filter((id) => !agents.some((a) => a.id === id))
        if (missing.length) {
          return { output: `Members not added: non-existent ids (${missing.join(', ')}). The rest of the update is already applied.`, meta: { groupChanged: groupId } }
        }
        for (const id of add) groupsMod.addGroupMember(groupId, id)
      }
      if (remove.includes(group.created_by)) {
        return { output: 'The group creator cannot be removed with tools: if needed, talk to the user.', meta: { groupChanged: groupId } }
      }
      for (const id of remove) {
        groupsMod.removeGroupMember(groupId, id)
        groupsMod.cancelMemberGroupJobs(dbMod.db(), groupId, id)
      }
      // fase 16b (S1.1): il coordinatore non si TOGLIE, si CAMBIA — senza un
      // nome nuovo il rifiuto spiega la regola; se il coordinatore è uscito
      // dai membri, il primo rimasto prende il posto (riga di sistema nel gruppo)
      const coordinatorLeft = group.coordinator_id !== null && remove.includes(group.coordinator_id)
      if (input.coordinatorId === null && !coordinatorLeft) {
        return {
          output: 'A group always has a coordinator: pass the new coordinatorId (a member). To replace the current one just set coordinatorId; if the coordinator leaves the group, the first remaining member takes over.',
          meta: { groupChanged: groupId }
        }
      }
      let coordinatorNote = ''
      const noteCoordinator = (): void => {
        const g2 = groupsMod.getGroup(groupId)
        const coordId = g2?.coordinator_id ?? null
        if (!g2 || !coordId) return
        const coordName = dbMod.getAgent(coordId)?.name ?? coordId
        groupsMod.addGroupMessage({
          groupId, authorKind: 'system', authorId: null, authorName: 'sistema',
          text: coordinatorNowText(coordName)
        })
        coordinatorNote = ` ${coordName} now coordinates the team.`
      }
      if (input.coordinatorId !== undefined && input.coordinatorId !== null) {
        const coord = String(input.coordinatorId)
        if (!groupsMod.isGroupMember(groupId, coord)) {
          return { output: 'The coordinator must be a member of the group (add it first with addMemberIds).', meta: { groupChanged: groupId } }
        }
        if (coord !== group.coordinator_id) {
          groupsMod.updateGroup(groupId, { coordinator_id: coord })
          noteCoordinator()
        }
      } else if (coordinatorLeft) {
        // removeGroupMember ha già eletto il primo membro rimasto
        noteCoordinator()
      }
      return { output: `Group "${groupsMod.getGroup(groupId)?.name ?? group.name}" updated.${coordinatorNote}`, meta: { groupChanged: groupId } }
    }
    case 'update_task': {
      // fase 8 (§3bis L7): chiusura del task — il summary torna alla chat
      // principale come job TASK_DONE (il bot riferisce in un messaggio breve)
      const id = Number(input.id)
      const status = input.status === 'failed' ? 'failed' : input.status === 'done' ? 'done' : null
      if (!Number.isInteger(id) || id <= 0 || !status) {
        return { output: 'Invalid update_task: id, status ("done" | "failed") and summary are required.', meta: {} }
      }
      const { getTask, updateTask, db } = await import('../store/db')
      const { enqueueJob } = await import('../store/jobs')
      const t = getTask(id)
      if (!t) return { output: `Task ${id} not found.`, meta: {} }
      // correzione B3: solo task PROPRI (chiudere il task di un altro bot
      // manderebbe il summary nella SUA chat, senza le protezioni di
      // send_to_agent) e, dentro un task, solo quello CORRENTE
      if (t.agent_id !== agentId) {
        return { output: `The task "${t.title}" (id ${id}) is not yours: you cannot close it. If needed, talk to the user or the bot that opened it.`, meta: {} }
      }
      if (ctx.taskId !== undefined && ctx.taskId !== id) {
        return { output: `You are in task no. ${ctx.taskId}: from here you can close ONLY that one (update_task with id ${ctx.taskId}).`, meta: {} }
      }
      if (t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') {
        return { output: `Task "${t.title}" is already ${t.status}: it does not reopen.`, meta: {} }
      }
      const summary = String(input.summary ?? '')
      updateTask(id, { status, ...(summary ? { summary } : {}) })
      const now = Date.now()
      enqueueJob(db(), {
        agentId: t.agent_id,
        kind: 'user-message',
        payload: {
          // correzione B1: il summary in un blocco EVIDENZA delimitato, con il
          // tag di chiusura neutralizzato (il task può aver letto testo
          // esterno) — come per <messaggio_da_agente>
          text: [
            formatTaskDone(t.title, id, status, summary),
            // fase risposta: la risposta all'utente è il testo normale della
            // risposta finale, non più una chiamata di strumento
            'The task has ended: write the user a SHORT final reply about the outcome and at most one next step, without repeating all the work.'
          ].join('\n'),
          initiator: 'TASK_DONE',
          // taskRef (NON taskId): il loop filtra le entry dei task per
          // meta.taskId e questo messaggio deve restare nella chat principale
          extraMeta: { taskTitle: t.title, taskRef: id },
          // correzione B1: l'origine del task arriva anche al turno TASK_DONE
          // (automatic → outbox/tetto urgent; untrusted → niente auto-review)
          ...(t.automatic ? { automatic: true } : {}),
          ...(t.untrusted ? { untrusted: true } : {})
        },
        runAt: now,
        now
      })
      return { output: `Task "${t.title}" closed (${status}): the summary returned to the main chat, which will report to the user.`, meta: { task: id } }
    }
    default: {
      if (tool.startsWith('mcp__') || tool.startsWith('composio__')) {
        const { callTool, McpNeedsReconnectError } = await import('../mcp')
        try {
          const out = await callTool(tool, input)
          return { output: out.slice(0, 30_000), meta: { mcp: true } }
        } catch (e) {
          // fase 5: token scaduto → il loop mostra la card "Riconnetti"
          if (e instanceof McpNeedsReconnectError) {
            return {
              output: e.message,
              meta: { mcp: true, needsReconnect: { serverName: e.serverName, connectorId: e.serverId } }
            }
          }
          // fase app (A5): una chiamata Composio senza rete NON blocca il
          // turno — l'errore ripulito torna al modello come risultato
          if (tool.startsWith('composio__')) {
            const { sanitizeComposioError } = await import('../connectors/composio-actions')
            return { output: `Error: ${sanitizeComposioError(e)}`, meta: { mcp: true, error: true } }
          }
          throw e
        }
      }
      throw new Error(`Unknown tool: ${tool}`)
    }
  }
}
