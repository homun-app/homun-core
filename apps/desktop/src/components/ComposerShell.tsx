import {
  ArrowUp,
  AtSign,
  Bot,
  Check,
  ChevronRight,
  Cloud,
  FolderOpen,
  HardDrive,
  Loader2,
  Mic,
  Monitor,
  Paperclip,
  Plus,
  Puzzle,
  Search,
  Settings2,
  Square,
  WandSparkles,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useMemo,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import * as layeredMenuState from "../lib/layeredMenuState";
import type {
  McpConnectedServer,
  ProviderModelsGroup,
  RuntimeContextResponse,
  SkillsSummary,
} from "../lib/coreBridge";
import { modelIsCloud } from "../lib/coreBridge";
import { composerModelButtonLabel } from "../lib/composerTurnContract";
import { runtimeContextView } from "../lib/runtimeContext";
import { RuntimeContextPanel } from "./RuntimeContextPanel";
import { IconButton } from "./ui/IconButton";
import { MenuSurface } from "./ui/MenuSurface";

export interface ComposerAttachmentView {
  id: string;
  name: string;
  size: number;
  localPath: string;
}

export interface ComposerImageView {
  id: string;
  name: string;
  dataUrl: string;
}

export interface ComposerContextFileView {
  path: string;
}

export interface ComposerModeOption {
  key: string;
  label: string;
  description: string;
  icon: LucideIcon;
  available: boolean;
}

export interface ComposerShellProps {
  value: string;
  disabled: boolean;
  activeWork: boolean;
  streaming: boolean;
  submitting: boolean;
  dragOver: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  reply: { label: string; preview: string } | null;
  attachments: ComposerAttachmentView[];
  images: ComposerImageView[];
  contextFiles: ComposerContextFileView[];
  forcedCapability: SkillsSummary | null;
  capabilities: SkillsSummary[];
  connectors: McpConnectedServer[];
  linkedFolder: string | null;
  folderBusy: boolean;
  folderError: string | null;
  fileResults: string[];
  models: string[];
  modelGroups: ProviderModelsGroup[];
  selectedNextTurnModel: string | null;
  effectiveModelLabel: string;
  runtimeContext: RuntimeContextResponse | null;
  runtimeContextLoading: boolean;
  runtimeContextError: boolean;
  mode: string;
  modeOptions: ComposerModeOption[];
  environmentLabel: string;
  recording: boolean;
  transcribing: boolean;
  improving: boolean;
  errors: Array<string | null>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onValueChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onDrop: (event: DragEvent<HTMLFormElement>) => void;
  onDragOverChange: (dragOver: boolean) => void;
  onAttachmentSelect: (event: ChangeEvent<HTMLInputElement>) => void;
  onRemoveReply: () => void;
  onRemoveAttachment: (id: string) => void;
  onRemoveImage: (id: string) => void;
  onRemoveContextFile: (path: string) => void;
  onRemoveCapability: () => void;
  onSelectCapability: (capability: SkillsSummary) => void;
  onSearchFiles: (query: string) => void;
  onSelectContextFile: (path: string) => void;
  onBrowseFolder: () => void;
  onLinkFolder: (path: string) => void;
  onUnlinkFolder: () => void;
  onRefreshModels: () => void;
  onRefreshRuntimeContext: () => void | Promise<void>;
  onSelectModel: (model: string | null) => void;
  onSelectMode: (mode: string) => void;
  onImprovePrompt: () => void;
  onVoice: () => void;
  onStop: () => void;
}

type MenuAction =
  | { type: "open-root"; id: "add" | "model" | "mode" | "runtime" }
  | { type: "open-nested"; id: "files" | "capabilities" | "connectors" | "models" }
  | { type: "close-current" }
  | { type: "close-all" };

const initialMenuState: layeredMenuState.LayeredMenuState = {
  chain: [],
  restoreFocusId: null,
};

function menuReducer(state: layeredMenuState.LayeredMenuState, action: MenuAction) {
  if (action.type === "open-root") {
    return layeredMenuState.openLayer(state, action.id, `composer-${action.id}-trigger`);
  }
  if (action.type === "open-nested") {
    return layeredMenuState.openLayer(state, action.id, null, true);
  }
  if (action.type === "close-current") return layeredMenuState.escapeLayer(state);
  return layeredMenuState.closeAllLayers(state);
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function ComposerShell(props: ComposerShellProps) {
  const { t } = useTranslation();
  const [menuState, dispatchMenu] = useReducer(menuReducer, initialMenuState);
  const [addQuery, setAddQuery] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [capabilityQuery, setCapabilityQuery] = useState("");
  const [modelQuery, setModelQuery] = useState("");
  const [folderPath, setFolderPath] = useState("");
  const addRef = useMemo<RefObject<HTMLElement | null>>(() => ({
    get current() {
      return document.getElementById("composer-add-trigger");
    },
  }), []);
  const modelRef = useRef<HTMLButtonElement>(null);
  const modeRef = useRef<HTMLButtonElement>(null);
  const runtimeRef = useRef<HTMLButtonElement>(null);
  const filesRef = useRef<HTMLButtonElement>(null);
  const capabilitiesRef = useRef<HTMLButtonElement>(null);
  const connectorsRef = useRef<HTMLButtonElement>(null);
  const modelsRef = useRef<HTMLButtonElement>(null);
  const rootOpen = (id: "add" | "model" | "mode" | "runtime") =>
    menuState.chain[0] === id;
  const layerOpen = (id: string) => layeredMenuState.layerIsOpen(menuState, id);
  const childOpen = (id: string) => menuState.chain[1] === id;
  const closeAll = () => dispatchMenu({ type: "close-all" });
  const closeCurrent = () => dispatchMenu({ type: "close-current" });
  const openRoot = (id: "add" | "model" | "mode" | "runtime") => {
    if (rootOpen(id)) {
      closeAll();
      return;
    }
    if (id === "model") props.onRefreshModels();
    dispatchMenu({ type: "open-root", id });
  };
  const openNested = (id: "files" | "capabilities" | "connectors" | "models") => {
    if (id === "models") props.onRefreshModels();
    if (id === "files" && props.linkedFolder) props.onSearchFiles("");
    dispatchMenu({ type: "open-nested", id });
  };

  const query = addQuery.trim().toLowerCase();
  const matchesAdd = (label: string) => !query || label.toLowerCase().includes(query);
  const availableModes = props.modeOptions.filter((option) => option.available);
  const filteredCapabilities = props.capabilities.filter((capability) => {
    const q = capabilityQuery.trim().toLowerCase();
    return !q || `${capability.name} ${capability.id} ${capability.description}`.toLowerCase().includes(q);
  });
  const filteredGroups = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    const source = props.modelGroups.length > 0
      ? props.modelGroups
      : [{ provider_id: "", label: t("chat.models"), models: props.models }];
    return source
      .map((group) => ({
        ...group,
        models: q
          ? group.models.filter((model) =>
              model.toLowerCase().includes(q) || group.label.toLowerCase().includes(q))
          : group.models,
      }))
      .filter((group) => group.models.length > 0);
  }, [modelQuery, props.modelGroups, props.models, t]);
  const folderName = props.linkedFolder
    ? props.linkedFolder.replace(/\/+$/, "").split("/").pop() || props.linkedFolder
    : null;
  const modeLabel = availableModes.find((option) => option.key === props.mode)?.label ?? props.mode;
  const canSend = Boolean(props.value.trim() || props.images.length > 0);
  const hasModels = props.models.length > 0 || props.modelGroups.some((group) => group.models.length > 0);
  const modelButtonLabel = composerModelButtonLabel(
    props.effectiveModelLabel,
    props.selectedNextTurnModel,
    t("composer.runtime.unavailable"),
    t("composer.auto"),
    props.runtimeContext,
  );
  const runtimeView = runtimeContextView(props.runtimeContext, props.selectedNextTurnModel);

  const selectModel = (model: string | null) => {
    props.onSelectModel(model);
    setModelQuery("");
    closeAll();
  };

  const renderModelRows = () => (
    <div className="composer-menu-list composer-model-list">
      <button
        type="button"
        role="menuitemradio"
        aria-checked={props.selectedNextTurnModel === null}
        className="menu-item"
        onClick={() => selectModel(null)}
      >
        <span className="menu-item__leading" aria-hidden="true">
          {props.selectedNextTurnModel === null ? <Check size={14} /> : null}
        </span>
        <span className="menu-item__label">
          <strong>{t("composer.auto")}</strong>
          <small>{t("composer.nextTurnOnly")}</small>
        </span>
        <span className="menu-item__trailing" />
      </button>
      {filteredGroups.map((group) => (
        <div className="composer-model-group" key={group.provider_id || group.label}>
          <div className="composer-model-group-label">{group.label}</div>
          {group.models.map((modelId) => {
            const value = group.provider_id ? `${group.provider_id}::${modelId}` : modelId;
            const picked = props.selectedNextTurnModel === value;
            const cloud = modelIsCloud(group.base_url, modelId);
            return (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={picked}
                className="menu-item"
                onClick={() => selectModel(value)}
              >
                <span className="menu-item__leading" aria-hidden="true">
                  {picked ? <Check size={14} /> : null}
                </span>
                <span className="menu-item__label">{modelId}</span>
                <span className="menu-item__trailing" title={cloud ? t("composer.cloud") : t("composer.local")}>
                  {cloud ? <Cloud size={13} /> : <HardDrive size={13} />}
                </span>
              </button>
            );
          })}
        </div>
      ))}
      {filteredGroups.length === 0 ? <p className="composer-menu-empty">{t("chat.noModels")}</p> : null}
    </div>
  );

  return (
    <form
      className={`composer-surface${props.dragOver ? " drag-over" : ""}`}
      aria-label={t("chat.operationalPrompt")}
      onSubmit={props.onSubmit}
      onDrop={props.onDrop}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer?.items ?? []).some((item) => item.kind === "file")) {
          event.preventDefault();
          props.onDragOverChange(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) props.onDragOverChange(false);
      }}
    >
      {props.reply ? (
        <div className="reply-context-card" aria-label={t("chat.quotedMessage")}>
          <AtSign size={14} />
          <div><strong>{props.reply.label}</strong><span>{props.reply.preview}</span></div>
          <button type="button" aria-label={t("chat.removeQuote")} onClick={props.onRemoveReply}><X size={14} /></button>
        </div>
      ) : null}
      {props.images.length > 0 ? (
        <div className="composer-image-tray" aria-label={t("chat.attachedImages")}>
          {props.images.map((image) => (
            <span className="composer-image-thumb" key={image.id}>
              <img src={image.dataUrl} alt={image.name} />
              <button type="button" aria-label={`${t("composer.remove")} ${image.name}`} onClick={() => props.onRemoveImage(image.id)}><X size={12} /></button>
            </span>
          ))}
        </div>
      ) : null}
      {props.attachments.length > 0 ? (
        <div className="composer-attachment-tray" aria-label={t("chat.selectedAttachments")}>
          {props.attachments.map((attachment) => (
            <span className="composer-attachment-item" key={attachment.id}>
              <Paperclip size={13} /><span>{attachment.name}</span><small>{formatFileSize(attachment.size)}</small>
              {!attachment.localPath ? <small>{t("chat.pathUnavailable")}</small> : null}
              <button type="button" aria-label={`${t("composer.remove")} ${attachment.name}`} onClick={() => props.onRemoveAttachment(attachment.id)}><X size={13} /></button>
            </span>
          ))}
        </div>
      ) : null}
      {props.forcedCapability ? (
        <div className="composer-forced-skill" aria-label={t("chat.forcedCapabilityNextMessage")}>
          <Puzzle size={13} /><span>{props.forcedCapability.name}</span>
          <button type="button" aria-label={t("composer.removeCapability")} onClick={props.onRemoveCapability}><X size={12} /></button>
        </div>
      ) : null}
      {props.contextFiles.length > 0 ? (
        <div className="composer-context-files" aria-label={t("chat.filesAttachedAsContext")}>
          {props.contextFiles.map((file) => (
            <span className="composer-file-chip" key={file.path} title={file.path}>
              <AtSign size={12} /><span>{file.path.split("/").pop()}</span>
              <button type="button" aria-label={`${t("composer.remove")} ${file.path}`} onClick={() => props.onRemoveContextFile(file.path)}><X size={11} /></button>
            </span>
          ))}
        </div>
      ) : null}
      {props.errors.filter(Boolean).map((error, index) => <span className="composer-error" key={`${error}-${index}`}>{error}</span>)}

      <div className="composer-prompt-row">
        <input hidden multiple ref={props.fileInputRef} type="file" onChange={props.onAttachmentSelect} />
        <IconButton
          id="composer-add-trigger"
          className="composer-add-button"
          size="sm"
          label={t("composer.add")}
          tooltip={t("composer.add")}
          pressed={rootOpen("add")}
          disabled={props.disabled}
          aria-haspopup="menu"
          aria-expanded={rootOpen("add")}
          onClick={() => openRoot("add")}
        ><Plus size={18} /></IconButton>
        <textarea
          aria-label={t("chat.requestForAssistant")}
          disabled={props.disabled}
          onChange={props.onValueChange}
          onKeyDown={props.onKeyDown}
          onPaste={props.onPaste}
          placeholder={t("chat.composerPlaceholder")}
          ref={props.textareaRef}
          value={props.value}
        />
        <div className="composer-primary-actions">
          <IconButton
            className={props.recording ? "recording" : undefined}
            size="sm"
            label={props.recording ? t("chat.stopDictation") : t("chat.voiceDictation")}
            tooltip={props.recording ? t("chat.stopAndTranscribe") : t("chat.voiceDictationMultilingual")}
            disabled={props.transcribing}
            onClick={props.onVoice}
          >
            {props.transcribing ? <Loader2 size={17} className="composer-spin" /> : props.recording ? <Square size={13} /> : <Mic size={17} />}
          </IconButton>
          {props.streaming ? (
            <IconButton className="composer-stop-button" size="sm" label={t("chat.interruptResponse")} tooltip={t("chat.interruptResponse")} onClick={props.onStop}><Square size={13} /></IconButton>
          ) : canSend ? (
            <IconButton className="send-button" size="sm" label={props.activeWork ? t("chat.queueInstruction") : t("chat.send")} tooltip={props.activeWork ? t("chat.queueInstruction") : t("chat.send")} disabled={props.disabled || props.submitting} type="submit">
              {props.submitting ? <Loader2 size={18} className="composer-spin" /> : <ArrowUp size={18} />}
            </IconButton>
          ) : null}
        </div>
      </div>

      <div className="composer-metadata-row">
        <button id="composer-mode-trigger" ref={modeRef} type="button" aria-label={t("composer.mode")} aria-haspopup="menu" aria-expanded={rootOpen("mode")} onClick={() => openRoot("mode")}><Bot size={13} /><span>{modeLabel}</span></button>
        <button id="composer-model-trigger" ref={modelRef} className="composer-model-button" type="button" aria-label={t("composer.model")} title={modelButtonLabel} aria-haspopup="menu" aria-expanded={rootOpen("model")} onClick={() => openRoot("model")}><span>{modelButtonLabel}</span><Settings2 size={13} /></button>
        <span className="composer-metadata-item" aria-label={t("composer.environment")}><Monitor size={13} /><span>{props.environmentLabel}</span></span>
        <button id="composer-runtime-trigger" ref={runtimeRef} className="composer-runtime-button" type="button" aria-label={t("composer.runtimeContext")} title={t("composer.runtimeContext")} aria-haspopup="dialog" aria-expanded={rootOpen("runtime")} onClick={() => { props.onRefreshRuntimeContext(); openRoot("runtime"); }}><Settings2 size={13} /></button>
      </div>

      <MenuSurface id="composer-add-menu" chainId="composer" label={t("composer.add")} open={rootOpen("add")} anchorRef={addRef} search={{ value: addQuery, onChange: setAddQuery, placeholder: t("composer.searchAdd") }} onCloseCurrent={closeCurrent} onCloseAll={closeAll}>
        <div className="composer-menu-list">
          {matchesAdd(t("composer.mode")) ? <button type="button" role="menuitem" className="menu-item" onClick={() => openRoot("mode")}><span className="menu-item__leading"><Bot size={14} /></span><span className="menu-item__label">{t("composer.mode")}</span><span className="menu-item__trailing"><ChevronRight size={14} /></span></button> : null}
          {matchesAdd(t("composer.attachment")) ? <button type="button" role="menuitem" className="menu-item" onClick={() => { closeAll(); props.fileInputRef.current?.click(); }}><span className="menu-item__leading"><Paperclip size={14} /></span><span className="menu-item__label">{t("composer.attachment")}</span><span className="menu-item__trailing" /></button> : null}
          {matchesAdd(t("composer.files")) ? <button ref={filesRef} type="button" role="menuitem" className="menu-item" aria-haspopup="menu" aria-expanded={layerOpen("files")} onClick={() => openNested("files")}><span className="menu-item__leading"><FolderOpen size={14} /></span><span className="menu-item__label">{t("composer.files")}</span><span className="menu-item__trailing"><ChevronRight size={14} /></span></button> : null}
          {hasModels && matchesAdd(t("composer.models")) ? <button ref={modelsRef} type="button" role="menuitem" className="menu-item" aria-haspopup="menu" aria-expanded={layerOpen("models")} onClick={() => openNested("models")}><span className="menu-item__leading"><Settings2 size={14} /></span><span className="menu-item__label">{t("composer.models")}</span><span className="menu-item__trailing"><ChevronRight size={14} /></span></button> : null}
          {props.capabilities.length > 0 && matchesAdd(t("composer.capabilities")) ? <button ref={capabilitiesRef} type="button" role="menuitem" className="menu-item" aria-haspopup="menu" aria-expanded={layerOpen("capabilities")} onClick={() => openNested("capabilities")}><span className="menu-item__leading"><Puzzle size={14} /></span><span className="menu-item__label">{t("composer.capabilities")}</span><span className="menu-item__trailing"><ChevronRight size={14} /></span></button> : null}
          {props.connectors.length > 0 && matchesAdd(t("composer.connectors")) ? <button ref={connectorsRef} type="button" role="menuitem" className="menu-item" aria-haspopup="menu" aria-expanded={layerOpen("connectors")} onClick={() => openNested("connectors")}><span className="menu-item__leading"><Settings2 size={14} /></span><span className="menu-item__label">{t("composer.connectors")}</span><span className="menu-item__trailing"><ChevronRight size={14} /></span></button> : null}
          {props.value.trim() && matchesAdd(t("chat.improvePrompt")) ? <button type="button" role="menuitem" className="menu-item" onClick={() => { closeAll(); props.onImprovePrompt(); }}><span className="menu-item__leading">{props.improving ? <Loader2 size={14} className="composer-spin" /> : <WandSparkles size={14} />}</span><span className="menu-item__label">{t("chat.improvePrompt")}</span><span className="menu-item__trailing" /></button> : null}
        </div>
      </MenuSurface>

      <MenuSurface id="composer-mode-menu" chainId="composer" label={t("composer.mode")} open={rootOpen("mode")} anchorRef={modeRef} onCloseCurrent={closeCurrent} onCloseAll={closeAll}>
        <div className="composer-menu-list">{availableModes.map((option) => { const Icon = option.icon; return <button key={option.key} type="button" role="menuitemradio" aria-checked={props.mode === option.key} className="menu-item" onClick={() => { props.onSelectMode(option.key); closeAll(); }}><span className="menu-item__leading"><Icon size={14} /></span><span className="menu-item__label"><strong>{option.label}</strong><small>{option.description}</small></span><span className="menu-item__trailing">{props.mode === option.key ? <Check size={14} /> : null}</span></button>; })}</div>
      </MenuSurface>

      <MenuSurface id="composer-model-menu" chainId="composer" label={t("composer.model")} open={rootOpen("model")} anchorRef={modelRef} search={{ value: modelQuery, onChange: setModelQuery, placeholder: t("chat.searchModels") }} onCloseCurrent={closeCurrent} onCloseAll={closeAll}>{renderModelRows()}</MenuSurface>

      <MenuSurface id="composer-runtime-menu" chainId="composer" label={t("composer.runtimeContext")} open={rootOpen("runtime")} anchorRef={runtimeRef} surfaceRole="dialog" onCloseCurrent={closeCurrent} onCloseAll={closeAll}>
        <RuntimeContextPanel
          value={runtimeView}
          loading={props.runtimeContextLoading}
          error={props.runtimeContextError}
        />
      </MenuSurface>

      <MenuSurface id="composer-files-menu" chainId="composer" parentId="composer-add-menu" label={t("composer.files")} open={rootOpen("add") && childOpen("files")} anchorRef={filesRef} search={props.linkedFolder ? { value: fileQuery, onChange: (value) => { setFileQuery(value); props.onSearchFiles(value); }, placeholder: t("chat.searchFiles") } : undefined} onCloseCurrent={closeCurrent} onCloseAll={closeAll}>
        <div className="composer-menu-list">{props.linkedFolder ? <><div className="composer-folder-row"><span title={props.linkedFolder}>{folderName}</span><button type="button" onClick={props.onUnlinkFolder}>{t("chat.unlink")}</button></div>{props.fileResults.map((file) => <button key={file} type="button" role="menuitem" className="menu-item" onClick={() => { props.onSelectContextFile(file); closeAll(); }}><span className="menu-item__leading"><AtSign size={14} /></span><span className="menu-item__label"><strong>{file.split("/").pop()}</strong><small>{file}</small></span><span className="menu-item__trailing" /></button>)}{props.fileResults.length === 0 ? <p className="composer-menu-empty">{t("chat.noFiles")}</p> : null}</> : <div className="composer-link-folder"><button type="button" role="menuitem" className="menu-item" onClick={props.onBrowseFolder}><span className="menu-item__leading">{props.folderBusy ? <Loader2 size={14} className="composer-spin" /> : <Search size={14} />}</span><span className="menu-item__label">{t("chat.browse")}</span><span className="menu-item__trailing" /></button><label><span>{t("chat.orPastePath")}</span><div><input value={folderPath} onChange={(event) => setFolderPath(event.currentTarget.value)} /><button type="button" disabled={!folderPath.trim() || props.folderBusy} onClick={() => props.onLinkFolder(folderPath)}>{t("chat.link")}</button></div></label>{props.folderError ? <p className="composer-error">{props.folderError}</p> : null}</div>}</div>
      </MenuSurface>

      <MenuSurface id="composer-capabilities-menu" chainId="composer" parentId="composer-add-menu" label={t("composer.capabilities")} open={rootOpen("add") && childOpen("capabilities")} anchorRef={capabilitiesRef} search={{ value: capabilityQuery, onChange: setCapabilityQuery, placeholder: t("chat.searchCapability") }} onCloseCurrent={closeCurrent} onCloseAll={closeAll}><div className="composer-menu-list">{filteredCapabilities.map((capability) => <button key={capability.id} type="button" role="menuitemradio" aria-checked={props.forcedCapability?.id === capability.id} className="menu-item" onClick={() => { props.onSelectCapability(capability); closeAll(); }}><span className="menu-item__leading">{props.forcedCapability?.id === capability.id ? <Check size={14} /> : <Puzzle size={14} />}</span><span className="menu-item__label"><strong>{capability.name}</strong><small>{capability.description}</small></span><span className="menu-item__trailing" /></button>)}{filteredCapabilities.length === 0 ? <p className="composer-menu-empty">{t("chat.noCapabilities")}</p> : null}</div></MenuSurface>

      <MenuSurface id="composer-connectors-menu" chainId="composer" parentId="composer-add-menu" label={t("composer.connectors")} open={rootOpen("add") && childOpen("connectors")} anchorRef={connectorsRef} onCloseCurrent={closeCurrent} onCloseAll={closeAll}><div className="composer-menu-list">{props.connectors.map((connector) => <button key={connector.provider_id} type="button" role="menuitem" className="menu-item" onClick={closeAll}><span className="menu-item__leading"><Settings2 size={14} /></span><span className="menu-item__label"><strong>{connector.name}</strong><small>{t("composer.toolsCount", { count: connector.tools })}</small></span><span className="menu-item__trailing" /></button>)}</div></MenuSurface>

      <MenuSurface id="composer-models-menu" chainId="composer" parentId="composer-add-menu" label={t("composer.models")} open={rootOpen("add") && childOpen("models")} anchorRef={modelsRef} search={{ value: modelQuery, onChange: setModelQuery, placeholder: t("chat.searchModels") }} onCloseCurrent={closeCurrent} onCloseAll={closeAll}>{renderModelRows()}</MenuSurface>
    </form>
  );
}
