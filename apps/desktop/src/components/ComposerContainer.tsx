import { Bot, Bug, ListTodo, MessageCircle } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  coreBridge,
  type ChatAttachmentInput,
  type ProviderModelsGroup,
  type RuntimeContextResponse,
  type SkillsSummary,
} from "../lib/coreBridge";
import { fileLocalPathFromBridge } from "../lib/gatewayConfig";
import { selectedModelAfterSubmission } from "../lib/composerTurnContract";
import {
  isLocalOllamaProvider,
  RUNTIME_MODELS_CHANGED_EVENT,
} from "../lib/providerPresets";
import { ComposerShell, type ComposerModeOption } from "./ComposerShell";
import type { ChatMessage } from "../types";

export interface ReplyContext {
  messageId: string;
  role: ChatMessage["role"];
  preview: string;
}

/** Composer interaction modes (Cursor-style, adapted for a general assistant).
 *  Debug is project-only (coding context); the others fit any chat. */
type ChatMode = "agent" | "plan" | "ask" | "debug";
const CHAT_MODES: {
  key: ChatMode;
  label: string;
  desc: string;
  icon: typeof Bot;
  projectOnly?: boolean;
}[] = [
  { key: "agent", label: "Agent", desc: "Reasons, uses tools and acts", icon: Bot },
  { key: "plan", label: "Plan", desc: "Proposes a plan and waits for OK before acting", icon: ListTodo },
  { key: "ask", label: "Ask", desc: "Replies and converses, without tools or actions", icon: MessageCircle },
  { key: "debug", label: "Debug", desc: "Systematic debugging (code projects)", icon: Bug, projectOnly: true },
];

function describeBridgeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Local gateway unreachable in this view.";
  }

  if (error.message.includes("Gateway")) {
    return "Local gateway not yet available: using the direct local runtime when possible.";
  }

  return error.message;
}

function messageRoleLabel(role: ChatMessage["role"]) {
  if (role === "assistant") return "assistant";
  if (role === "system") return "system";
  return "user";
}

/** Reads a Blob as a base64 string (without the `data:...;base64,` prefix). */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function fileLocalPath(file: File): string {
  // Electron >= 32 removed File.path; resolve via webUtils.getPathForFile (preload
  // bridge). Falls back to the legacy property for any older shell, then "".
  const viaBridge = fileLocalPathFromBridge(file);
  if (viaBridge) return viaBridge;
  const fileWithPath = file as File & { path?: string };
  return fileWithPath.path ?? "";
}

// Owns mutable composer state, prompt-adjacent bridge calls, and submission
// envelope assembly. ChatView owns transcript/turn orchestration.
export function ComposerContainer({
  activeWork,
  disabled,
  effectiveModelLabel,
  runtimeContext,
  runtimeContextLoading,
  runtimeContextError,
  error,
  replyContext,
  seed,
  suggestedModel,
  streaming,
  threadId,
  onCancelStreaming,
  onClearReply,
  onManualModelSelection,
  onRefreshRuntimeContext,
  onSuggestedModelConsumed,
  onSubmit,
}: {
  activeWork: boolean;
  disabled: boolean;
  effectiveModelLabel: string;
  runtimeContext: RuntimeContextResponse | null;
  runtimeContextLoading: boolean;
  runtimeContextError: boolean;
  error: string | null;
  replyContext: ReplyContext | null;
  seed: { text: string; nonce: number } | null;
  suggestedModel: { value: string; nonce: number } | null;
  streaming: boolean;
  threadId: string;
  onCancelStreaming: () => void;
  onClearReply: () => void;
  onManualModelSelection: () => void;
  onRefreshRuntimeContext: () => void | Promise<void>;
  onSuggestedModelConsumed: () => void;
  onSubmit: (
    prompt: string,
    attachments: ChatAttachmentInput[],
    options?: {
      model?: string;
      mode?: string;
      forcedSkillsId?: string;
      contextText?: string;
      images?: string[];
    },
  ) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [submitBusy, setSubmitBusy] = useState(false);
  // External task surfaces may seed the composer; nonce lets the same value re-apply.
  useEffect(() => {
    if (seed && seed.text) setValue(seed.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);
  const [linkedFolder, setLinkedFolder] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [folderPathInput, setFolderPathInput] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [contextFiles, setContextFiles] = useState<
    Array<{ path: string; content: string; truncated: boolean }>
  >([]);
  const [models, setModels] = useState<string[]>([]);
  const [modelGroups, setModelGroups] = useState<ProviderModelsGroup[]>([]);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  // Per-message model override. null = "Auto" (use this thread's resolved role:
  // coding in a linked project, orchestrator otherwise). A picked value is the
  // composite "<provider_id>::<model>", so the same model id present in two
  // providers resolves to the provider the user actually chose.
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  useEffect(() => {
    if (suggestedModel?.value) setSelectedModel(suggestedModel.value);
  }, [suggestedModel?.nonce, suggestedModel?.value]);
  // Interaction mode (composer pill, Cursor-style): agent | plan | ask | debug.
  // Debug is offered only when a project folder is linked (coding context).
  const [chatMode, setChatMode] = useState<ChatMode>("agent");

  // Refetches the model list + default resolved for THIS thread + per-provider groups.
  // Called on mount and when the menu opens, so a Settings change reflects without an
  // app restart. Does NOT touch the user's selection (Auto stays Auto unless they pick).
  // Runs at most once per mount: if the runtime list is empty, the provider's
  // model catalog was never fetched into the registry — populate it so the picker
  // isn't empty (this is why it only appeared after visiting Settings, which also
  // refreshes). Returns the model count so the mount effect can retry past the
  // gateway-startup race. Guarded by a ref so retries don't re-hit the network.
  const modelsSelfHealedRef = useRef(false);
  async function refreshModels(): Promise<number> {
    try {
      let list = await coreBridge.runtimeModels(threadId);
      if (!modelsSelfHealedRef.current) {
        modelsSelfHealedRef.current = true;
        const provs = await coreBridge.providers().catch(() => null);
        const catalogsMissingModels = (provs?.providers ?? []).filter(
          (provider) =>
            provider.enabled &&
            provider.models.length === 0 &&
            isLocalOllamaProvider(provider.kind, provider.base_url),
        );
        if (catalogsMissingModels.length > 0) {
          for (const provider of catalogsMissingModels) {
            await coreBridge.refreshProviderModels(provider.id).catch(() => null);
          }
          list = await coreBridge.runtimeModels(threadId);
        }
      }
      setModels(list.available ?? []);
      setModelGroups(list.groups ?? []);
      setActiveModel(list.active);
      return (list.available ?? []).length;
    } catch {
      return 0; // gateway not ready yet — the mount effect retries
    }
  }
  const [skills, setSkillss] = useState<SkillsSummary[]>([]);
  const [forcedSkills, setForcedSkills] = useState<SkillsSummary | null>(null);
  const [composerConnectors, setComposerConnectors] = useState<
    Awaited<ReturnType<typeof coreBridge.mcpConnected>>
  >([]);
  const [improving, setImproving] = useState(false);
  const [improveError, setImproveError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [dictationError, setDictationError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const [composerAttachmentError, setComposerAttachmentError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<
    Array<{ id: string; name: string; size: number; type: string; localPath: string }>
  >([]);
  const [composerImages, setComposerImages] = useState<
    Array<{ id: string; name: string; dataUrl: string }>
  >([]);
  const [dragOver, setDragOver] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (replyContext) {
      textareaRef.current?.focus();
    }
  }, [replyContext]);

  // Cursor ready in the composer when you open or switch a chat — type right away,
  // no extra click. rAF so it runs after the new thread's layout settles.
  useEffect(() => {
    const id = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [threadId]);

  // When the assistant FINISHES responding (streaming true→false), return the cursor to
  // the composer so the user can type the next message immediately — no extra click.
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !streaming) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
    wasStreaming.current = streaming;
  }, [streaming]);

  // The runtime model list can be empty for a moment right after launch/onboarding
  // (gateway still settling, registry just written). Poll until it resolves so the
  // model picker isn't absent on the first turn — without a manual reload. Stops as
  // soon as it's populated; capped so an unconfigured app doesn't poll forever.
  useEffect(() => {
    if (models.length > 0 || activeModel) return undefined;
    let attempts = 0;
    const id = window.setInterval(() => {
      attempts += 1;
      if (attempts > 20) {
        window.clearInterval(id);
        return;
      }
      void refreshModels();
    }, 1200);
    return () => window.clearInterval(id);
  }, [models.length, activeModel, threadId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!cancelled) await refreshModels();
      try {
        const response = await coreBridge.skills();
        if (cancelled) return;
        setSkillss((response.skills ?? []).filter((skill) => skill.enabled));
      } catch {
        /* skills unavailable → picker hidden */
      }
      try {
        const connected = await coreBridge.mcpConnected();
        if (!cancelled) setComposerConnectors(connected);
      } catch {
        if (!cancelled) setComposerConnectors([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const refreshAfterProviderChange = () => {
      modelsSelfHealedRef.current = false;
      void refreshModels();
    };
    window.addEventListener(RUNTIME_MODELS_CHANGED_EVENT, refreshAfterProviderChange);
    return () =>
      window.removeEventListener(RUNTIME_MODELS_CHANGED_EVENT, refreshAfterProviderChange);
  }, [threadId]);

  async function startDictation() {
    setDictationError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      audioChunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => void finishDictation();
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      setDictationError(t("chat.micUnavailable"));
    }
  }

  function stopDictation() {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    setRecording(false);
  }

  async function finishDictation() {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
    const blob = new Blob(audioChunksRef.current, {
      type: mediaRecorderRef.current?.mimeType || "audio/webm",
    });
    audioChunksRef.current = [];
    if (blob.size === 0) return;
    setTranscribing(true);
    try {
      const base64 = await blobToBase64(blob);
      const text = await coreBridge.transcribe(base64);
      if (text) {
        setValue((current) => (current.trim() ? `${current.trim()} ${text}` : text));
        requestAnimationFrame(() => {
          adjustComposerHeight();
          textareaRef.current?.focus();
        });
      }
    } catch (error) {
      setDictationError(describeBridgeError(error));
    } finally {
      setTranscribing(false);
    }
  }

  // Load the conversation's linked folder; reset @ state when the thread changes.
  useEffect(() => {
    let cancelled = false;
    setContextFiles([]);
    setFileResults([]);
    void (async () => {
      try {
        const { path } = await coreBridge.threadFolder(threadId);
        if (!cancelled) setLinkedFolder(path);
      } catch {
        if (!cancelled) setLinkedFolder(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  async function searchContextFiles(query: string) {
    if (!linkedFolder) return;
    try {
      setFileResults(await coreBridge.searchThreadFiles(threadId, query));
    } catch {
      setFileResults([]);
    }
  }

  async function linkFolderPath(path: string) {
    const trimmed = path.trim();
    if (!trimmed) return;
    setFolderBusy(true);
    setFolderError(null);
    try {
      const result = await coreBridge.setThreadFolder(threadId, trimmed);
      setLinkedFolder(result.path);
      setFolderPathInput("");
    } catch (error) {
      setFolderError(describeBridgeError(error));
    } finally {
      setFolderBusy(false);
    }
  }

  async function browseFolder() {
    if (folderBusy) return;
    setFolderBusy(true);
    setFolderError(null);
    try {
      const path = await coreBridge.pickFolder();
      if (path) {
        const result = await coreBridge.setThreadFolder(threadId, path);
        setLinkedFolder(result.path);
      } else {
        setFolderError("Picker unavailable: paste the folder path below.");
      }
    } catch (error) {
      setFolderError(describeBridgeError(error));
    } finally {
      setFolderBusy(false);
    }
  }

  function unlinkFolder() {
    void coreBridge.setThreadFolder(threadId, null).catch(() => undefined);
    setLinkedFolder(null);
    setContextFiles([]);
    setFileResults([]);
  }

  async function addContextFile(path: string) {
    if (contextFiles.some((file) => file.path === path)) {
      return;
    }
    try {
      const file = await coreBridge.readThreadFile(threadId, path);
      setContextFiles((current) => [...current, file]);
    } catch {
      /* unreadable file → ignore */
    }
    textareaRef.current?.focus();
  }

  function buildContextText(): string | undefined {
    if (contextFiles.length === 0) return undefined;
    const blocks = contextFiles.map((file) => {
      const note = file.truncated ? " (truncated)" : "";
      return `### File: ${file.path}${note}\n\`\`\`\n${file.content}\n\`\`\``;
    });
    return `Context from files attached from the linked folder:\n\n${blocks.join("\n\n")}`;
  }

  async function handleImprovePrompt() {
    const draft = value.trim();
    if (!draft || improving || disabled) return;
    setImproving(true);
    setImproveError(null);
    try {
      const improved = await coreBridge.improvePrompt(draft);
      if (improved && improved !== draft) {
        setValue(improved);
        requestAnimationFrame(() => {
          adjustComposerHeight();
          textareaRef.current?.focus();
        });
      }
    } catch (error) {
      setImproveError(describeBridgeError(error));
    } finally {
      setImproving(false);
    }
  }

  function adjustComposerHeight() {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
  }

  async function submitCurrentValue() {
    const prompt = value.trim();
    // Allow images-only messages (vision); supply a sensible default prompt.
    if ((!prompt && composerImages.length === 0) || disabled || submitBusy) return;
    if (attachments.some((attachment) => !attachment.localPath)) {
      setComposerAttachmentError("Local path not available in this shell.");
      return;
    }
    const attachmentInputs = attachments.map((attachment) => ({
      localPath: attachment.localPath,
      displayName: attachment.name,
      mimeType: attachment.type,
      sizeBytes: attachment.size,
    }));
    const images = composerImages.map((image) => image.dataUrl);
    const effectivePrompt = prompt || "Describe this image.";
    // null = Auto (no override → default role); else the composite "<provider>::<model>".
    const modelOverride = selectedModel ?? undefined;
    const forcedSkillsId = forcedSkills?.id;
    const contextText = buildContextText();
    const submittedAttachmentIds = new Set(attachments.map((item) => item.id));
    const submittedImageIds = new Set(composerImages.map((item) => item.id));
    const clearSubmittedEnvelope = () => {
      setValue((current) => current === value ? "" : current);
      setAttachments((current) => current.filter((item) => !submittedAttachmentIds.has(item.id)));
      setComposerImages((current) => current.filter((item) => !submittedImageIds.has(item.id)));
      setContextFiles([]);
      setComposerAttachmentError(null);
      requestAnimationFrame(adjustComposerHeight);
    };
    if (!activeWork) clearSubmittedEnvelope();
    setSubmitBusy(true);
    const accepted = await onSubmit(effectivePrompt, attachmentInputs, {
      model: modelOverride,
      mode: chatMode === "agent" ? undefined : chatMode,
      forcedSkillsId,
      contextText,
      images: images.length > 0 ? images : undefined,
    }).catch(() => false);
    setSubmitBusy(false);
    if (activeWork && accepted) clearSubmittedEnvelope();
    setSelectedModel((current) => selectedModelAfterSubmission(current, accepted));
    if (accepted && suggestedModel && modelOverride === suggestedModel.value) {
      onSuggestedModelConsumed();
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitCurrentValue();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    void submitCurrentValue();
  }

  function handleValueChange(event: ChangeEvent<HTMLTextAreaElement>) {
    setValue(event.target.value);
    requestAnimationFrame(adjustComposerHeight);
  }

  function handleAttachmentSelect(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    setAttachments((current) => [
      ...current,
      ...files.map((file) => ({
        id: `${file.name}_${file.size}_${file.lastModified}`,
        name: file.name,
        size: file.size,
        type: file.type || "file",
        localPath: fileLocalPath(file),
      })),
    ]);
    event.target.value = "";
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((item) => item.id !== id));
  }

  // Reads image files (paste/drop) into base64 data URLs for vision models.
  function addImageFiles(files: File[]) {
    const images = files.filter((file) => file.type.startsWith("image/"));
    images.forEach((file) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const dataUrl = String(reader.result);
        if (!dataUrl.startsWith("data:image/")) return;
        setComposerImages((current) => [
          ...current,
          { id: `${file.name}_${file.size}_${file.lastModified}_${current.length}`, name: file.name, dataUrl },
        ]);
      };
      reader.readAsDataURL(file);
    });
  }

  function removeComposerImage(id: string) {
    setComposerImages((current) => current.filter((item) => item.id !== id));
  }

  function handleComposerPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData?.files ?? []);
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length > 0) {
      event.preventDefault();
      addImageFiles(images);
    }
  }

  function handleComposerDrop(event: DragEvent<HTMLFormElement>) {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (files.length === 0) {
      setDragOver(false);
      return;
    }
    event.preventDefault();
    // Images → vision (base64 inline); everything else (PDF, docs, text) →
    // attachment with its on-disk path, same as the paperclip picker.
    const images = files.filter((file) => file.type.startsWith("image/"));
    const others = files.filter((file) => !file.type.startsWith("image/"));
    if (images.length > 0) addImageFiles(images);
    if (others.length > 0) {
      setAttachments((current) => [
        ...current,
        ...others.map((file) => ({
          id: `${file.name}_${file.size}_${file.lastModified}`,
          name: file.name,
          size: file.size,
          type: file.type || "file",
          localPath: fileLocalPath(file),
        })),
      ]);
    }
    setDragOver(false);
  }

  const modeOptions: ComposerModeOption[] = CHAT_MODES.map((option) => ({
    key: option.key,
    label: option.label,
    description: option.desc,
    icon: option.icon,
    available: !option.projectOnly || linkedFolder != null,
  }));
  return (
    <ComposerShell
      value={value}
      disabled={disabled}
      activeWork={activeWork}
      streaming={streaming}
      submitting={submitBusy}
      dragOver={dragOver}
      textareaRef={textareaRef}
      fileInputRef={fileInputRef}
      reply={replyContext
        ? {
            label: `Reply to ${messageRoleLabel(replyContext.role)}`,
            preview: replyContext.preview,
          }
        : null}
      attachments={attachments}
      images={composerImages}
      contextFiles={contextFiles}
      forcedCapability={forcedSkills}
      capabilities={skills}
      connectors={composerConnectors}
      linkedFolder={linkedFolder}
      folderBusy={folderBusy}
      folderError={folderError}
      fileResults={fileResults}
      models={models}
      modelGroups={modelGroups}
      selectedNextTurnModel={selectedModel}
      effectiveModelLabel={effectiveModelLabel}
      runtimeContext={runtimeContext}
      runtimeContextLoading={runtimeContextLoading}
      runtimeContextError={runtimeContextError}
      mode={chatMode}
      modeOptions={modeOptions}
      environmentLabel={linkedFolder ? t("composer.projectEnvironment") : t("composer.localEnvironment")}
      recording={recording}
      transcribing={transcribing}
      improving={improving}
      errors={[error, improveError, composerAttachmentError, dictationError]}
      onSubmit={handleSubmit}
      onValueChange={handleValueChange}
      onKeyDown={handleKeyDown}
      onPaste={handleComposerPaste}
      onDrop={handleComposerDrop}
      onDragOverChange={setDragOver}
      onAttachmentSelect={handleAttachmentSelect}
      onRemoveReply={onClearReply}
      onRemoveAttachment={removeAttachment}
      onRemoveImage={removeComposerImage}
      onRemoveContextFile={(path) =>
        setContextFiles((current) => current.filter((item) => item.path !== path))
      }
      onRemoveCapability={() => setForcedSkills(null)}
      onSelectCapability={(capability) => {
        setForcedSkills(capability);
        textareaRef.current?.focus();
      }}
      onSearchFiles={(query) => void searchContextFiles(query)}
      onSelectContextFile={(path) => void addContextFile(path)}
      onBrowseFolder={() => void browseFolder()}
      onLinkFolder={(path) => void linkFolderPath(path)}
      onUnlinkFolder={unlinkFolder}
      onRefreshModels={() => void refreshModels()}
      onRefreshRuntimeContext={onRefreshRuntimeContext}
      onSelectModel={(model) => {
        onManualModelSelection();
        setSelectedModel(model);
      }}
      onSelectMode={(mode) => setChatMode(mode as ChatMode)}
      onImprovePrompt={() => void handleImprovePrompt()}
      onVoice={() => (recording ? stopDictation() : void startDictation())}
      onStop={onCancelStreaming}
    />
  );
}
