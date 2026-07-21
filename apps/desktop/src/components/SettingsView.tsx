import {
  AlertTriangle,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  Copy,
  Cpu,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Folder,
  LifeBuoy,
  MonitorPlay,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import { pluginRegistry } from "../plugins/registry";
import type { PluginState } from "../lib/coreBridge";
import { ContactsView } from "./ContactsView";
import { MemoryView } from "./MemoryView";
import { SandboxSettingsView } from "./SandboxSettingsView";
import { UsageSettingsPane } from "./UsageSettingsPane";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import {
  coreBridge,
  composioLogoUrl,
  factoryReset,
  type ActiveModelInfo,
  type AllowedTool,
  type ArtifactDestination,
  type ArtifactFileView,
  type ArtifactThreadView,
  type ArtifactsUsage,
  type ExportArtifactFileRequest,
  type ComposioToolkit,
  type ComposioToolkitAuth,
  type ComposioLinkInput,
  type ContainedComputerLive,
  type CoreCapabilitySnapshot,
  type CoreChannelSettings,
  type CoreChatThread,
  type CoreTelegramStatus,
  type CachedPluginRegistryView,
  type InstalledPluginPackagesView,
  type PluginPackageUpdatesView,
  type TrustedPluginPublicKeysView,
  type VaultRecordSummary,
  type VaultProposalAcceptResult,
  type LanguageInfo,
  type LlmConcurrencyView,
  type ProviderModelView,
  type ProviderView,
  type McpRegistryServer,
  type McpConnectedServer,
  type CatalogPreview,
  type CatalogSkills,
  type ChannelIdentity,
  type ConnectorToolRun,
  type SkillsCatalogResponse,
  type RoleView,
  modelIsCloud,
  type TimezoneInfo,
  type SkillsDetail,
  type SkillsFileNode,
  type SkillsSecurityReport,
  type SkillssResponse,
  type SystemStatus,
  type HostComputerApp,
  type HostComputerGrant,
  type HostComputerStatus,
  grantHostComputerApp,
  hostComputerApps,
  hostComputerGrants,
  hostComputerStatus,
  presentHostComputerPermission,
  revokeHostComputerGrant,
} from "../lib/coreBridge";
import { useSetting } from "../lib/settingsStore";
import { ProviderLogo, providerLogoKey } from "./providerLogos";
import {
  isLocalOllamaProvider,
  notifyRuntimeModelsChanged,
  PROVIDER_PRESETS,
  type ProviderPreset,
} from "../lib/providerPresets";
import {
  notificationPermission,
  requestNotificationPermission,
  showSystemNotification,
} from "../lib/systemNotifications";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  loadAccent,
  loadCustomAccents,
  loadTheme,
  normalizeHex,
  saveAccent,
  saveCustomAccents,
  saveTheme,
  THEME_PRESETS,
  type ThemeName,
} from "../lib/accent";
import {
  IS_DESKTOP,
  getAppVersion,
  checkDesktopUpdate,
  createFeedbackBundle,
  installDesktopUpdate,
  onDesktopUpdateProgress,
  openDesktopUpdateDownload,
} from "../lib/gatewayConfig";

// Literal neutrals per surface theme — for the mini-previews in the Appearance picker
// (the live CSS vars only reflect the ACTIVE theme, so previews need the raw values).
const THEME_SWATCH: Record<ThemeName, { bg: string; panel: string; line: string }> = {
  freddo: { bg: "#fcfcfd", panel: "#f4f5f7", line: "#e0e2e7" },
  avorio: { bg: "#fbfaf7", panel: "#f4f2ec", line: "#e4e0d7" },
  neutro: { bg: "#ffffff", panel: "#f6f6f6", line: "#e6e6e8" },
  sabbia: { bg: "#faf8f3", panel: "#f2eee6", line: "#e7e1d6" },
  dark: { bg: "#111214", panel: "#1a1c20", line: "#343841" },
};
import { copyText } from "../lib/clipboard";
import type {
  ConnectionItem,
  SettingsSectionId,
} from "../types";

interface SettingsViewProps {
  connections: ConnectionItem[];
  section: SettingsSectionId;
  // Active sub-item for sections with an inline expandable submenu (e.g.
  // runtime → routing|providers). Free-form string, defaulted per pane.
  sub?: string;
  // Called after an addon is toggled, so App can re-read enabled-state and
  // mount/unmount its nav entry + panel (ADR 0011 §10-A).
  onPluginsChanged?: () => void;
}

const SECTION_TITLES: Record<SettingsSectionId, string> = {
  account: "settings.account",
  general: "settings.general",
  appearance: "settings.appearance",
  runtime: "settings.runtime",
  usage: "settings.usage.title",
  privacy: "settings.privacy",
  sandbox: "settings.sandbox",
  vault: "settings.vault",
  memory: "nav.memory",
  artifacts: "settings.artifacts",
  contacts: "nav.contacts",
  channels: "settings.channels",
  connections: "settings.connectors",
  skills: "settings.skills",
  addon: "settings.addon",
  computer: "settings.computer.title",
};

// Roles that quietly lose a capability when no installed model meets their requirements — the picker
// shows nothing and the user is never told why the feature isn't there. Keyed by role; a role absent
// here degrades gracefully enough not to warrant a warning.
const MISSING_ROLE_HINTS: Record<string, string> = {
  image_generation: "settings.imageRoleMissingHint",
  vision: "settings.visionRoleMissingHint",
};

export function SettingsView({ section, sub, onPluginsChanged }: SettingsViewProps) {
  const { t } = useTranslation();
  const [model, setModel] = useState<ActiveModelInfo | null>(null);
  const [computer, setComputer] = useState<ContainedComputerLive | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const value = await coreBridge.runtimeModel();
        if (!cancelled) setModel(value);
      } catch {
        /* leave null → shown as "non disponibile" */
      }
      try {
        const value = await coreBridge.containedComputerLive();
        if (!cancelled) setComputer(value);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [section]);

  // Poll the contained-computer live state so the Local computer row reflects
  // start/stop within a few seconds.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const value = await coreBridge.containedComputerLive();
        if (!cancelled) setComputer(value);
      } catch {
        /* ignore */
      }
    };
    const id = window.setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  return (
    <section
      className="settings-view"
      aria-labelledby="settings-title"
    >
      <div className="set-pane">
        <h2 id="settings-title" className="set-title">
          {t(SECTION_TITLES[section])}
        </h2>
        {section === "account" && <AccountPane computer={computer} />}
        {section === "general" && <GeneralPane />}
        {section === "appearance" && <AppearancePane />}
        {section === "runtime" && (
          <RuntimePane
            model={model}
            sub={sub === "providers" ? sub : "routing"}
          />
        )}
        {section === "usage" && <UsageSettingsPane />}
        {section === "privacy" && <PrivacyPane />}
        {section === "sandbox" && <SandboxSettingsView />}
        {section === "vault" && <VaultPane />}
        {section === "memory" && <MemoryView embedded />}
        {section === "artifacts" && <ArtifactsPane />}
        {section === "contacts" && <ContactsView />}
        {section === "channels" && <ChannelsPane />}
        {section === "connections" && (
          <ConnectorsPane
            sub={sub === "mcp" || sub === "attivita" ? sub : "composio"}
          />
        )}
        {section === "skills" && <SkillssPane />}
        {section === "addon" && <AddonsPane onChanged={onPluginsChanged} />}
        {section === "computer" && <ComputerPane computer={computer} />}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- primitives */

function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const resolvedLabel = label ?? t("settings.copy");
  return (
    <button
      className="set-btn"
      type="button"
      onClick={async () => {
        if (!(await copyText(value))) return;
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1400);
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span style={{ marginLeft: 6 }}>{copied ? t("settings.copied") : resolvedLabel}</span>
    </button>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      className={`set-toggle ${on ? "on" : ""}`}
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
    />
  );
}

function ToggleRow({
  title,
  description,
  settingKey,
  fallback,
}: {
  title: string;
  description: string;
  settingKey: Parameters<typeof useSetting>[0];
  fallback: boolean;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useSetting<boolean>(settingKey, fallback);
  return (
    <div className="set-trow">
      <div>
        <div className="tt">{title}</div>
        <div className="td">{description}</div>
      </div>
      <Toggle on={value} onChange={setValue} />
    </div>
  );
}

function formatK(value: number): string {
  if (!value) return "n/d";
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

/* ------------------------------------------------------------------ timezone */

// Curated IANA zones; the detected system zone and any saved choice are merged in.
const COMMON_ZONES = [
  "Europe/Rome",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Madrid",
  "Europe/Athens",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

function TimezoneRow() {
  const { t } = useTranslation();
  const [info, setInfo] = useState<TimezoneInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const detected = (() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    } catch {
      return "";
    }
  })();

  useEffect(() => {
    void coreBridge
      .timezone()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  const change = async (value: string) => {
    setBusy(true);
    try {
      // "" = follow system (selected:null); otherwise an explicit IANA zone.
      setInfo(await coreBridge.setTimezone(value === "" ? null : value));
    } catch {
      /* keep prior */
    } finally {
      setBusy(false);
    }
  };

  // Merge curated + detected + current selection, de-duplicated, stable order.
  const zones = Array.from(
    new Set([detected, ...COMMON_ZONES, info?.selected ?? ""].filter(Boolean)),
  ) as string[];

  return (
    <div className="set-trow">
      <div>
        <div className="tt">{t("settings.timezone")}</div>
        <div className="td">
          {info
            ? t("settings.timezoneInUse", { effective: info.effective, now: info.now })
            : t("common.loading")}
        </div>
      </div>
      <select
        className="set-input set-row-input"
        disabled={busy}
        value={info?.selected ?? ""}
        onChange={(event) => void change(event.target.value)}
      >
        <option value="">
          {t("settings.followSystem")}{detected ? ` (${detected})` : ""}
        </option>
        {zones.map((z) => (
          <option key={z} value={z}>
            {z}
          </option>
        ))}
      </select>
    </div>
  );
}

/* ------------------------------------------------------------ language row */

function LanguageRow() {
  const { t, i18n: i18nInstance } = useTranslation();
  const [info, setInfo] = useState<LanguageInfo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void coreBridge
      .language()
      .then(setInfo)
      .catch(() => setInfo(null));
  }, []);

  const change = async (value: string) => {
    setBusy(true);
    try {
      const next = await coreBridge.setLanguage(value === "" ? null : value);
      setInfo(next);
      // Switch BOTH the UI i18n AND the persisted localStorage key so the
      // choice survives reloads and applies on next launch.
      i18nInstance.changeLanguage(next.effective);
      try {
        window.localStorage.setItem("lfpa.settings.language", next.effective);
      } catch {
        /* localStorage unavailable */
      }
      void t; // keep t referenced for reactivity on language change
    } catch {
      /* keep prior */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-trow">
      <div>
        <div className="tt">{t("settings.language")}</div>
        <div className="td">
          {info
            ? `${t("common.done")}: ${info.effective_name} (${info.effective})`
            : t("common.loading")}
        </div>
      </div>
      <select
        className="set-input set-row-input"
        disabled={busy}
        value={info?.selected ?? ""}
        onChange={(event) => void change(event.target.value)}
      >
        <option value="">
          {t("settings.automatic")} ({info ? `${info.effective} default` : "en"})
        </option>
        {info?.supported.map(([code, name]) => (
          <option key={code} value={code}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
}

/* --------------------------------------------------------- approval routing */

function ApprovelRoutingRow() {
  const { t } = useTranslation();
  const [channel, setChannel] = useState<string>("in_app");
  const [target, setTarget] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [detected, setDetected] = useState<ChannelIdentity[]>([]);

  useEffect(() => {
    void coreBridge
      .approvalRouting()
      .then((r) => {
        setChannel(r.channel || "in_app");
        setTarget(r.target ?? "");
      })
      .catch(() => {});
  }, []);

  // When a remote channel is chosen, look up the chat ids we've actually seen on it,
  // so the user can pick their OWN id instead of guessing chat-id-vs-phone-number.
  useEffect(() => {
    if (channel === "in_app") {
      setDetected([]);
      return;
    }
    void coreBridge
      .channelIdentities(channel)
      .then(setDetected)
      .catch(() => setDetected([]));
  }, [channel]);

  const save = async (nextChannel: string, nextTarget: string) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await coreBridge.setApprovelRouting(
        nextChannel,
        nextChannel === "in_app" ? null : nextTarget.trim() || null,
      );
      setChannel(r.channel);
      setTarget(r.target ?? "");
      setNote(t("settings.saved"));
    } catch (error) {
      setNote((error as Error).message || t("settings.notSaved"));
    } finally {
      setBusy(false);
    }
  };

  const needsTarget = channel !== "in_app";
  return (
    <div className="set-rows">
      <div className="set-trow">
        <div>
          <div className="tt">{t("settings.whereToReceiveApprovals")}</div>
          <div className="td">
            Authorization requests (sends, publications) arrive here — so you can
            approve them remotely too. Only your number can authorize.
          </div>
        </div>
        <select
          className="set-input set-row-input"
          disabled={busy}
          value={channel}
          onChange={(e) => {
            const c = e.target.value;
            setChannel(c);
            if (c === "in_app") void save(c, "");
          }}
        >
          <option value="in_app">{t("settings.inAppOnly")}</option>
          <option value="telegram">Telegram</option>
          <option value="whatsapp">WhatsApp</option>
        </select>
      </div>
      {needsTarget && (
        <div className="set-trow">
          <div>
            <div className="tt">
              {t("settings.yourChatIdOn", { channel: channel === "telegram" ? "Telegram" : "WhatsApp" })}
            </div>
            <div className="td">
              {channel === "telegram"
                ? "The chat id (numeric) you will authorize from — it is not the phone number."
                : "The number (with country code) you will authorize from."}
            </div>
          </div>
          <div className="approval-target-field">
            <input
              className="set-input set-row-input"
              disabled={busy}
              value={target}
              placeholder={channel === "telegram" ? t("settings.chatIdPlaceholder") : t("settings.phonePlaceholder")}
              onChange={(e) => setTarget(e.target.value)}
              onBlur={() => void save(channel, target)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void save(channel, target);
              }}
            />
            {detected.length > 0 && (
              <div className="approval-detected">
                <span className="approval-detected-label">{t("settings.recentlyDetected")}</span>
                {detected.map((d) => {
                  const active = d.id === target.trim();
                  return (
                    <button
                      key={d.id}
                      type="button"
                      className={`approval-chip${active ? " is-active" : ""}`}
                      disabled={busy}
                      title={t("settings.use", { id: d.id })}
                      onClick={() => {
                        setTarget(d.id);
                        void save(channel, d.id);
                      }}
                    >
                      {d.name ? `${d.name} · ${d.id}` : d.id}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
      {note && <p className="set-hint">{note}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------- account */

/** Start/stop the contained "Local computer". Reused by the Account row and the
 *  dedicated Local computer pane. Reports failures (e.g. Docker unavailable on a
 *  PaaS deploy without the socket) via onMessage, or inline when omitted. */
function LocalComputerToggle({
  enabled,
  onMessage,
}: {
  enabled: boolean;
  onMessage?: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [localMsg, setLocalMsg] = useState<string | null>(null);
  const report = (message: string | null) =>
    onMessage ? onMessage(message) : setLocalMsg(message);

  const toggle = async () => {
    setBusy(true);
    report(null);
    try {
      if (enabled) {
        await coreBridge.stopLocalComputer();
      } else {
        const result = await coreBridge.startLocalComputer();
        if (!result.ok) report(result.message ?? t("settings.localComputerDockerOff"));
      }
    } catch (error) {
      report(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="set-cc-toggle">
      {localMsg && <span className="set-hint set-cc-toggle-msg">{localMsg}</span>}
      <button
        type="button"
        className={`set-badge-btn ${enabled ? "green" : ""}`}
        disabled={busy}
        onClick={() => void toggle()}
      >
        {busy ? t("settings.starting") : enabled ? t("settings.stop") : t("settings.start")}
      </button>
    </span>
  );
}

/** Persists `RuntimeSettings.local_computer_autostart`. Read by the gateway at boot to warm
 *  up the contained computer — OPENING Docker if it's closed. Default ON. */
function LocalComputerAutostartToggle() {
  const { t } = useTranslation();
  const [on, setOn] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await coreBridge.runtimeSettings();
        if (!cancelled) setOn(settings.local_computer_autostart !== false);
      } catch {
        /* leave default ON */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const change = async (next: boolean) => {
    setOn(next);
    setBusy(true);
    try {
      const saved = await coreBridge.setRuntimeSettings({ local_computer_autostart: next });
      setOn(saved.local_computer_autostart !== false);
    } catch {
      /* a later read corrects the optimistic state */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="set-trow" aria-busy={busy}>
      <div>
        <div className="tt">{t("settings.localComputerAutostartTitle")}</div>
        <div className="td">{t("settings.localComputerAutostartDesc")}</div>
      </div>
      <Toggle on={on} onChange={(next) => void change(next)} />
    </div>
  );
}

function AccountPane({
  computer,
}: {
  computer: ContainedComputerLive | null;
}) {
  const { t } = useTranslation();
  const [name, setName] = useSetting("displayName", "");
  const [accountEmail, setAccountEmail] = useSetting<string>("email", "");
  const [computerMsg, setComputerMsg] = useState<string | null>(null);
  const [profileImage, setProfileImage] = useSetting<string>("profileImage", "");
  const [profileImageError, setProfileImageError] = useState<string | null>(null);
  const [profileImageMenuOpen, setProfileImageMenuOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);

  const openProfileImagePicker = () => {
    setProfileImageMenuOpen(false);
    fileInputRef.current?.click();
  };

  const clearProfileImage = () => {
    setProfileImage("");
    setProfileImageError(null);
    setProfileImageMenuOpen(false);
  };

  const onProfileImageSelected = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setProfileImageError(null);
    setProfileImageMenuOpen(false);
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // Resize + center cover-crop to a small square so localStorage stays light.
        const size = 160;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const scale = Math.max(size / img.width, size / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
        setProfileImage(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => setProfileImageError(t("settings.profileImageDecodeError"));
      img.src = reader.result as string;
    };
    reader.onerror = () => setProfileImageError(t("settings.profileImageReadError"));
    reader.readAsDataURL(file);
  };

  return (
    <>
      <div className="set-section-label">{t("settings.profile")}</div>
      <div className="set-rows">
        <div className="set-trow">
          <div>
            <div className="tt">{t("settings.profileImage")}</div>
          </div>
          <div
            className="profile-image-controls"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setProfileImageMenuOpen(false);
              }
            }}
          >
            <div className="profile-image-menu-anchor">
              <button
                type="button"
                className="profile-image-button"
                onClick={() => setProfileImageMenuOpen((open) => !open)}
                aria-label={t("settings.profileImage")}
                aria-expanded={profileImageMenuOpen}
              >
                {profileImage ? (
                  <img
                    src={profileImage}
                    alt=""
                    className="set-profile-avatar"
                    style={{ objectFit: "cover" }}
                    // A stored value that no longer loads (a legacy blob:/object URL from an
                    // older build, or a truncated data URL) must NOT leave an invisible broken
                    // image where the picker button used to be — self-heal to the visible
                    // placeholder so the avatar stays a clickable "upload" affordance.
                    onError={() => {
                      setProfileImage("");
                      setProfileImageError(null);
                    }}
                  />
                ) : (
                  <span className="set-profile-avatar" />
                )}
              </button>
              {profileImageMenuOpen && (
                <div className="profile-image-menu" role="menu">
                  <button type="button" role="menuitem" onClick={openProfileImagePicker}>
                    {t("settings.profileImageUpload")}
                  </button>
                  {profileImage && (
                    <button type="button" role="menuitem" onClick={clearProfileImage}>
                      {t("settings.profileImageRemove")}
                    </button>
                  )}
                </div>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={onProfileImageSelected}
            />
          </div>
        </div>
        {profileImageError && (
          <div className="set-inline-warning" role="status">
            <AlertTriangle size={14} />
            <span>{profileImageError}</span>
          </div>
        )}
        <div className="set-trow">
          <div>
            <div className="tt">{t("settings.fullName")}</div>
          </div>
          <input
            className="set-input set-row-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("settings.yourName")}
          />
        </div>
        <div className="set-trow">
          <div>
            <div className="tt">Email</div>
          </div>
          <input
            className="set-input set-row-input"
            value={accountEmail}
            onChange={(event) => setAccountEmail(event.target.value)}
            placeholder={t("settings.emailPlaceholder")}
          />
        </div>
        <div className="set-trow">
          <div>
            <div className="tt">Workspace</div>
          </div>
          <div className="set-row-value">
            <span>{t("sidebar.personal")}</span>
            <CopyButton value="Personal" />
          </div>
        </div>
      </div>

      <div className="set-section-label">Local-first</div>
      <div className="set-rows">
        <div className="set-trow">
          <div>
            <div className="tt">Local computer</div>
            <div className="td">
              {computerMsg
                ? computerMsg
                : computer?.enabled
                  ? "Real contained browser · live noVNC view"
                  : "Start the contained computer for real, non-invasive browsing."}
            </div>
          </div>
          <LocalComputerToggle
            enabled={Boolean(computer?.enabled)}
            onMessage={setComputerMsg}
          />
        </div>
      </div>

      <div className="set-section-label">{t("settings.dateAndTime")}</div>
      <div className="set-rows">
        <TimezoneRow />
      </div>
      <p className="set-hint">
        {t("settings.timezoneHint")}
      </p>

      <div className="set-section-label">{t("settings.language")}</div>
      <div className="set-rows">
        <LanguageRow />
      </div>
      <p className="set-hint">
        {t("settings.languageHint")}
      </p>

      <p className="set-hint">{t("settings.everythingLocalHint")}</p>

      <AboutVersionRow />

      {/* Factory reset only works in the desktop (Electron) build — the web
          render has no `factoryReset` IPC bridge, so hide the danger row
          entirely there rather than offering a control that can only fail. */}
      {IS_DESKTOP && (
        <>
          <div className="set-danger">
            <div>
              <div className="dt">{t("settings.deleteLocalData")}</div>
              <div className="dd">{t("settings.deleteLocalDataDesc")}</div>
            </div>
            <button
              className="set-btn danger"
              type="button"
              onClick={() => setConfirmReset(true)}
            >
              {t("settings.deleteData")}
            </button>
          </div>
          {confirmReset && (
            <div className="set-confirm-scrim" role="dialog" aria-modal="true">
              <div className="set-confirm">
                <h3>{t("settings.factoryResetConfirmTitle")}</h3>
                <p>{t("settings.factoryResetConfirmBody")}</p>
                <div className="set-confirm-actions">
                  <button className="auto-btn" type="button" disabled={resetting} onClick={() => setConfirmReset(false)}>
                    {t("settings.cancel")}
                  </button>
                  <button
                    className="set-btn danger"
                    type="button"
                    disabled={resetting}
                    onClick={async () => {
                      setResetting(true);
                      try {
                        const r = await factoryReset();
                        // On success the app relaunches — nothing more to do here.
                        // On failure (web build / IPC error), re-enable so the user
                        // isn't trapped in a dialog with both buttons disabled.
                        if (!r?.ok) setResetting(false);
                      } catch {
                        setResetting(false);
                      }
                    }}
                  >
                    {t("settings.factoryResetConfirmCta")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

/* ------------------------------------------------------------- about/version */

// Version card in Settings → Account: shows the running build, lets the user
// check for an update on demand, and renders the new version's release notes
// inline (so "what's new" lives in the app, not just on GitHub). Desktop-only —
// the web build has no packaged version or updater, so it renders nothing.
function AboutVersionRow() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "checking" | "current" | "available" | "error">(
    "idle",
  );
  const [latest, setLatest] = useState<string | null>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(0);
  // mac (signed) auto-installs; Windows/Linux (unsigned) only get a download link.
  const [canAutoInstall, setCanAutoInstall] = useState(true);
  const [bundling, setBundling] = useState(false);
  const [bundlePath, setBundlePath] = useState<string | null>(null);
  const [bundleError, setBundleError] = useState<string | null>(null);

  const makeBundle = async () => {
    setBundling(true);
    setBundlePath(null);
    setBundleError(null);
    try {
      const r = await createFeedbackBundle();
      // This is the one action used precisely when things are already broken
      // (down gateway, disk error), so it must never fail silently: a null
      // (IPC threw) or {ok:false} result surfaces a localized error to the user.
      if (r?.ok && r.path) setBundlePath(r.path);
      else setBundleError(t("settings.feedbackError"));
    } finally {
      setBundling(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const v = await getAppVersion();
      if (!cancelled) setVersion(v);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!IS_DESKTOP) return null;

  const check = async () => {
    setPhase("checking");
    setError(null);
    setNotes(null);
    const r = await checkDesktopUpdate();
    if (!r) {
      setPhase("error");
      setError(t("settings.updateCheckUnavailable"));
      return;
    }
    if (r.current) setVersion(r.current);
    setLatest(r.version);
    setNotes(r.releaseNotes);
    setCanAutoInstall(r.canAutoInstall);
    setPhase(r.available ? "available" : "current");
  };

  // Unsigned platforms (Windows/Linux): open the releases page to download the
  // installer manually instead of auto-installing.
  const download = async () => {
    await openDesktopUpdateDownload();
  };

  const install = async () => {
    setInstalling(true);
    setError(null);
    setProgress(0);
    const unsub = onDesktopUpdateProgress((p) => setProgress(p.percent));
    try {
      const r = await installDesktopUpdate();
      if (!r.ok) setError(r.error ?? t("settings.updateFailedGeneric"));
      // On success the shell restarts into the new build; nothing else to do.
    } finally {
      unsub();
      setInstalling(false);
    }
  };

  return (
    <>
      <div className="set-section-label">{t("settings.aboutVersion")}</div>
      <div className="set-rows">
        <div className="set-trow">
          <div>
            <div className="tt">Homun</div>
            <div className="td">
              {version
                ? t("settings.versionLine", { version })
                : t("settings.versionUnknown")}
            </div>
          </div>
          <button
            type="button"
            className="set-btn"
            onClick={() => void check()}
            disabled={phase === "checking" || installing}
          >
            <RefreshCw size={14} />
            <span style={{ marginLeft: 6 }}>
              {phase === "checking"
                ? t("settings.updateChecking")
                : t("settings.checkForUpdates")}
            </span>
          </button>
        </div>

        {phase === "current" && (
          <p className="set-hint">{t("settings.updateUpToDate")}</p>
        )}

        {phase === "available" && latest && (
          <div className="set-card" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div
              style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
            >
              <strong>{t("settings.updateAvailable", { version: latest })}</strong>
              {canAutoInstall ? (
                <button
                  type="button"
                  className="set-btn primary"
                  onClick={() => void install()}
                  disabled={installing}
                >
                  <Download size={14} />
                  <span style={{ marginLeft: 6 }}>
                    {installing
                      ? t("settings.updateInstalling", { percent: progress })
                      : t("settings.updateInstall")}
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  className="set-btn primary"
                  onClick={() => void download()}
                >
                  <Download size={14} />
                  <span style={{ marginLeft: 6 }}>{t("settings.updateDownload")}</span>
                </button>
              )}
            </div>
            {!canAutoInstall && (
              <p className="set-hint">{t("settings.updateDownloadHint")}</p>
            )}
            {notes && (
              <div className="set-release-notes">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                  {notes}
                </ReactMarkdown>
              </div>
            )}
          </div>
        )}

        {error && <p className="set-hint set-hint-error">{error}</p>}

        <div className="set-trow">
          <div>
            <div className="tt">{t("settings.feedbackTitle")}</div>
            {/* Always show an outcome (priority: error > done > hint) so this
                action — used when things are already broken — never leaves the
                user without feedback. Mirrors the set-hint-error style above. */}
            {bundleError ? (
              <div className="td set-hint-error">{bundleError}</div>
            ) : (
              <div className="td">
                {bundlePath
                  ? t("settings.feedbackDone", { path: bundlePath })
                  : t("settings.feedbackHint")}
              </div>
            )}
          </div>
          <button
            type="button"
            className="set-btn"
            onClick={() => void makeBundle()}
            disabled={bundling}
          >
            <LifeBuoy size={14} />
            <span style={{ marginLeft: 6 }}>
              {bundling ? t("settings.feedbackBuilding") : t("settings.feedbackButton")}
            </span>
          </button>
        </div>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- appearance */

function AppearancePane() {
  const { t } = useTranslation();
  const [accent, setAccent] = useState(loadAccent());
  const [theme, setTheme] = useState<ThemeName>(loadTheme());
  // The user's own accents, shown as pills alongside the presets (persisted).
  const [customs, setCustoms] = useState<string[]>(loadCustomAccents);
  // A colour being picked but NOT yet saved. The native OS picker fires change events
  // continuously while you move the selector, so we stage the choice here and only the
  // explicit "Add" commits it — otherwise every colour passed over would be added.
  const [draft, setDraft] = useState<string | null>(null);
  const isPreset = (hex: string) =>
    ACCENT_PRESETS.some((p) => p.hex.toLowerCase() === hex.toLowerCase());
  // Migrate a pre-existing custom accent (saved before this feature) into a pill.
  useEffect(() => {
    const cur = normalizeHex(accent);
    if (!isPreset(cur) && !customs.some((c) => c === cur)) {
      const next = [...customs, cur];
      setCustoms(next);
      saveCustomAccents(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const pick = (hex: string) => {
    const h = normalizeHex(hex);
    setAccent(h);
    saveAccent(h); // applies to :root + persists immediately
  };
  const addCustom = (hex: string) => {
    const h = normalizeHex(hex);
    if (!isPreset(h) && !customs.some((c) => c === h)) {
      const next = [...customs, h];
      setCustoms(next);
      saveCustomAccents(next);
    }
    pick(h);
  };
  const removeCustom = (hex: string) => {
    const h = normalizeHex(hex);
    const next = customs.filter((c) => c !== h);
    setCustoms(next);
    saveCustomAccents(next);
    if (normalizeHex(accent) === h) pick(DEFAULT_ACCENT);
  };
  const pickTheme = (name: ThemeName) => {
    setTheme(name);
    saveTheme(name); // toggles <html data-theme> + persists immediately
  };
  const norm = accent.toLowerCase();
  return (
    <div className="appearance-pane">
      <div className="appearance-eyebrow">{t("settings.themeSurface")}</div>
      <p className="set-hint">
        {t("settings.themeSurfaceHint")}
      </p>
      <div className="appearance-themes">
        {THEME_PRESETS.map((t) => {
          const sw = THEME_SWATCH[t.name];
          const active = theme === t.name;
          return (
            <button
              key={t.name}
              type="button"
              title={t.hint}
              className={`appearance-theme-card ${active ? "active" : ""}`}
              onClick={() => pickTheme(t.name)}
            >
              <span
                className="appearance-theme-preview"
                style={{ background: sw.bg, borderColor: sw.line }}
              >
                <span className="appearance-theme-rail" style={{ background: sw.panel }} />
                <span className="appearance-theme-bars">
                  <span style={{ background: sw.line }} />
                  <span style={{ background: "var(--brand)" }} />
                </span>
              </span>
              <span className="appearance-theme-label">
                {t.label}
                {active && <Check size={13} className="appearance-theme-check" />}
              </span>
            </button>
          );
        })}
      </div>

      <div className="appearance-eyebrow" style={{ marginTop: "var(--s5)" }}>
        {t("settings.accent")}
      </div>
      <p className="set-hint">
        {t("settings.accentHint")}
      </p>
      <div className="appearance-accents">
        {ACCENT_PRESETS.map((preset) => {
          const active = norm === preset.hex.toLowerCase();
          return (
            <button
              key={preset.hex}
              type="button"
              title={preset.name}
              aria-label={preset.name}
              className={`appearance-accent ${active ? "active" : ""}`}
              onClick={() => pick(preset.hex)}
            >
              <span className="appearance-accent-chip" style={{ background: preset.hex }} />
              <span className="appearance-accent-name">{preset.name}</span>
              {active && <Check size={14} style={{ color: preset.hex }} />}
            </button>
          );
        })}
        {/* Saved custom accents — same pill as the presets, each removable on hover. */}
        {customs.map((hex) => {
          const active = norm === hex;
          return (
            <span key={hex} className="appearance-accent-wrap">
              <button
                type="button"
                title={hex.toUpperCase()}
                aria-label={t("settings.accentNamed", { hex: hex.toUpperCase() })}
                className={`appearance-accent ${active ? "active" : ""}`}
                onClick={() => pick(hex)}
              >
                <span className="appearance-accent-chip" style={{ background: hex }} />
                <span className="appearance-accent-name">{hex.toUpperCase()}</span>
                {active && <Check size={14} style={{ color: hex }} />}
              </button>
              <button
                type="button"
                className="appearance-accent-del"
                aria-label={t("settings.removeColor", { hex: hex.toUpperCase() })}
                title={t("common.remove")}
                onClick={() => removeCustom(hex)}
              >
                <X size={11} />
              </button>
            </span>
          );
        })}
        {/* Pick a colour into a draft (the native OS panel updates it live) WITHOUT
            saving — only the explicit "Add" commits it as a pill, so dragging
            through colours no longer spams the list. */}
        <label
          className="appearance-accent appearance-accent-add"
          title={t("settings.customColor")}
        >
          <span
            className="appearance-accent-chip appearance-accent-chip-add"
            style={draft ? { background: draft, boxShadow: "0 0 0 1px rgba(0,0,0,0.06) inset" } : undefined}
          >
            {!draft && <Plus size={13} />}
          </span>
          <span className="appearance-accent-name">
            {draft ? draft.toUpperCase() : t("settings.custom")}
          </span>
          <input
            type="color"
            className="appearance-accent-add-input"
            aria-label={t("settings.customColor")}
            value={draft ?? (isPreset(norm) || !customs.includes(norm) ? DEFAULT_ACCENT : norm)}
            onChange={(e) => setDraft(normalizeHex(e.target.value))}
          />
        </label>
        {draft && (
          <button
            type="button"
            className="appearance-accent-confirm"
            title={t("settings.addColor", { hex: draft.toUpperCase() })}
            onClick={() => {
              addCustom(draft);
              setDraft(null);
            }}
          >
            <Check size={14} />
            <span>{t("common.add")}</span>
          </button>
        )}
      </div>
      <div className="appearance-preview">
        <button type="button" className="appearance-preview-btn">
          {t("settings.primaryButton")}
        </button>
        <span className="appearance-preview-link">{t("settings.coloredLink")}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- general */

// System notifications: a toggle that also requests OS permission on enable, plus
// a "test" button. The on-state requires BOTH the user opt-in AND granted
// permission, so a blocked permission can't show a misleading "on".
function SystemNotificationsRow() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useSetting<boolean>("general.systemNotifications", false);
  const [perm, setPerm] = useState<NotificationPermission>(notificationPermission());
  const [testError, setTestError] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    if (!next) {
      setEnabled(false);
      return;
    }
    const granted = await requestNotificationPermission();
    setPerm(granted);
    setEnabled(granted === "granted");
  };

  // A "Test" that does nothing when the OS refuses is worse than no test at all — it was the entire
  // reason this stayed broken without anyone being able to say what was wrong. Report the refusal.
  const runTest = async () => {
    const result = await showSystemNotification({
      title: "Homun",
      body: t("settings.systemNotificationsTest"),
    });
    setTestError(result.shown ? null : (result.reason ?? "unknown"));
  };

  const on = enabled && perm === "granted";
  return (
    <div className="set-trow">
      <div>
        <div className="tt">{t("settings.systemNotifications")}</div>
        <div className="td">
          {perm === "denied"
            ? t("settings.systemNotificationsBlocked")
            : t("settings.systemNotificationsDesc")}
        </div>
        {testError && (
          <div className="td mdl-row-warning">
            {t("settings.systemNotificationsFailed", { reason: testError })}
          </div>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        {on && (
          <button className="set-btn" type="button" onClick={() => void runTest()}>
            {t("settings.test")}
          </button>
        )}
        <Toggle on={on} onChange={(next) => void toggle(next)} />
      </div>
    </div>
  );
}

function GeneralPane() {
  const { t } = useTranslation();
  return (
    <>
      <div className="set-section-label">{t("settings.conversation")}</div>
      <div className="set-rows">
        <ToggleRow
          title={t("settings.streamingResponses")}
          description="Show the response token-by-token as the model generates."
          settingKey="general.streamResponses"
          fallback={true}
        />
        <ToggleRow
          title={t("settings.activitySound")}
          description="Play a short sound when a local computer task finishes."
          settingKey="general.soundOnComplete"
          fallback={false}
        />
        <SystemNotificationsRow />
      </div>
      <p className="set-hint">
        {t("settings.generalHint")}
      </p>
    </>
  );
}

/* ------------------------------------------------------------------- runtime */

// Provider catalog lives in ../lib/providerPresets (shared with onboarding).

/// LLM concurrency control: how many inference requests the ResourceGovernor lets
/// run in parallel. Auto follows locality (loopback 1, cloud 4); the user can force
/// a value — useful for Ollama on a big GPU, or to cap cloud spend.
function ConcurrencyBlock() {
  const { t } = useTranslation();
  const [view, setView] = useState<LlmConcurrencyView | null>(null);
  const [draft, setDraft] = useState<number>(4);
  const [manual, setManual] = useState<boolean>(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const current = await coreBridge.llmConcurrency();
        setView(current);
        setManual(current.override !== null);
        setDraft(current.override ?? current.effective);
      } catch {
        /* provider runtime unavailable — block stays empty */
      }
    })();
  }, []);

  const apply = async () => {
    setBusy(true);
    try {
      const next = await coreBridge.setLlmConcurrency(manual ? draft : null);
      setView(next);
      setDraft(next.override ?? next.effective);
    } catch {
      /* leave as-is */
    } finally {
      setBusy(false);
    }
  };

  if (!view) return null;
  const dirty = manual !== (view.override !== null) || (manual && draft !== view.effective && draft !== (view.override ?? -1));

  return (
    <>
      <div className="set-section-label" style={{ marginTop: "var(--s4)" }}>
        {t("settings.concurrency")}
      </div>
      <div className="mdl-row">
        <div className="mdl-row-main">
          <div className="mdl-row-top">
            <strong>{t("settings.concurrencyLabel")}</strong>
            <span className="set-badge green">{t("settings.effective", { value: view.effective })}</span>
          </div>
          <p className="mdl-detail-sub">
            {t("settings.concurrencyDesc")}
            {view.inferred_local
              ? ` ${t("settings.concurrencyLocalWarn")}`
              : ""}
          </p>
        </div>
        <div className="mdl-row-side" style={{ display: "flex", gap: "var(--s2)", alignItems: "center" }}>
          <label className="set-check" style={{ whiteSpace: "nowrap" }}>
            <input
              type="checkbox"
              checked={!manual}
              onChange={(e) => setManual(!e.target.checked)}
            />
            {t("settings.automatic")}
          </label>
          {!manual && (
            <span className="set-hint">({view.inferred_local ? t("settings.localCount") : t("settings.cloudCount")})</span>
          )}
          {manual && (
            <input
              className="set-input"
              type="number"
              min={1}
              max={16}
              value={draft}
              style={{ width: "5rem" }}
              onChange={(e) => setDraft(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
            />
          )}
          <button
            type="button"
            className="set-btn"
            disabled={busy || !dirty}
            onClick={apply}
          >
            {busy ? t("settings.saving") : t("common.save")}
          </button>
        </div>
      </div>
    </>
  );
}

function RuntimePane({
  model,
  sub = "routing",
}: {
  model: ActiveModelInfo | null;
  sub?: "routing" | "providers";
}) {
  const { t } = useTranslation();
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [roles, setRoles] = useState<RoleView[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Provider modal: a provider id (edit existing) or "add" (new), null = closed.
  const [modal, setModal] = useState<string | null>(null);
  // Add-provider form.
  const [presetId, setPresetId] = useState("ollama");
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://127.0.0.1:11434/v1");
  const [apiKey, setApiKey] = useState("");
  // Per-provider detail edits.
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editKey, setEditKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  const apply = (snapshot: { providers: ProviderView[]; active_provider_id: string | null }) => {
    setProviders(snapshot.providers);
  };

  const refreshEmptyLocalOllamaCatalogs = async (snapshot: {
    providers: ProviderView[];
    active_provider_id: string | null;
  }) => {
    let latest = snapshot;
    const emptyLocalProviders = snapshot.providers.filter(
      (provider) =>
        provider.enabled &&
        provider.models.length === 0 &&
        isLocalOllamaProvider(provider.kind, provider.base_url),
    );
    for (const provider of emptyLocalProviders) {
      latest = await coreBridge.refreshProviderModels(provider.id).catch(() => latest);
      apply(latest);
    }
    if (emptyLocalProviders.length > 0) notifyRuntimeModelsChanged();
    return latest;
  };

  const reloadRoles = async () => {
    try {
      setRoles((await coreBridge.roles()).roles);
    } catch {
      /* leave empty */
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const snapshot = await coreBridge.providers();
        apply(snapshot);
        await refreshEmptyLocalOllamaCatalogs(snapshot);
      } catch {
        /* leave empty */
      }
      await reloadRoles();
    })();
  }, []);

  const run = async (key: string, action: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    setNote(null);
    try {
      const result = (await action()) as { providers: ProviderView[]; active_provider_id: string | null };
      if (result?.providers) apply(result);
      await reloadRoles();
      notifyRuntimeModelsChanged();
      if (ok) setNote(ok);
    } catch (error) {
      setNote(t("settings.operationFailed", { message: (error as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  const changeRole = async (role: string, value: string) => {
    setBusy(`role:${role}`);
    setNote(null);
    try {
      const input =
        value === "auto"
          ? { role }
          : (() => {
              const [provider_id, ...rest] = value.split("::");
              return { role, provider_id, model: rest.join("::") };
            })();
      setRoles((await coreBridge.setRole(input)).roles);
    } catch (error) {
      setNote(t("settings.operationFailed", { message: (error as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  // Enable/disable a provider for routing. `run` reapplies the snapshot AND
  // reloads roles, so the routing tab reflects any auto re-resolution.
  const toggleProviderEnabled = (provider: ProviderView, next: boolean) =>
    run(`enabled:${provider.id}`, () => coreBridge.setProviderEnabled(provider.id, next));

  const openProvider = (provider: ProviderView) => {
    setEditBaseUrl(provider.base_url);
    setEditKey("");
    setShowKey(false);
    setNote(null);
    setModal(provider.id);
  };

  // Open the add/configure modal pre-filled from a catalog preset (clicking a
  // greyed, not-yet-configured provider tile).
  const openAddPreset = (p: ProviderPreset) => {
    setPresetId(p.id);
    setLabel(p.label);
    setBaseUrl(p.baseUrl);
    setApiKey("");
    setEditKey("");
    setShowKey(false);
    setNote(null);
    setModal("add");
  };

  const closeModal = () => {
    setModal(null);
    setNote(null);
  };

  const preset = PROVIDER_PRESETS.find((p) => p.id === presetId) ?? PROVIDER_PRESETS[0];
  const isCustomPreset = preset.id === "custom";
  const modalProvider = modal && modal !== "add" ? providers.find((p) => p.id === modal) : undefined;
  const addUsesLocalOllama = isLocalOllamaProvider(preset.kind, baseUrl);

  // Per-role options, gated by what the role actually REQUIRES of a model (mirrors the backend's
  // `role_requirements`): image-generation lists only image-modality models (a chat model can't draw),
  // vision lists only models that can see (offering a text-only model as the image reader would
  // configure a blind eye), and every other role excludes image models. Empty optgroups are dropped so
  // the picker reads cleanly.
  const modelEligibleForRole = (
    model: { modality?: string; vision?: boolean },
    roleKey: string,
  ) => {
    if (roleKey === "image_generation") return model.modality === "image";
    if (roleKey === "vision") return model.modality !== "image" && !!model.vision;
    return model.modality !== "image";
  };
  const modelOptionsForRole = (roleKey: string) => {
    return (
      <>
        {providers.map((provider) => {
          const models = provider.models.filter((m) => modelEligibleForRole(m, roleKey));
          if (models.length === 0) return null;
          return (
            <optgroup key={provider.id} label={provider.label}>
              {models.map((m) => (
                <option key={`${provider.id}::${m.id}`} value={`${provider.id}::${m.id}`}>
                  {modelIsCloud(provider.base_url, m.id) ? "☁️ " : "💻 "}
                  {m.id}
                  {m.tier ? ` · ${m.tier}` : ""}
                  {m.vision ? " · vision" : ""}
                </option>
              ))}
            </optgroup>
          );
        })}
      </>
    );
  };
  const hasModelOptionsForRole = (roleKey: string) =>
    providers.some((provider) =>
      provider.models.some((model) => modelEligibleForRole(model, roleKey)),
    );

  // Every provider shown at once: the whole catalog plus any custom endpoints the
  // user added. A configured provider (matched to a preset by base URL, or a
  // bespoke endpoint) is coloured and toggleable; the rest are greyed placeholders
  // that open the configure flow pre-filled. No "add" button — the catalog is the
  // entry point, with a "Custom" tile for arbitrary endpoints.
  const normUrl = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();
  const providerCards: Array<{
    key: string;
    label: string;
    logoKey: string | null;
    metaText: string;
    configured: boolean;
    view?: ProviderView;
    preset?: ProviderPreset;
  }> = [];
  const matched = new Set<string>();
  const metaFor = (p: ProviderView) =>
    `${p.models.length > 0 ? t("settings.modelCount", { count: p.models.length }) : t("settings.noModel")} · ${p.kind}`;
  for (const p of PROVIDER_PRESETS) {
    const view =
      p.baseUrl !== ""
        ? providers.find(
            (v) =>
              !matched.has(v.id) &&
              (v.id === p.id || normUrl(v.base_url) === normUrl(p.baseUrl)),
          )
        : undefined;
    if (view) matched.add(view.id);
    providerCards.push({
      key: p.id,
      label: view?.label || p.label,
      logoKey: providerLogoKey(p.id),
      metaText: view ? metaFor(view) : t("settings.providerNotConfigured"),
      configured: Boolean(view),
      view,
      preset: p,
    });
  }
  // Configured endpoints that don't map to any catalog preset (bespoke base URLs).
  for (const p of providers) {
    if (matched.has(p.id)) continue;
    providerCards.push({
      key: p.id,
      label: p.label,
      logoKey: providerLogoKey(p.id),
      metaText: metaFor(p),
      configured: true,
      view: p,
    });
  }

  return (
    <div className="mdl-pane">
      {/* ── routing → roles → model table ─────────────────────────── */}
      {sub === "routing" && (
        <>
          <div className="set-section-label">{t("settings.subnavRouting")}</div>
          <p className="mdl-detail-sub" style={{ paddingLeft: "var(--s3)" }}>
            The router automatically picks the best model among the eligible ones; you can
            force a specific one.
          </p>
          {roles.length === 0 ? (
            <p className="set-hint">{t("settings.addProviderAndRefresh")}</p>
          ) : (
            roles.map((role) => {
              const value = role.auto ? "auto" : `${role.binding_provider_id}::${role.binding_model}`;
              // A role whose requirements no installed model meets: the picker would be empty and the
              // capability silently absent, so say what will happen instead (no image generation; no
              // one to read attached images for a text-only chat model).
              const missingRoleHint =
                hasModelOptionsForRole(role.key) || !MISSING_ROLE_HINTS[role.key]
                  ? null
                  : t(MISSING_ROLE_HINTS[role.key]);
              return (
                <div className="mdl-row" key={role.key}>
                  <div className="mdl-row-main">
                    <div className="mdl-row-top">
                      <strong>{role.label}</strong>
                      <span className={`set-badge ${role.auto ? "muted" : "green"}`}>
                        {role.auto ? "Auto" : "Manual"}
                      </span>
                    </div>
                    <p className="mdl-detail-sub">{role.description}</p>
                    {missingRoleHint && <p className="mdl-row-warning">{missingRoleHint}</p>}
                  </div>
                  <select
                    className="set-input mdl-row-select"
                    value={value}
                    disabled={busy === `role:${role.key}`}
                    onChange={(event) => changeRole(role.key, event.target.value)}
                  >
                    <option value="auto">
                      Auto{role.resolved_model ? ` — ${role.resolved_model}` : ""}
                    </option>
                    {modelOptionsForRole(role.key)}
                  </select>
                </div>
              );
            })
          )}
          <ConcurrencyBlock />
        </>
      )}

      {/* "Routing decisions" lived here and was REMOVED (2026-07-14): it could never show anything.
          The recorder (`log_routing_decision`) is reachable only from `execute_subagent_task` →
          `brain_materialize_tasks` → the `POST /api/chat/.../create_task` endpoint, which NO component
          ever calls; the chat turn path never touches `resolve_role_for_task` at all. So the panel
          truthfully reported "0 decisions" forever, which reads to the user as a broken feature rather
          than an unwired one. The gateway side (writer, store, `/api/routing-decisions`) is intact and
          correct — bringing the panel back means WIRING the semantic router into the chat path first,
          which is a product decision (it costs one extra model call per turn), not a UI fix. */}

      {/* ── providers → card grid (+ modal) ───────────────────────── */}
      {sub === "providers" && (
        <>
          <div className="set-section-label">
            {t("settings.providers")} <span style={{ textTransform: "none", letterSpacing: 0 }}>({providers.length})</span>
          </div>
          <div className="set-cards-grid cols-4">
            {providerCards.map((card) => (
              <div
                key={card.key}
                className={`set-prov ${card.configured ? (card.view!.enabled ? "on" : "off") : "ghost"}`}
              >
                <button
                  className="set-prov-body"
                  type="button"
                  onClick={() =>
                    card.configured ? openProvider(card.view!) : openAddPreset(card.preset!)
                  }
                >
                  <div className="set-prov-top">
                    <span className="set-prov-mark">
                      <ProviderLogo logoKey={card.logoKey} />
                    </span>
                    <span className="set-prov-name">{card.label}</span>
                  </div>
                  <div className="set-prov-meta">{card.metaText}</div>
                </button>
                {card.configured && (
                  <div
                    className="set-prov-switch"
                    title={card.view!.enabled ? t("settings.providerEnabled") : t("settings.providerDisabled")}
                  >
                    <Toggle
                      on={card.view!.enabled}
                      onChange={(next) => toggleProviderEnabled(card.view!, next)}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          {modal && (
            <div className="set-modal-overlay" role="dialog" aria-modal="true">
              <div className="set-modal-scrim" onClick={closeModal} />
              <div className="set-modal">
                <button className="set-modal-close" type="button" aria-label={t("common.close")} onClick={closeModal}>
                  <X size={16} />
                </button>

                {/* Add a new provider. */}
                {modal === "add" && (
                  <>
                    <div className="mdl-detail-head">
                      <h3>
                        {isCustomPreset
                          ? t("settings.addCustomProvider")
                          : t("settings.configureProviderName", { name: preset.label })}
                      </h3>
                    </div>
                    <p className="mdl-detail-sub">
                      {isCustomPreset
                        ? t("settings.addProviderDesc")
                        : t("settings.configureProviderDesc", { name: preset.label })}
                    </p>
                    <div className="mdl-field">
                      <label>{t("contacts.name")}</label>
                      <input className="set-input" placeholder={preset.label} value={label} onChange={(e) => setLabel(e.target.value)} />
                    </div>
                    <div className="mdl-field">
                      <label>{t("settings.endpoint")}</label>
                      <input className="set-input" placeholder="https://api.openai.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                    </div>
                    {addUsesLocalOllama ? (
                      <p className="mdl-detail-sub">{t("settings.localOllamaNoKey")}</p>
                    ) : (
                      <div className="mdl-field">
                        <label>API key</label>
                        <input className="set-input" type="password" placeholder="sk-…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                      </div>
                    )}
                    <button
                      className="set-btn primary"
                      type="button"
                      style={{ alignSelf: "flex-start" }}
                      disabled={busy === "add" || !baseUrl.trim()}
                      onClick={() =>
                        run(
                          "add",
                          async () => {
                            const result = await coreBridge.upsertProvider({
                              ...(isCustomPreset ? {} : { id: preset.id }),
                              label: (label || preset.label).trim(),
                              kind: preset.kind,
                              base_url: baseUrl.trim(),
                              ...(!addUsesLocalOllama && apiKey.trim() ? { api_key: apiKey.trim() } : {}),
                            });
                            setApiKey("");
                            const added = result.providers.find((p) => p.base_url === baseUrl.trim().replace(/\/$/, ""));
                            if (added) {
                              setEditBaseUrl(added.base_url);
                              setModal(added.id);
                              try {
                                return await coreBridge.refreshProviderModels(added.id);
                              } catch {
                                return result;
                              }
                            }
                            return result;
                          },
                          "Provider added.",
                        )
                      }
                    >
                      {busy === "add"
                        ? t("settings.saving")
                        : isCustomPreset
                          ? t("settings.addProvider")
                          : t("settings.providerConfigure")}
                    </button>
                  </>
                )}

                {/* Edit an existing provider (connection, active model, models list). */}
                {modalProvider && (
                  <ProviderDetailView
                    key={modalProvider.id}
                    provider={modalProvider}
                    busy={busy}
                    editBaseUrl={editBaseUrl}
                    setEditBaseUrl={setEditBaseUrl}
                    editKey={editKey}
                    setEditKey={setEditKey}
                    showKey={showKey}
                    setShowKey={setShowKey}
                    contextWindow={model?.context_window ?? null}
                    onToggleEnabled={(next) =>
                      run(modalProvider.id, () => coreBridge.setProviderEnabled(modalProvider.id, next))
                    }
                    onRemove={() => {
                      const id = modalProvider.id;
                      setModal(null);
                      void run(id, () => coreBridge.removeProvider(id));
                    }}
                    onRefreshModels={() =>
                      run(modalProvider.id, () => coreBridge.refreshProviderModels(modalProvider.id), "Catalog updated.")
                    }
                    onGenerateProfiles={() =>
                      run(modalProvider.id, () => coreBridge.generateProviderProfiles(modalProvider.id), "Profiles generated.")
                    }
                    onSaveConnection={() =>
                      run(
                        modalProvider.id,
                        () =>
                          coreBridge.upsertProvider({
                            id: modalProvider.id,
                            label: modalProvider.label,
                            kind: modalProvider.kind,
                            base_url: (editBaseUrl || modalProvider.base_url).trim(),
                            ...(editKey.trim() ? { api_key: editKey.trim() } : {}),
                          }),
                        "Provider saved.",
                      )
                    }
                    onSetModel={(modelId) =>
                      run(modalProvider.id, () =>
                        coreBridge.upsertProvider({
                          id: modalProvider.id,
                          label: modalProvider.label,
                          kind: modalProvider.kind,
                          base_url: modalProvider.base_url,
                          active_model: modelId,
                        }),
                      )
                    }
                    onSaveModel={(modelId, patch) =>
                      run(
                        modalProvider.id,
                        () =>
                          coreBridge.setModelProfile({
                            provider_id: modalProvider.id,
                            model: modelId,
                            ...patch,
                          }),
                        "Model updated.",
                      )
                    }
                  />
                )}

                {note && <p className="set-hint" style={{ marginTop: "var(--s3)" }}>{note}</p>}
              </div>
            </div>
          )}
        </>
      )}

      {note && sub !== "providers" && (
        <p className="set-hint" style={{ marginTop: "var(--s3)" }}>{note}</p>
      )}
    </div>
  );
}

function ProviderDetailView({
  provider,
  busy,
  editBaseUrl,
  setEditBaseUrl,
  editKey,
  setEditKey,
  showKey,
  setShowKey,
  contextWindow,
  onToggleEnabled,
  onRemove,
  onRefreshModels,
  onGenerateProfiles,
  onSaveConnection,
  onSetModel,
  onSaveModel,
}: {
  provider: ProviderView;
  busy: string | null;
  editBaseUrl: string;
  setEditBaseUrl: (value: string) => void;
  editKey: string;
  setEditKey: (value: string) => void;
  showKey: boolean;
  setShowKey: (value: boolean) => void;
  contextWindow: number | null;
  onToggleEnabled: (next: boolean) => void;
  onRemove: () => void;
  onRefreshModels: () => void;
  onGenerateProfiles: () => void;
  onSaveConnection: () => void;
  onSetModel: (modelId: string) => void;
  onSaveModel: (
    modelId: string,
    patch: {
      tier: string;
      strengths?: string;
      vision?: boolean;
      tools?: boolean;
      reasoning?: boolean;
      context_window?: number;
    },
  ) => void;
}) {
  const { t } = useTranslation();
  const acting = busy === provider.id;
  const localOllama = isLocalOllamaProvider(provider.kind, editBaseUrl || provider.base_url);
  const hasInferred = provider.models.some((m) => m.profile_source === "inferred" || !m.profile_source);
  // Which model row is open in the editor, plus its draft.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    tier: string;
    strengths: string;
    vision: boolean;
    tools: boolean;
    reasoning: boolean;
    contextWindow: string;
  }>({ tier: "balanced", strengths: "", vision: false, tools: true, reasoning: false, contextWindow: "" });

  const openEditor = (m: ProviderModelView) => {
    setEditingId(m.id);
    setDraft({
      tier: m.tier ?? "balanced",
      strengths: m.strengths ?? "",
      vision: m.vision,
      tools: m.tools,
      reasoning: m.reasoning,
      contextWindow: m.context_window ? String(m.context_window) : "",
    });
  };
  return (
    <>
      <div className="mdl-detail-head">
        <h3>{provider.label}</h3>
        <div className="mdl-detail-actions">
          <label className="mdl-enable">
            <Toggle on={provider.enabled} onChange={onToggleEnabled} />
            <span>{provider.enabled ? t("settings.providerEnabled") : t("settings.providerDisabled")}</span>
          </label>
          <button className="set-btn danger" type="button" disabled={acting} onClick={onRemove}>
            <Trash2 size={14} /> {t("common.remove")}
          </button>
        </div>
      </div>
      <p className="mdl-detail-sub">
        {provider.kind} · {localOllama ? t("settings.localOllamaNoKey") : provider.has_key ? t("settings.keyConfigured") : t("settings.noKey")}
      </p>

      <div className="mdl-field">
        <label>API address</label>
        <input
          className="set-input"
          value={editBaseUrl}
          onChange={(event) => setEditBaseUrl(event.target.value)}
        />
      </div>
      {!localOllama && (
        <div className="mdl-field">
          <label>API key</label>
          <div className="mdl-key">
            <input
              className="set-input"
              type={showKey ? "text" : "password"}
              placeholder={provider.has_key ? "•••• (leave empty to keep)" : "sk-…"}
              value={editKey}
              onChange={(event) => setEditKey(event.target.value)}
            />
            <button className="mdl-icon-btn" type="button" aria-label={t("settings.showHide")} onClick={() => setShowKey(!showKey)}>
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </div>
      )}
      <button
        className="set-btn"
        type="button"
        style={{ alignSelf: "flex-start" }}
        disabled={acting}
        onClick={onSaveConnection}
      >
        {t("settings.saveEndpointKey")}
      </button>

      <div className="mdl-field" style={{ marginTop: "var(--s4)" }}>
        <label>{t("settings.activeProviderModel")}</label>
        <select
          className="set-input"
          value={provider.active_model ?? ""}
          disabled={acting}
          onChange={(event) => onSetModel(event.target.value)}
        >
          {provider.models.length === 0 && <option value="">{t("settings.noModelRefresh")}</option>}
          {provider.active_model && !provider.models.some((m) => m.id === provider.active_model) && (
            <option value={provider.active_model}>{provider.active_model}</option>
          )}
          {provider.models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
              {m.tier ? ` · ${m.tier}` : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="mdl-models-head">
        <span>{t("settings.models", { count: provider.models.length })}</span>
        <div className="mdl-detail-actions">
          <button className="set-btn" type="button" disabled={acting} onClick={onRefreshModels}>
            <RefreshCw size={14} /> Refresh
          </button>
          {hasInferred && (
            <button
              className="set-btn"
              type="button"
              disabled={acting}
              title={t("settings.describeNoProfile")}
              onClick={onGenerateProfiles}
            >
              <Sparkles size={14} /> {t("settings.generateProfiles")}
            </button>
          )}
        </div>
      </div>
      <div className="mdl-models">
        {provider.models.length === 0 && (
          <p className="set-hint">{t("settings.noModelsRefreshHint")}</p>
        )}
        {provider.models.map((m) => (
          <div className="mdl-model-cell" key={m.id}>
            <div className="mdl-model-row">
              <div className="mdl-model-info">
                <span className="mdl-model-id">{m.id}</span>
                <div className="mdl-model-tags">
                  {m.modality !== "text" && <span className="mdl-tag">{m.modality}</span>}
                  {m.vision && <span className="mdl-tag">vision</span>}
                  {m.tools && <span className="mdl-tag">tools</span>}
                  {m.reasoning && <span className="mdl-tag think">reasoning</span>}
                  {m.context_window ? <span className="mdl-tag">{formatK(m.context_window)} ctx</span> : null}
                  {m.tier && <span className="mdl-tag tier">{m.tier}</span>}
                  {m.profile_source === "user" && <span className="mdl-tag user">{t("settings.yours")}</span>}
                </div>
                {m.strengths ? (
                  <span className="mdl-model-str" title={m.strengths}>{m.strengths}</span>
                ) : null}
              </div>
              <button
                className="set-btn"
                type="button"
                disabled={acting}
                onClick={() => (editingId === m.id ? setEditingId(null) : openEditor(m))}
              >
                {editingId === m.id ? "Close" : "Edit"}
              </button>
            </div>
            {editingId === m.id && (
              <div className="mdl-model-editor">
                <div className="mdl-field">
                  <label>{t("settings.strengthsDesc")}</label>
                  <textarea
                    className="set-input"
                    rows={2}
                    placeholder={t("settings.strengthsPlaceholder")}
                    value={draft.strengths}
                    onChange={(e) => setDraft({ ...draft, strengths: e.target.value })}
                  />
                </div>
                <div className="mdl-editor-grid">
                  <div className="mdl-field">
                    <label>{t("settings.tier")}</label>
                    <select
                      className="set-input"
                      value={draft.tier}
                      onChange={(e) => setDraft({ ...draft, tier: e.target.value })}
                    >
                      <option value="fast">fast</option>
                      <option value="balanced">balanced</option>
                      <option value="reasoning">reasoning (thinking)</option>
                    </select>
                  </div>
                  <div className="mdl-field">
                    <label>{t("settings.contextWindow")}</label>
                    <input
                      className="set-input"
                      type="number"
                      placeholder={t("settings.contextWindowPlaceholder")}
                      value={draft.contextWindow}
                      onChange={(e) => setDraft({ ...draft, contextWindow: e.target.value })}
                    />
                  </div>
                </div>
                <div className="mdl-editor-checks">
                  <label className="mdl-check">
                    <input
                      type="checkbox"
                      checked={draft.vision}
                      onChange={(e) => setDraft({ ...draft, vision: e.target.checked })}
                    />
                    vision
                  </label>
                  <label className="mdl-check">
                    <input
                      type="checkbox"
                      checked={draft.tools}
                      onChange={(e) => setDraft({ ...draft, tools: e.target.checked })}
                    />
                    tools
                  </label>
                  <label className="mdl-check">
                    <input
                      type="checkbox"
                      checked={draft.reasoning}
                      onChange={(e) => setDraft({ ...draft, reasoning: e.target.checked })}
                    />
                    reasoning (thinking)
                  </label>
                </div>
                <button
                  className="set-btn primary"
                  type="button"
                  style={{ alignSelf: "flex-start" }}
                  disabled={acting}
                  onClick={() => {
                    const ctx = parseInt(draft.contextWindow, 10);
                    onSaveModel(m.id, {
                      tier: draft.tier,
                      strengths: draft.strengths,
                      vision: draft.vision,
                      tools: draft.tools,
                      reasoning: draft.reasoning,
                      ...(Number.isFinite(ctx) && ctx > 0 ? { context_window: ctx } : {}),
                    });
                    setEditingId(null);
                  }}
                >
                  {t("settings.saveModel")}
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="set-meter" style={{ marginTop: "var(--s3)" }}>
        <span className="k"><Cpu size={15} /> {t("settings.activeModelContext")}</span>
        <span className="v">{contextWindow ? t("settings.tokenApprox", { value: formatK(contextWindow) }) : t("settings.na")}</span>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------- privacy */

function PrivacyPane() {
  const { t } = useTranslation();
  return (
    <>
      <div className="set-section-label">Privacy</div>
      <div className="set-rows">
        <ToggleRow
          title={t("settings.localFirstDefault")}
          description={t("settings.localFirstDesc")}
          settingKey="privacy.localFirst"
          fallback={true}
        />
        <ToggleRow
          title={t("settings.managedCloud")}
          description="Cloud connectors (Composio/Zapier) stay disabled until you pick a provider."
          settingKey="privacy.managedCloud"
          fallback={false}
        />
        <ToggleRow
          title={t("settings.approvalGate")}
          description="Write actions and approved automations require explicit confirmation."
          settingKey="privacy.approvalGate"
          fallback={true}
        />
      </div>
      <div className="set-section-label">{t("settings.remoteApproval")}</div>
      <ApprovelRoutingRow />
      <p className="set-hint">
        <ShieldCheck size={13} style={{ verticalAlign: "-2px", marginRight: 4 }} />
        The browser still stops before logins, personal data, payments or purchases.
      </p>
    </>
  );
}

/* --------------------------------------------------------------------- vault */

function VaultPane() {
  const { t } = useTranslation();
  const vaultCategories = [
    { value: "payments", label: t("settings.vaultCategoryPayments") },
    { value: "identity", label: t("settings.vaultCategoryIdentity") },
    { value: "health", label: t("settings.vaultCategoryHealth") },
    { value: "vehicles", label: t("settings.vaultCategoryVehicles") },
    { value: "credentials", label: t("settings.vaultCategoryCredentials") },
    { value: "private_notes", label: t("settings.vaultCategoryPrivateNotes") },
  ];
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [currentPin, setCurrentPin] = useState("");
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [verifyPin, setVerifyPin] = useState("");
  const [manualSecretCategory, setManualSecretCategory] = useState("private_notes");
  const [manualSecretLabel, setManualSecretLabel] = useState("");
  const [manualSecretValue, setManualSecretValue] = useState("");
  const [manualSecretPin, setManualSecretPin] = useState("");
  const [vaultTab, setVaultTab] = useState<"sensitive" | "pin">("sensitive");
  const [vaultAddOpen, setVaultAddOpen] = useState(false);
  // A pending dedup conflict from the Add flow; the user resolves it add/update/ignore.
  const [manualSecretConflict, setManualSecretConflict] =
    useState<VaultProposalAcceptResult | null>(null);
  const [vaultRecords, setVaultRecords] = useState<VaultRecordSummary[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [editingVaultRecord, setEditingVaultRecord] = useState<VaultRecordSummary | null>(null);
  const [editVaultCategory, setEditVaultCategory] = useState("private_notes");
  const [editVaultLabel, setEditVaultLabel] = useState("");
  const [editVaultPin, setEditVaultPin] = useState("");
  const [editVaultSecretValue, setEditVaultSecretValue] = useState("");
  const [editVaultSecretUnlocked, setEditVaultSecretUnlocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function selectVaultTab(tab: "sensitive" | "pin") {
    setVaultTab(tab);
    setNote(null);
    setError(null);
  }

  function startVaultRecordEdit(record: VaultRecordSummary) {
    setEditingVaultRecord(record);
    setEditVaultCategory(record.category);
    setEditVaultLabel(record.label);
    setEditVaultPin("");
    setEditVaultSecretValue("");
    setEditVaultSecretUnlocked(false);
    setNote(null);
    setError(null);
  }

  function cancelVaultRecordEdit() {
    setEditingVaultRecord(null);
    setEditVaultLabel("");
    setEditVaultCategory("private_notes");
    setEditVaultPin("");
    setEditVaultSecretValue("");
    setEditVaultSecretUnlocked(false);
  }

  function openVaultAddModal() {
    setVaultAddOpen(true);
    setNote(null);
    setError(null);
  }

  function closeVaultAddModal() {
    setVaultAddOpen(false);
    setManualSecretValue("");
    setManualSecretPin("");
    setManualSecretConflict(null);
    setError(null);
  }

  async function refresh() {
    try {
      const status = await coreBridge.vaultPinStatus();
      setConfigured(status.configured);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function refreshVaultRecords() {
    setRecordsLoading(true);
    try {
      const result = await coreBridge.vaultRecords();
      setVaultRecords(result.records);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRecordsLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    void refreshVaultRecords();
  }, []);

  async function setupPin() {
    setError(null);
    setNote(null);
    if (pin !== pinConfirm) {
      setError(t("settings.vaultPinMismatch"));
      return;
    }
    if (configured && currentPin.length === 0) {
      setError(t("settings.vaultCurrentPinRequired"));
      return;
    }
    setBusy(true);
    try {
      const status = await coreBridge.vaultPinSetup(
        pin,
        configured ? currentPin : undefined,
      );
      setConfigured(status.configured);
      setCurrentPin("");
      setPin("");
      setPinConfirm("");
      setNote(t("settings.vaultPinConfigured"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      const result = await coreBridge.vaultPinVerify(verifyPin);
      setNote(result.ok ? t("settings.vaultPinVerified") : t("settings.vaultPinInvalid"));
      setVerifyPin("");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveManualSecret() {
    setError(null);
    setNote(null);
    const label = manualSecretLabel.trim();
    if (!configured) {
      setError(t("settings.vaultConfigurePinFirst"));
      return;
    }
    if (label.length === 0 || manualSecretValue.trim().length === 0) {
      setError(t("settings.vaultManualRequired"));
      return;
    }
    if (manualSecretPin.length === 0) {
      setError(t("settings.vaultManualPinRequired"));
      return;
    }
    setBusy(true);
    try {
      await applyManualSecretResult(
        await coreBridge.vaultProposalAccept({
          category: manualSecretCategory,
          label,
          redacted_preview: `[VAULT:${manualSecretCategory}:${label}]`,
          secret_value: manualSecretValue.trim(),
          pin: manualSecretPin,
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // A save returns "created", "ignored" (identical record already existed), or
  // "conflict" (a partial match to resolve). Only a resolved/created save clears
  // the form; a conflict opens the resolution dialog.
  async function applyManualSecretResult(result: VaultProposalAcceptResult) {
    if (result.status === "conflict") {
      setManualSecretConflict(result);
      return;
    }
    setManualSecretConflict(null);
    setManualSecretLabel("");
    setManualSecretValue("");
    setManualSecretPin("");
    setVaultAddOpen(false);
    await refreshVaultRecords();
    setNote(
      result.status === "ignored"
        ? t("settings.vaultManualDuplicate", { label: result.label })
        : t("settings.vaultManualSaved", { id: result.record_id }),
    );
  }

  async function resolveManualSecretConflict(resolution: "add" | "update" | "ignore") {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      await applyManualSecretResult(
        await coreBridge.vaultProposalAccept({
          category: manualSecretCategory,
          label: manualSecretLabel.trim(),
          redacted_preview: `[VAULT:${manualSecretCategory}:${manualSecretLabel.trim()}]`,
          secret_value: manualSecretValue.trim(),
          pin: manualSecretPin,
          resolution,
          ...(resolution === "add"
            ? {}
            : { record_id: manualSecretConflict?.existing?.id }),
        }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function deleteVaultRecord(record: VaultRecordSummary) {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      await coreBridge.vaultRecordDelete(record.id);
      if (editingVaultRecord?.id === record.id) {
        cancelVaultRecordEdit();
      }
      await refreshVaultRecords();
      setNote(t("settings.vaultRecordDeleted", { label: record.label }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveVaultRecordEdit() {
    setError(null);
    setNote(null);
    if (!editingVaultRecord) return;
    const label = editVaultLabel.trim();
    if (label.length === 0) {
      setError(t("settings.vaultEditRequired"));
      return;
    }
    setBusy(true);
    try {
      const result = await coreBridge.vaultRecordUpdate(editingVaultRecord.id, {
        category: editVaultCategory,
        label,
        ...(editVaultSecretUnlocked
          ? { secret_value: editVaultSecretValue, pin: editVaultPin }
          : {}),
      });
      await refreshVaultRecords();
      cancelVaultRecordEdit();
      setNote(t("settings.vaultRecordUpdated", { label: result.record.label }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revealVaultRecordSecret() {
    setError(null);
    setNote(null);
    if (!editingVaultRecord) return;
    if (editVaultPin.length === 0) {
      setError(t("settings.vaultManualPinRequired"));
      return;
    }
    setBusy(true);
    try {
      const result = await coreBridge.vaultRecordReveal(editingVaultRecord.id, editVaultPin);
      setEditVaultSecretValue(result.secret_value);
      setEditVaultSecretUnlocked(true);
      setNote(t("settings.vaultSecretUnlocked"));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function vaultCategoryLabel(category: string) {
    return vaultCategories.find((item) => item.value === category)?.label ?? category;
  }

  return (
    <div className="vault-pane">
      <div className="set-section-label">{t("settings.vault")}</div>
      <div className="set-seg vault-tabs" role="tablist" aria-label={t("settings.vault")}>
        <button
          type="button"
          role="tab"
          aria-selected={vaultTab === "sensitive"}
          className={`set-seg-item ${vaultTab === "sensitive" ? "active" : ""}`}
          onClick={() => selectVaultTab("sensitive")}
        >
          {t("settings.vaultSensitiveDataTab")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={vaultTab === "pin"}
          className={`set-seg-item ${vaultTab === "pin" ? "active" : ""}`}
          onClick={() => selectVaultTab("pin")}
        >
          {t("settings.vaultPinTab")}
        </button>
      </div>

      {vaultTab === "pin" && (
        <div className="set-card" role="tabpanel">
          <div className="set-card-top">
            <span className="set-card-name">{t("settings.vaultLocalPin")}</span>
            <span className={`set-badge ${configured ? "green" : "muted"}`}>
              {configured == null
                ? t("settings.vaultChecking")
                : configured
                  ? t("settings.vaultConfigured")
                  : t("settings.vaultNotConfigured")}
            </span>
          </div>
          <p className="set-hint">
            {t("settings.vaultPinHint")}
          </p>
          <div className="set-card-divider" />
          <div className="set-rows">
            <div className="set-row">
              <div>
                <div className="rk">
                  {configured ? t("settings.vaultChangePin") : t("settings.vaultNewPin")}
                </div>
                <div className="rv">
                  {configured
                    ? t("settings.vaultChangePinDesc")
                    : t("settings.vaultNewPinDesc")}
                </div>
              </div>
              <div style={{ display: "grid", gap: 8, minWidth: 220 }}>
                {configured && (
                  <input
                    className="set-input"
                    inputMode="numeric"
                    type="password"
                    value={currentPin}
                    placeholder={t("settings.vaultCurrentPin")}
                    onChange={(event) => setCurrentPin(event.target.value)}
                  />
                )}
                <input
                  className="set-input"
                  inputMode="numeric"
                  type="password"
                  value={pin}
                  placeholder={t("settings.vaultPinPlaceholder")}
                  onChange={(event) => setPin(event.target.value)}
                />
                <input
                  className="set-input"
                  inputMode="numeric"
                  type="password"
                  value={pinConfirm}
                  placeholder={t("settings.vaultConfirmPin")}
                  onChange={(event) => setPinConfirm(event.target.value)}
                />
                <button
                  className="set-btn primary"
                  type="button"
                  disabled={
                    busy ||
                    pin.length === 0 ||
                    pinConfirm.length === 0 ||
                    (configured === true && currentPin.length === 0)
                  }
                  onClick={() => void setupPin()}
                >
                  {configured ? t("settings.vaultChangePin") : t("settings.vaultSavePin")}
                </button>
              </div>
            </div>
            <div className="set-row">
              <div>
                <div className="rk">{t("settings.vaultVerifyPin")}</div>
                <div className="rv">{t("settings.vaultVerifyPinDesc")}</div>
              </div>
              <div style={{ display: "flex", gap: 8, minWidth: 260 }}>
                <input
                  className="set-input"
                  inputMode="numeric"
                  type="password"
                  value={verifyPin}
                  placeholder={t("settings.vaultPinPlaceholder")}
                  onChange={(event) => setVerifyPin(event.target.value)}
                />
                <button
                  className="set-btn"
                  type="button"
                  disabled={busy || verifyPin.length === 0}
                  onClick={() => void verify()}
                >
                  {t("settings.vaultVerify")}
                </button>
              </div>
            </div>
          </div>
          {note && <p className="set-hint">{note}</p>}
          {error && <p className="cmp-confirm-err">{error}</p>}
        </div>
      )}
      {vaultTab === "sensitive" && (
        <>
          <div className="set-card" role="tabpanel">
            <div className="set-card-top">
              <span className="set-card-name">{t("settings.vaultSavedRecords")}</span>
              <div className="vault-toolbar-actions">
                <button
                  className="set-btn primary"
                  type="button"
                  onClick={openVaultAddModal}
                >
                  <Plus size={14} />
                  {t("common.add")}
                </button>
                <button
                  className="set-btn"
                  type="button"
                  disabled={recordsLoading}
                  onClick={() => void refreshVaultRecords()}
                >
                  {t("settings.refresh")}
                </button>
              </div>
            </div>
            <p className="set-hint">
              {t("settings.vaultSaveSensitiveHint")}
            </p>
            <div className="set-card-divider" />
            <div className="vault-record-list">
              {recordsLoading && vaultRecords.length === 0 && (
                <p className="set-hint">{t("settings.loadingShort")}</p>
              )}
              {!recordsLoading && vaultRecords.length === 0 && (
                <p className="set-hint">{t("settings.vaultNoRecords")}</p>
              )}
              {vaultRecords.map((record) => {
                const editing = editingVaultRecord?.id === record.id;
                return (
                  <div className="vault-record-row" key={record.id}>
                    <div>
                      <div className="vault-record-title">{record.label}</div>
                      <div className="vault-record-meta">
                        {vaultCategoryLabel(record.category)} · {record.redacted_preview}
                      </div>
                      {editing && (
                        <div className="vault-record-edit">
                          <select
                            className="set-input"
                            value={editVaultCategory}
                            aria-label={t("settings.vaultEditCategory")}
                            onChange={(event) => setEditVaultCategory(event.target.value)}
                          >
                            {vaultCategories.map((category) => (
                              <option key={category.value} value={category.value}>
                                {category.label}
                              </option>
                            ))}
                          </select>
                          <input
                            className="set-input"
                            value={editVaultLabel}
                            aria-label={t("settings.vaultEditLabel")}
                            onChange={(event) => setEditVaultLabel(event.target.value)}
                          />
                          <input
                            className="set-input"
                            inputMode="numeric"
                            type="password"
                            value={editVaultPin}
                            placeholder={t("settings.vaultPinPlaceholder")}
                            aria-label={t("settings.vaultEditPin")}
                            onChange={(event) => {
                              setEditVaultPin(event.target.value);
                              setEditVaultSecretUnlocked(false);
                              setEditVaultSecretValue("");
                            }}
                          />
                          <button
                            className="set-btn"
                            type="button"
                            disabled={busy || editVaultPin.length === 0}
                            onClick={() => void revealVaultRecordSecret()}
                          >
                            {t("settings.vaultUnlockValue")}
                          </button>
                          {editVaultSecretUnlocked && (
                            <textarea
                              className="set-input vault-secret-edit"
                              value={editVaultSecretValue}
                              rows={3}
                              aria-label={t("settings.vaultSecretValue")}
                              onChange={(event) => setEditVaultSecretValue(event.target.value)}
                            />
                          )}
                        </div>
                      )}
                    </div>
                    <div className="vault-record-actions">
                      {editing ? (
                        <>
                          <button
                            className="set-btn"
                            type="button"
                            disabled={busy}
                            onClick={cancelVaultRecordEdit}
                          >
                            {t("settings.vaultCancelEdit")}
                          </button>
                          <button
                            className="set-btn primary"
                            type="button"
                            disabled={
                              busy ||
                              editVaultLabel.trim().length === 0 ||
                              (editVaultSecretUnlocked && editVaultPin.length === 0)
                            }
                            onClick={() => void saveVaultRecordEdit()}
                          >
                            {t("settings.vaultSaveEdit")}
                          </button>
                        </>
                      ) : (
                        <button
                          className="set-btn"
                          type="button"
                          disabled={busy}
                          onClick={() => startVaultRecordEdit(record)}
                        >
                          <Pencil size={14} />
                          {t("settings.vaultEdit")}
                        </button>
                      )}
                      <button
                        className="set-btn danger"
                        type="button"
                        disabled={busy}
                        onClick={() => void deleteVaultRecord(record)}
                      >
                        <Trash2 size={14} />
                        {t("settings.deleteData")}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            {note && <p className="set-hint">{note}</p>}
            {error && <p className="cmp-confirm-err">{error}</p>}
          </div>

          {vaultAddOpen && (
            <div className="set-modal-overlay" role="dialog" aria-modal="true" aria-label={t("settings.vaultSaveSensitive")}>
              <div className="set-modal-scrim" onClick={closeVaultAddModal} />
              <div className="set-modal vault-add-modal">
                <button className="set-modal-close" type="button" aria-label={t("common.close")} onClick={closeVaultAddModal}>
                  <X size={16} />
                </button>
                <div className="mdl-detail-head">
                  <div>
                    <h3>{t("settings.vaultSaveSensitive")}</h3>
                    <p className="mdl-detail-sub">{t("settings.vaultSaveSensitiveHint")}</p>
                  </div>
                  <span className="set-badge muted">{t("settings.vaultEncrypted")}</span>
                </div>
                <div className="set-rows vault-add-form">
                  <div className="set-row">
                    <div>
                      <div className="rk">{t("settings.vaultCategory")}</div>
                      <div className="rv">{t("settings.vaultCategoryDesc")}</div>
                    </div>
                    <select
                      className="set-input"
                      value={manualSecretCategory}
                      onChange={(event) => setManualSecretCategory(event.target.value)}
                    >
                      {vaultCategories.map((category) => (
                        <option key={category.value} value={category.value}>
                          {category.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="set-row">
                    <div>
                      <div className="rk">{t("settings.vaultLabel")}</div>
                      <div className="rv">{t("settings.vaultLabelDesc")}</div>
                    </div>
                    <input
                      className="set-input"
                      value={manualSecretLabel}
                      placeholder={t("settings.vaultLabelPlaceholder")}
                      onChange={(event) => setManualSecretLabel(event.target.value)}
                    />
                  </div>
                  <div className="set-row">
                    <div>
                      <div className="rk">{t("settings.vaultValue")}</div>
                      <div className="rv">{t("settings.vaultValueDesc")}</div>
                    </div>
                    <textarea
                      className="set-input"
                      value={manualSecretValue}
                      placeholder={t("settings.vaultValuePlaceholder")}
                      rows={4}
                      onChange={(event) => setManualSecretValue(event.target.value)}
                    />
                  </div>
                  <div className="set-row">
                    <div>
                      <div className="rk">{t("settings.vaultLocalPin")}</div>
                      <div className="rv">{t("settings.vaultManualPinDesc")}</div>
                    </div>
                    <input
                      className="set-input"
                      inputMode="numeric"
                      type="password"
                      value={manualSecretPin}
                      placeholder={t("settings.vaultPinPlaceholder")}
                      onChange={(event) => setManualSecretPin(event.target.value)}
                    />
                  </div>
                </div>
                <div className="vault-modal-actions">
                  <button
                    className="set-btn"
                    type="button"
                    disabled={busy}
                    onClick={closeVaultAddModal}
                  >
                    {t("common.cancel")}
                  </button>
                  <button
                    className="set-btn primary"
                    type="button"
                    disabled={
                      busy ||
                      !configured ||
                      manualSecretLabel.trim().length === 0 ||
                      manualSecretValue.trim().length === 0 ||
                      manualSecretPin.length === 0
                    }
                    onClick={() => void saveManualSecret()}
                  >
                    {t("settings.vaultSave")}
                  </button>
                </div>
                {manualSecretConflict && (
                  <div className="vault-conflict">
                    <p className="cmp-confirm-note">
                      {manualSecretConflict.match_type === "key"
                        ? t("settings.vaultConflictKey", {
                            label: manualSecretConflict.existing?.label ?? "",
                          })
                        : t("settings.vaultConflictValue", {
                            label: manualSecretConflict.existing?.label ?? "",
                          })}
                    </p>
                    <div className="vault-modal-actions">
                      <button
                        className="set-btn primary"
                        type="button"
                        disabled={busy}
                        onClick={() => void resolveManualSecretConflict("update")}
                      >
                        {t("settings.vaultConflictUpdate")}
                      </button>
                      <button
                        className="set-btn"
                        type="button"
                        disabled={busy}
                        onClick={() => void resolveManualSecretConflict("add")}
                      >
                        {t("settings.vaultConflictAdd")}
                      </button>
                      <button
                        className="set-btn"
                        type="button"
                        disabled={busy}
                        onClick={() => void resolveManualSecretConflict("ignore")}
                      >
                        {t("settings.vaultConflictIgnore")}
                      </button>
                    </div>
                  </div>
                )}
                {error && <p className="cmp-confirm-err">{error}</p>}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- connectors */

type ConnectorsSub = "composio" | "mcp" | "attivita";

// Full-width connectors pane driven by the nav submenu (Composio / filesystem /
// MCP catalog / Activity). The old internal master-detail rail (.mdl-rail) is
// gone: each `sub` renders full-width. All data + coreBridge logic is unchanged —
// only the layout that selects which detail to show.
function ConnectorsPane({ sub = "composio" }: { sub?: ConnectorsSub }) {
  const { t } = useTranslation();
  const [snap, setSnap] = useState<CoreCapabilitySnapshot | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setSnap(await coreBridge.capabilities());
    } catch {
      /* keep previous */
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  // Notes are scoped to a sub-view; clear when switching so a stale message from
  // (say) Composio doesn't linger under the MCP catalogue.
  useEffect(() => {
    setNote(null);
  }, [sub]);

  const composioConn = snap?.connections.find((c) => c.provider_id === "composio") ?? null;
  // The backend ConnectionStatus serializes as snake_case ("active" | "expired" |
  // "failed" | "disabled"). A stored composio connection in "active" means the key
  // verified and toolkits are cached → treat it as connected.
  const composioConnected = composioConn?.status.toLowerCase() === "active";

  return (
    <div className="conn-pane">
      {sub === "composio" && (
        <ComposioDetail
          connected={composioConnected}
          onChanged={refresh}
          onNote={setNote}
        />
      )}

      {sub === "mcp" && <McpManager onChanged={refresh} onNote={setNote} />}

      {sub === "attivita" && <ConnectorActivityDetail />}

      {note && (
        <p className="set-hint" style={{ marginTop: "var(--s4)" }}>
          {note}
        </p>
      )}
    </div>
  );
}

/** Unified MCP screen (like Skills): Active | Catalog tabs. "Active" lists ALL
 *  configured servers from /connected (NOT tool-derived, so a 0-tool / pending-auth
 *  server still shows), each with its tool count + a disconnect. The Add form
 *  supports a local command (stdio) OR a remote URL. */
function McpManager({
  onChanged,
  onNote,
}: {
  onChanged: () => Promise<void>;
  onNote: (note: string | null) => void;
}) {
  const [tab, setTab] = useState<"active" | "catalog">("active");
  const [servers, setServers] = useState<McpConnectedServer[]>([]);
  const [adding, setAdding] = useState(false);

  const reload = async () => {
    try {
      setServers(await coreBridge.mcpConnected());
    } catch {
      /* keep previous */
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  const refreshAll = async () => {
    await onChanged();
    await reload();
  };

  const disconnect = async (id: string) => {
    onNote(null);
    try {
      await coreBridge.mcpDisconnect(id);
      await refreshAll();
    } catch (error) {
      onNote((error as Error).message);
    }
  };

  return (
    <div className="conn-stack">
      <div style={{ display: "flex", gap: 8, marginBottom: "var(--s3)" }}>
        <button
          type="button"
          className={`set-btn${tab === "active" ? " primary" : ""}`}
          onClick={() => setTab("active")}
        >
          Active
        </button>
        <button
          type="button"
          className={`set-btn${tab === "catalog" ? " primary" : ""}`}
          onClick={() => setTab("catalog")}
        >
          Catalog
        </button>
      </div>

      {tab === "active" ? (
        <>
          {servers.length === 0 && !adding && (
            <p className="set-hint">No MCP servers yet. Add one below, or browse the Catalog.</p>
          )}

          {servers.map((s) => (
            <div
              key={s.provider_id}
              className="set-card"
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <div>
                <strong>{s.name}</strong>
                <span className="set-hint" style={{ marginLeft: 8 }}>
                  {s.tools} tool{s.tools === 1 ? "" : "s"}
                  {s.tools === 0 ? " — none discovered (check the URL or auth)" : ""}
                </span>
              </div>
              <button
                type="button"
                className="set-btn danger"
                onClick={() => void disconnect(s.provider_id)}
              >
                Disconnect
              </button>
            </div>
          ))}

          {adding ? (
            <McpAddDetail
              onChanged={async () => {
                await refreshAll();
                setAdding(false);
              }}
              onNote={onNote}
              onConnected={() => void refreshAll()}
            />
          ) : (
            <button
              type="button"
              className="set-btn"
              style={{ alignSelf: "flex-start" }}
              onClick={() => setAdding(true)}
            >
              <Plus size={14} />
              <span style={{ marginLeft: 6 }}>Add MCP server</span>
            </button>
          )}
        </>
      ) : (
        <McpCatalogDetail
          connectedIds={new Set(servers.map((s) => s.provider_id))}
          onChanged={refreshAll}
          onNote={onNote}
          onConnected={() => void refreshAll()}
        />
      )}
    </div>
  );
}

// Recent connector tool executions — the audit half of roadmap #6. Shows what the
// assistant actually ran (Composio/MCP), with a failure category so a broken
// connector is visible at a glance (auth → reconnect, rate_limit → wait, …).
const RUN_ERROR_LABEL_KEY: Record<string, string> = {
  auth: "settings.runErrAuth",
  rate_limit: "settings.runErrRateLimit",
  forbidden: "settings.runErrForbidden",
  unavailable: "settings.runErrUnavailable",
  other: "settings.runErrOther",
};

function runRelTime(ts: number, t: (k: string, o?: Record<string, unknown>) => string): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (secs < 60) return t("settings.timeNow");
  if (secs < 3600) return t("settings.minutesAgo", { count: Math.floor(secs / 60) });
  if (secs < 86400) return t("settings.hoursAgo", { count: Math.floor(secs / 3600) });
  return t("settings.daysAgo", { count: Math.floor(secs / 86400) });
}

function ConnectorActivityDetail() {
  const { t } = useTranslation();
  const [runs, setRuns] = useState<ConnectorToolRun[] | null>(null);
  const load = () => {
    coreBridge
      .toolRuns(100)
      .then(setRuns)
      .catch(() => setRuns([]));
  };
  useEffect(() => {
    load();
  }, []);

  return (
    <div className="conn-activity">
      <div className="conn-activity-head">
        <div>
          <h3 className="conn-activity-title">{t("settings.connectorsActivity")}</h3>
          <p className="set-hint" style={{ margin: 0 }}>
            Latest runs of connected tools (Composio and MCP) in chats.
          </p>
        </div>
        <button type="button" className="set-btn" onClick={load}>
          {t("settings.refresh")}
        </button>
      </div>
      {runs === null ? (
        <p className="set-hint">{t("settings.loadingShort")}</p>
      ) : runs.length === 0 ? (
        <p className="set-hint">{t("settings.noRunsYet")}</p>
      ) : (
        <div className="tool-runs">
          {runs.map((r, i) => (
            <div className={`tool-run ${r.ok ? "ok" : "fail"}`} key={`${r.ts}-${i}`}>
              <span className="tool-run-icon" title={r.ok ? t("settings.succeeded") : t("settings.failed")}>
                {r.ok ? <Check size={13} /> : <AlertTriangle size={13} />}
              </span>
              <span className="tool-run-tool" title={r.tool}>
                {r.tool}
              </span>
              <span className="mdl-tag tool-run-kind">{r.kind}</span>
              {!r.ok && r.error_kind && (
                <span className="tool-run-err">
                  {RUN_ERROR_LABEL_KEY[r.error_kind] ? t(RUN_ERROR_LABEL_KEY[r.error_kind]) : r.error_kind}
                </span>
              )}
              {r.duration_ms != null && (
                <span className="tool-run-dur">{r.duration_ms} ms</span>
              )}
              <span className="tool-run-time">{runRelTime(r.ts, t)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Connected accounts list with status + remove — surfaces ACTIVE/EXPIRED and lets the
// user prune stale OAuth connections (roadmap #6).
function ComposioConnectionsList() {
  const { t } = useTranslation();
  type Conn = Awaited<ReturnType<typeof coreBridge.composioConnections>>[number];
  const [conns, setConns] = useState<Conn[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = () => {
    coreBridge.composioConnections().then(setConns).catch(() => setConns([]));
  };
  useEffect(() => {
    load();
  }, []);
  if (!conns || conns.length === 0)
    return (
      <p className="set-hint">
        {t("settings.noLinkedAccount")}
      </p>
    );
  const label = (s: string) =>
    s === "ACTIVE" ? t("settings.statusActive") : s === "EXPIRED" ? t("settings.statusExpired") : s.toLowerCase();
  return (
    <div className="cmp-connlist">
      <div className="cmp-connlist-head">{t("settings.linkedAccounts")}</div>
      {conns.map((c) => (
        <div className="cmp-connrow" key={c.id}>
          <span className="cmp-connrow-kit">{c.toolkit_slug || c.id}</span>
          <span className={`cmp-connrow-status ${c.status.toLowerCase()}`}>{label(c.status)}</span>
          <button
            type="button"
            className="mdl-icon-btn"
            title={t("settings.removeAccount")}
            disabled={busy === c.id}
            onClick={() => {
              setBusy(c.id);
              coreBridge
                .composioDisconnect(c.id)
                .then(load)
                .catch(() => {})
                .finally(() => setBusy(null));
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}

function ComposioDetail({
  connected,
  onChanged,
  onNote,
}: {
  connected: boolean;
  onChanged: () => Promise<void>;
  onNote: (note: string | null) => void;
}) {
  const { t } = useTranslation();
  const [apiKey, setApiKey] = useState("");
  const [toolkits, setToolkits] = useState<ComposioToolkit[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingKits, setLoadingKits] = useState(false);
  // Number of services with a live (ACTIVE) connected account — reported by the
  // toolkit browser, which already polls connections.
  const [connectedCount, setConnectedCount] = useState(0);
  // Set when the existing connection's key fails to list toolkits (invalid /
  // expired / revoked). We then fall back to the key form so the user can fix it.
  const [kitsError, setKitsError] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  // Segmented control (Toolkit / Account collegati / Consentiti) — shown once a
  // live connection exists, replacing the previous stacked layout.
  const [tab, setTab] = useState<"toolkit" | "account" | "consentiti">("toolkit");

  const loadToolkits = async () => {
    setLoadingKits(true);
    setKitsError(null);
    try {
      setToolkits(await coreBridge.composioToolkits());
    } catch (error) {
      setKitsError((error as Error).message);
    } finally {
      setLoadingKits(false);
    }
  };
  useEffect(() => {
    if (connected) {
      void loadToolkits();
    } else {
      setToolkits([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const submitKey = async () => {
    setBusy(true);
    onNote(null);
    try {
      const result = await coreBridge.composioConnect(apiKey.trim());
      onNote(t("settings.composioLinked", { count: result.tools_cached }));
      setApiKey("");
      setEditingKey(false);
      setKitsError(null);
      await onChanged();
      await loadToolkits();
    } catch (error) {
      onNote(t("settings.composioNotLinked", { message: (error as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  // Show the key form when there is no live connection, when the stored key is
  // not working, or when the user explicitly chose to change it.
  const showForm = !connected || editingKey || kitsError !== null;

  return (
    <>
      <div className="mdl-detail-head">
        <div className="conn-detail-title">
          <span className="conn-avatar lg composio">Co</span>
          <div className="conn-detail-titletext">
            <h3 className="mdl-detail-title">Composio</h3>
            <p className="mdl-detail-sub">
              {connected
                ? connectedCount > 0
                  ? t("settings.connectedServices", { count: connectedCount })
                  : "Connected · no service linked yet"
                : "Cloud toolkit hub (Gmail, GitHub, Slack…) with managed OAuth."}
            </p>
          </div>
          {connected && !showForm && (
            <button
              className="set-btn"
              type="button"
              onClick={() => setEditingKey(true)}
            >
              {t("settings.changeKey")}
            </button>
          )}
          <span className={`set-badge ${connected ? "green" : "muted"}`}>
            {connected ? "Connected" : "Not connected"}
          </span>
        </div>
      </div>

      {showForm ? (
        <div className="mdl-field">
          {kitsError && (
            <p className="set-hint">
              The existing connection is not responding ({kitsError}). Re-enter a valid API key.
            </p>
          )}
          <label className="mdl-field-label">Composio API key</label>
          <input
            className="set-input"
            type="password"
            placeholder="comp_…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && apiKey.trim() && !busy) void submitKey();
            }}
          />
          <div style={{ display: "flex", gap: "var(--s2)", marginTop: 12 }}>
            <button
              className="set-btn primary"
              type="button"
              disabled={busy || !apiKey.trim()}
              onClick={() => void submitKey()}
            >
              {busy ? "Connecting…" : connected ? "Update key" : "Connect Composio"}
            </button>
            {connected && editingKey && !kitsError && (
              <button
                className="set-btn"
                type="button"
                disabled={busy}
                onClick={() => {
                  setEditingKey(false);
                  setApiKey("");
                }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      ) : (
        <>
          <div className="set-seg conn-seg" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "toolkit"}
              className={`set-seg-item ${tab === "toolkit" ? "active" : ""}`}
              onClick={() => setTab("toolkit")}
            >
              Toolkit
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "account"}
              className={`set-seg-item ${tab === "account" ? "active" : ""}`}
              onClick={() => setTab("account")}
            >
              {t("settings.linkedAccounts")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "consentiti"}
              className={`set-seg-item ${tab === "consentiti" ? "active" : ""}`}
              onClick={() => setTab("consentiti")}
            >
              {t("settings.allowed")}
            </button>
          </div>

          {tab === "toolkit" && (
            <ComposioToolkitBrowser
              toolkits={toolkits}
              loading={loadingKits}
              onNote={onNote}
              onConnectedCount={setConnectedCount}
            />
          )}
          {tab === "account" && <ComposioConnectionsList />}
          {tab === "consentiti" && <AllowedToolsSection />}
        </>
      )}
    </>
  );
}

/** Tools the user marked "always allow": run without per-call confirmation.
 *  Listed here so the user can revoke them. */
function AllowedToolsSection() {
  const { t } = useTranslation();
  const [tools, setTools] = useState<AllowedTool[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setTools(await coreBridge.composioAllowedTools());
      } catch {
        /* leave empty */
      }
    })();
  }, []);

  if (tools.length === 0)
    return (
      <p className="set-hint">
        No always-allowed tool. When you approve a "always" action, it will appear here.
      </p>
    );

  const revoke = async (slug: string) => {
    setBusy(slug);
    try {
      setTools(await coreBridge.composioRevokeTool(slug));
    } catch {
      /* keep previous */
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="cmp-allowed">
      <div className="mdl-detail-section-label">{t("settings.alwaysAllowed")}</div>
      <div className="cmp-allowed-list">
        {tools.map((tool) => (
          <div key={tool.slug} className="cmp-allowed-row">
            <ShieldCheck size={14} />
            <span className="cmp-allowed-name">{tool.name}</span>
            <code className="cmp-allowed-slug">{tool.slug}</code>
            <button
              className="mdl-icon-btn"
              type="button"
              disabled={busy === tool.slug}
              title={t("settings.revokeTitle", { name: tool.name })}
              aria-label={t("settings.revoke", { name: tool.name })}
              onClick={() => void revoke(tool.slug)}
            >
              <Trash2 size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Connection status of a toolkit, derived from Composio connected-account state. */
type KitState = "connected" | "connecting" | "expired" | "none";

function kitStateFromStatus(status: string | undefined): KitState {
  if (!status) return "none";
  const s = status.toUpperCase();
  if (s === "ACTIVE") return "connected";
  if (s === "INITIATED" || s === "INITIALIZING" || s === "PENDING") return "connecting";
  // Connected before but the authorization lapsed → distinct from "never connected"
  // so the user knows to reconnect rather than thinking it's just unconfigured.
  if (s === "EXPIRED" || s === "INACTIVE" || s === "FAILED") return "expired";
  return "none";
}

function ComposioToolkitBrowser({
  toolkits,
  loading,
  onNote,
  onConnectedCount,
}: {
  toolkits: ComposioToolkit[];
  loading: boolean;
  onNote: (note: string | null) => void;
  onConnectedCount: (n: number) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  // toolkit slug → best connection state. A toolkit can have several connected
  // accounts (e.g. a fresh ACTIVE one plus stale EXPIRED ones); we keep the best
  // so a live connection is never masked by an old expired record.
  const [connState, setConnState] = useState<Record<string, KitState>>({});
  // Slugs we are actively polling after kicking off an OAuth link.
  const [polling, setPolling] = useState<Set<string>>(new Set());
  const [modalKit, setModalKit] = useState<ComposioToolkit | null>(null);

  const refreshConnections = async () => {
    try {
      const conns = await coreBridge.composioConnections();
      const rank: Record<KitState, number> = { none: 0, expired: 1, connecting: 2, connected: 3 };
      const next: Record<string, KitState> = {};
      for (const c of conns) {
        if (!c.toolkit_slug) continue;
        const candidate = kitStateFromStatus(c.status);
        const current = next[c.toolkit_slug] ?? "none";
        if (rank[candidate] > rank[current]) next[c.toolkit_slug] = candidate;
      }
      setConnState(next);
      return next;
    } catch {
      return {} as Record<string, KitState>;
    }
  };
  useEffect(() => {
    void refreshConnections();
  }, []);

  // Report the live connected-service count up to the header.
  useEffect(() => {
    onConnectedCount(Object.values(connState).filter((s) => s === "connected").length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connState]);

  // Composio exposes dozens of granular categories; show only the most populated
  // ones as quick filters (+ "All") to keep the chip row clean — the rest stay
  // reachable via search.
  const categories = (() => {
    const counts = new Map<string, number>();
    for (const t of toolkits)
      for (const c of t.categories ?? []) counts.set(c, (counts.get(c) ?? 0) + 1);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([c]) => c);
  })();

  // A confirmed live connection always wins; otherwise reflect the polling spinner.
  const stateOf = (slug: string): KitState => {
    const known = connState[slug] ?? "none";
    if (known === "connected") return "connected";
    return polling.has(slug) ? "connecting" : known;
  };

  const q = query.trim().toLowerCase();
  const filtered = toolkits.filter((t) => {
    if (category !== "all" && !(t.categories ?? []).includes(category)) return false;
    if (!q) return true;
    return (
      t.name.toLowerCase().includes(q) ||
      t.slug.toLowerCase().includes(q) ||
      (t.categories ?? []).some((c) => c.toLowerCase().includes(q))
    );
  });

  // Link a toolkit. With an apiKey we run Composio's custom API-key flow (active
  // immediately, no browser); otherwise managed OAuth → open the redirect and
  // poll until Composio reports the account ACTIVE ("detect automatically").
  const connect = async (kit: ComposioToolkit, input?: ComposioLinkInput) => {
    onNote(null);
    setModalKit(null);
    let redirect = "";
    try {
      const result = await coreBridge.composioLink(kit.slug, input);
      redirect = result.redirect_url || "";
    } catch (error) {
      onNote(t("settings.linkFailed", { message: (error as Error).message }));
      return;
    }
    if (redirect) {
      window.open(redirect, "_blank", "noopener,noreferrer");
      onNote(t("settings.authorizeInBrowser", { name: kit.name }));
    } else {
      onNote(t("settings.linking", { name: kit.name }));
    }
    setPolling((prev) => new Set(prev).add(kit.slug));
    // OAuth needs the user to authorize in the browser (slow); an API-key
    // connection is active right away (fast, short poll).
    const deadline = Date.now() + (redirect ? 150_000 : 20_000);
    const step = redirect ? 3000 : 1500;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, step));
      const map = await refreshConnections();
      if (map[kit.slug] === "connected") {
        onNote(t("settings.kitConnected", { name: kit.name }));
        break;
      }
    }
    setPolling((prev) => {
      const next = new Set(prev);
      next.delete(kit.slug);
      return next;
    });
  };

  return (
    <>
      <div className="conn-search">
        <Search size={15} />
        <input
          className="conn-search-input"
          placeholder={t("settings.searchToolkits")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {categories.length > 0 && (
        <div className="cmp-cats">
          <button
            type="button"
            className={`cmp-cat ${category === "all" ? "active" : ""}`}
            onClick={() => setCategory("all")}
          >
            All
          </button>
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              className={`cmp-cat ${category === c ? "active" : ""}`}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <p className="set-hint">{t("settings.loadingToolkits")}</p>
      ) : (
        <div className="cmp-grid">
          {filtered.slice(0, 120).map((kit) => (
            <ComposioCard
              key={kit.slug}
              kit={kit}
              state={stateOf(kit.slug)}
              onClick={() => setModalKit(kit)}
            />
          ))}
          {filtered.length === 0 && <p className="set-hint">{t("settings.noToolkitFound")}</p>}
        </div>
      )}
      {filtered.length > 120 && (
        <p className="set-hint">{t("settings.showing120", { total: filtered.length })}</p>
      )}

      {modalKit && (
        <ConnectModal
          kit={modalKit}
          state={stateOf(modalKit.slug)}
          onClose={() => setModalKit(null)}
          onConnect={(input) => void connect(modalKit, input)}
        />
      )}
    </>
  );
}

function ComposioCard({
  kit,
  state,
  onClick,
}: {
  kit: ComposioToolkit;
  state: KitState;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  // Load through the gateway, not from Composio's CDN: the renderer may not fetch remote images (CSP),
  // by design. `kit.logo` is only consulted to know whether a logo EXISTS — its URL is never used here.
  const [imgOk, setImgOk] = useState(Boolean(kit.logo));
  return (
    <button type="button" className={`cmp-card ${state}`} onClick={onClick}>
      <span className="cmp-card-logo">
        {imgOk && kit.logo ? (
          <img
            src={composioLogoUrl(kit.slug)}
            alt=""
            loading="lazy"
            onError={() => setImgOk(false)}
          />
        ) : (
          <span className="conn-kit-fallback">{kit.name.slice(0, 1).toUpperCase()}</span>
        )}
      </span>
      <span className="cmp-card-name">{kit.name}</span>
      {state === "connected" && <span className="cmp-status connected">{t("settings.connected")}</span>}
      {state === "connecting" && <span className="cmp-status connecting">{t("settings.inProgress")}</span>}
      {state === "expired" && <span className="cmp-status expired">{t("settings.expiredReconnect")}</span>}
    </button>
  );
}

function ConnectModal({
  kit,
  state,
  onClose,
  onConnect,
}: {
  kit: ComposioToolkit;
  state: KitState;
  onClose: () => void;
  onConnect: (input?: ComposioLinkInput) => void;
}) {
  const { t } = useTranslation();
  const [imgOk, setImgOk] = useState(Boolean(kit.logo));
  const [auth, setAuth] = useState<ComposioToolkitAuth | null>(null);
  const [loading, setLoading] = useState(true);
  const [useManaged, setUseManaged] = useState(true);
  const [values, setValues] = useState<Record<string, string>>({});

  // Fetch the toolkit's REAL auth schemes (Composio declares them per toolkit). The form is
  // built from them — no more guessing "API key" for every non-managed toolkit.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    coreBridge
      .composioToolkitAuth(kit.slug)
      .then((a) => {
        if (!alive) return;
        setAuth(a);
        setUseManaged(a.schemes.some((s) => s.managed)); // prefer managed when available
      })
      .catch(() => alive && setAuth({ slug: kit.slug, no_auth: false, schemes: [] }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [kit.slug]);

  const managedScheme = auth?.schemes.find((s) => s.managed) ?? null;
  const customScheme = auth?.schemes.find((s) => !s.managed) ?? null;
  const noAuth = auth?.no_auth ?? false;
  // No schemes from the endpoint → legacy fallback (managed flag, else a bare API key).
  const legacy = !loading && (auth?.schemes.length ?? 0) === 0;
  const active = noAuth
    ? null
    : useManaged && managedScheme
      ? managedScheme
      : customScheme ?? managedScheme;
  const fields =
    active && !active.managed ? [...active.creation_fields, ...active.initiation_fields] : [];
  const legacyNeedsKey = legacy && !kit.no_auth && !kit.managed_oauth;

  const requiredFilled = fields
    .filter((f) => f.required)
    .every((f) => (values[f.name] ?? "").trim().length > 0);
  const legacyOk = !legacyNeedsKey || (values.api_key ?? "").trim().length > 0;
  const canSubmit = loading ? false : legacy ? legacyOk : noAuth || !active || active.managed || requiredFilled;

  const submit = () => {
    if (!canSubmit) return;
    if (legacy) {
      onConnect(legacyNeedsKey ? { apiKey: (values.api_key ?? "").trim() } : undefined);
      return;
    }
    if (noAuth || !active) {
      onConnect(undefined);
      return;
    }
    if (active.managed) {
      onConnect({ scheme: active.mode, managed: true });
      return;
    }
    const creation: Record<string, string> = {};
    for (const f of active.creation_fields) {
      const v = (values[f.name] ?? "").trim();
      if (v) creation[f.name] = v;
    }
    const initiation: Record<string, string> = {};
    for (const f of active.initiation_fields) {
      const v = (values[f.name] ?? "").trim();
      if (v) initiation[f.name] = v;
    }
    onConnect({ scheme: active.mode, managed: false, credentials: creation, initiation });
  };

  const isOAuthManaged = (active?.managed ?? false) || (legacy && kit.managed_oauth);
  const renderFields = legacy
    ? legacyNeedsKey
      ? [{ name: "api_key", label: "API key", required: true, secret: true }]
      : []
    : fields;

  return (
    <div className="cmp-modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="cmp-modal" onClick={(e) => e.stopPropagation()}>
        <div className="cmp-modal-head">
          <span className="cmp-card-logo sm">
            {imgOk && kit.logo ? (
              <img src={composioLogoUrl(kit.slug)} alt="" onError={() => setImgOk(false)} />
            ) : (
              <span className="conn-kit-fallback">{kit.name.slice(0, 1).toUpperCase()}</span>
            )}
          </span>
          <div className="conn-detail-titletext">
            <h3 className="mdl-detail-title">{t("settings.linkKit", { name: kit.name })}</h3>
            <p className="mdl-detail-sub">
              {state === "connected" ? t("settings.kitAlreadyConnected", { name: kit.name }) : t("settings.linkYourAccount", { name: kit.name })}
            </p>
          </div>
          <button className="mdl-icon-btn" type="button" aria-label={t("common.close")} onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {loading ? (
          <div className="cmp-modal-note">{t("settings.readingRequirements", { name: kit.name })}</div>
        ) : (
          <>
            <div className="cmp-modal-note">
              {isOAuthManaged
                ? "We will open a browser window: authorize access there and the app detects the connection automatically. Agent permissions remain governed by approval gates."
                : renderFields.length > 0
                  ? `${kit.name} requires the credentials below (from the service developer panel). They are encrypted on the device and used only toward Composio.`
                  : "We will open a browser window to authorize access."}
            </div>

            {/* Both managed + custom available → let the user pick. */}
            {managedScheme && customScheme && (
              <div className="cmp-auth-toggle">
                <button
                  type="button"
                  className={useManaged ? "active" : ""}
                  onClick={() => setUseManaged(true)}
                >
                  {t("settings.oauthRecommended")}
                </button>
                <button
                  type="button"
                  className={!useManaged ? "active" : ""}
                  onClick={() => setUseManaged(false)}
                >
                  {t("settings.myCredentials")}
                </button>
              </div>
            )}

            {renderFields.map((f) => (
              <input
                key={f.name}
                className="set-input"
                type={f.secret ? "password" : "text"}
                placeholder={f.label + (f.required ? "" : " (optional)")}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues((p) => ({ ...p, [f.name]: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSubmit) submit();
                }}
              />
            ))}

            {/* Custom OAuth: the user's own OAuth app MUST whitelist Composio's callback,
                otherwise the consent step fails. This is the usual reason a custom-OAuth
                connect "does nothing". */}
            {!legacy && active?.mode === "OAUTH2" && !active.managed && (
              <p className="cmp-modal-callback">
                {t("settings.callbackPrefix", { name: kit.name })}{" "}
                <strong>Redirect URI</strong>{t("settings.callbackSuffix")}
                <code
                  onClick={() =>
                    void navigator.clipboard?.writeText(
                      "https://backend.composio.dev/api/v3.1/toolkits/auth/callback",
                    )
                  }
                  title={t("settings.clickToCopy")}
                >
                  https://backend.composio.dev/api/v3.1/toolkits/auth/callback
                </code>
              </p>
            )}
          </>
        )}

        <button
          className="set-btn primary cmp-modal-btn"
          type="button"
          disabled={!canSubmit}
          onClick={submit}
        >
          {isOAuthManaged || renderFields.length === 0
            ? state === "connected"
              ? t("settings.reconnectKit", { name: kit.name })
              : t("settings.linkKit", { name: kit.name })
            : t("settings.linkKit", { name: kit.name })}
        </button>
      </div>
    </div>
  );
}

/** Tokenize a command-args string like a shell: respects double/single quotes so a
 *  value with spaces stays one argument (e.g. `--header "X-API-Key: abc def"` →
 *  ["--header", "X-API-Key: abc def"]). A naive whitespace split would mangle it,
 *  which silently breaks configs like `npx -y mcp-remote <url> --header "..."`. */
function tokenizeArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

function McpAddDetail({
  onChanged,
  onNote,
  onConnected,
}: {
  onChanged: () => Promise<void>;
  onNote: (note: string | null) => void;
  onConnected: (providerId: string) => void;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"command" | "url">("command");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);

  const ready = !!name.trim() && (mode === "command" ? !!command.trim() : !!url.trim());

  const submit = async () => {
    setBusy(true);
    onNote(null);
    try {
      const result = await coreBridge.mcpConnect(
        mode === "url"
          ? { name: name.trim(), url: url.trim() }
          : {
              name: name.trim(),
              command: command.trim(),
              args: tokenizeArgs(args),
            },
      );
      onNote(
        result.discovery_error
          ? `Connected with warning: ${result.discovery_error}`
          : t("settings.connectedTools", { count: result.tools_cached, source: result.provider_id }),
      );
      setName("");
      setCommand("");
      setArgs("");
      setUrl("");
      await onChanged();
      onConnected(result.provider_id);
    } catch (error) {
      onNote(t("settings.mcpConnectionFailed", { message: (error as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="mdl-detail-head">
        <h3 className="mdl-detail-title">{t("settings.addMcpServer")}</h3>
        <p className="mdl-detail-sub">{t("settings.addMcpServerDesc")}</p>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: "var(--s2)" }}>
        <button
          type="button"
          className={`set-btn${mode === "command" ? " primary" : ""}`}
          onClick={() => setMode("command")}
        >
          Command (local)
        </button>
        <button
          type="button"
          className={`set-btn${mode === "url" ? " primary" : ""}`}
          onClick={() => setMode("url")}
        >
          URL (remote)
        </button>
      </div>

      <div className="mdl-field">
        <label className="mdl-field-label">{t("settings.nameLabel")}</label>
        <input
          className="set-input"
          placeholder={t("settings.mcpNamePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      {mode === "command" ? (
        <>
          <div className="mdl-field">
            <label className="mdl-field-label">{t("settings.commandLabel")}</label>
            <input
              className="set-input"
              placeholder={t("settings.commandPlaceholder")}
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
          </div>
          <div className="mdl-field">
            <label className="mdl-field-label">{t("settings.argumentsLabel")}</label>
            <input
              className="set-input"
              placeholder={t("settings.argumentsPlaceholder")}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
            />
          </div>
        </>
      ) : (
        <div className="mdl-field">
          <label className="mdl-field-label">URL</label>
          <input
            className="set-input"
            placeholder="https://example.com/mcp"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
      )}

      <button
        className="set-btn primary"
        type="button"
        style={{ marginTop: 4, alignSelf: "flex-start" }}
        disabled={busy || !ready}
        onClick={() => void submit()}
      >
        <Plus size={14} />
        <span style={{ marginLeft: 6 }}>{busy ? t("settings.connecting") : t("settings.addMcp")}</span>
      </button>
    </>
  );
}

function McpServerDetail({
  providerId,
  info,
  snap,
  onChanged,
  onNote,
  onDisconnected,
}: {
  providerId: string;
  info: { name: string; tools: number };
  snap: CoreCapabilitySnapshot | null;
  onChanged: () => Promise<void>;
  onNote: (note: string | null) => void;
  onDisconnected: () => void;
}) {
  const { t } = useTranslation();
  const tools = (snap?.tools ?? []).filter((tool) => tool.provider_id === providerId);
  const [busy, setBusy] = useState(false);
  const disconnect = async () => {
    if (!window.confirm(t("settings.disconnectConfirm", { name: info.name }))) return;
    setBusy(true);
    onNote(null);
    try {
      await coreBridge.mcpDisconnect(providerId);
      onNote(t("settings.disconnected", { name: info.name }));
      await onChanged();
      onDisconnected();
    } catch (error) {
      onNote(t("settings.disconnectionFailed", { message: (error as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="mdl-detail-head">
        <div className="conn-detail-title">
          <span className="conn-avatar lg">
            <Server size={18} />
          </span>
          <div className="conn-detail-titletext">
            <h3 className="mdl-detail-title">{info.name}</h3>
            <p className="mdl-detail-sub">
              {providerId} · {t("settings.toolsCount", { count: info.tools })}
            </p>
          </div>
          <span className="set-badge green">{t("settings.connected")}</span>
          <button
            className="set-btn"
            type="button"
            disabled={busy}
            onClick={() => void disconnect()}
            title={t("settings.disconnectMcp")}
            style={{ marginLeft: "auto" }}
          >
            <Trash2 size={14} />
            <span style={{ marginLeft: 6 }}>{busy ? "…" : t("settings.disconnect")}</span>
          </button>
        </div>
      </div>
      <div className="mdl-detail-section-label">Tools</div>
      <div className="conn-tool-list">
        {tools.map((tool) => (
          <div key={`${providerId}:${tool.name}`} className="conn-tool">
            <div className="conn-tool-main">
              <span className="conn-tool-name">{tool.name}</span>
              {tool.description && <span className="conn-tool-desc">{tool.description}</span>}
            </div>
            <span className="mdl-tag">{tool.action}</span>
          </div>
        ))}
        {tools.length === 0 && <p className="set-hint">{t("settings.noToolExposed")}</p>}
      </div>
    </>
  );
}

/** Browse the OFFICIAL MCP registry and connect a server in one click, filling
 *  any required parameters/secrets. Provenance (publisher) + the exact command
 *  are shown, and connect asks confirmation, because MCP servers run host code. */
function McpCatalogDetail({
  connectedIds,
  onChanged,
  onNote,
  onConnected,
}: {
  connectedIds: Set<string>;
  onChanged: () => Promise<void>;
  onNote: (note: string | null) => void;
  onConnected: (providerId: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [servers, setServers] = useState<McpRegistryServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const search = async (q: string) => {
    setLoading(true);
    setError(null);
    try {
      setServers(await coreBridge.mcpRegistry(q));
    } catch (e) {
      setError(t("settings.registryUnreachable", { message: (e as Error).message }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void search("");
  }, []);

  return (
    <>
      <div className="mdl-detail-head">
        <h3 className="mdl-detail-title">MCP catalog</h3>
        <p className="mdl-detail-sub">
          From the official Model Context Protocol registry — always up to date. Servers run
          code on your computer: only connect publishers you trust.
        </p>
      </div>
      <form
        className="mdl-field"
        style={{ flexDirection: "row", gap: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          void search(query);
        }}
      >
        <input
          className="set-input"
          placeholder={t("settings.searchMcpCatalog")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="set-btn" type="submit" disabled={loading}>
          <Search size={14} />
          <span style={{ marginLeft: 6 }}>{loading ? t("settings.searching") : t("common.search")}</span>
        </button>
      </form>
      {error && <p className="set-hint">{error}</p>}
      <div className="conn-tool-list" style={{ marginTop: 8 }}>
        {servers.map((srv) => (
          <McpCatalogCard
            key={srv.id}
            server={srv}
            connected={connectedIds.has(
              `mcp:${srv.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "")}`,
            )}
            expanded={expanded === srv.id}
            onToggle={() => setExpanded((cur) => (cur === srv.id ? null : srv.id))}
            onChanged={onChanged}
            onNote={onNote}
            onConnected={onConnected}
          />
        ))}
        {!loading && servers.length === 0 && !error && (
          <p className="set-hint">{t("settings.noResults")}</p>
        )}
      </div>
    </>
  );
}

/** One registry server card: provenance + command preview + a parameter form
 *  (text / password for secrets) that assembles args+env and connects. */
function McpCatalogCard({
  server,
  connected,
  expanded,
  onToggle,
  onChanged,
  onNote,
  onConnected,
}: {
  server: McpRegistryServer;
  connected: boolean;
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void>;
  onNote: (note: string | null) => void;
  onConnected: (providerId: string) => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>({});
  const [reveal, setReveal] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);

  const missingRequired = server.inputs.some(
    (i) => i.required && !(values[i.key] ?? i.default ?? "").trim(),
  );

  const connect = async () => {
    setBusy(true);
    onNote(null);
    try {
      // Assemble inputs by target: env → env map, header → headers map (remote),
      // arg → appended to base args (stdio).
      const env: Record<string, string> = {};
      const headers: Record<string, string> = {};
      const extraArgs: string[] = [];
      for (const input of server.inputs) {
        const value = (values[input.key] ?? input.default ?? "").trim();
        if (!value) continue;
        if (input.target === "env") env[input.key] = value;
        else if (input.target === "header") headers[input.key] = value;
        else extraArgs.push(value);
      }
      const result =
        server.transport === "http"
          ? await coreBridge.mcpConnect({
              name: server.name,
              url: server.url ?? undefined,
              headers,
            })
          : await coreBridge.mcpConnect({
              name: server.name,
              command: server.command,
              args: [...server.args, ...extraArgs],
              env,
            });
      onNote(
        result.discovery_error
          ? `Connected with warning: ${result.discovery_error}`
          : t("settings.connectedTools", { count: result.tools_cached, source: server.name }),
      );
      await onChanged();
      onConnected(result.provider_id);
    } catch (error) {
      onNote(t("settings.connectionFailed", { message: (error as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="conn-tool" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="conn-tool-main">
          <span className="conn-tool-name">
            {server.name}
            {server.official && (
              <span className="set-badge green" style={{ marginLeft: 8 }} title={t("settings.officialReferenceServer")}>
                <ShieldCheck size={12} /> {t("settings.official")}
              </span>
            )}
            {connected && (
              <span className="set-badge" style={{ marginLeft: 8 }}>
                {t("settings.linked")}
              </span>
            )}
          </span>
          <span className="conn-tool-desc">{server.description}</span>
          <span className="mdl-detail-sub" style={{ fontSize: 11, opacity: 0.7 }}>
            {server.publisher} · {server.runtime}
            {server.version ? ` · v${server.version}` : ""}
          </span>
        </div>
        {server.installable ? (
          <button
            className="set-btn"
            type="button"
            onClick={onToggle}
            title={t("settings.showDetailsConnect")}
          >
            <span>{expanded ? t("settings.hide") : t("settings.details")}</span>
          </button>
        ) : (
          <span className="mdl-tag" title={server.note ?? ""}>
            {t("settings.notSupported")}
          </span>
        )}
      </div>
      {expanded && server.installable && (
        <div className="mdl-field" style={{ gap: 10, marginTop: 4 }}>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45 }}>{server.description}</p>
          {server.homepage && (
            <a
              href={server.homepage}
              target="_blank"
              rel="noreferrer"
              className="set-hint"
              style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12 }}
            >
              {t("settings.projectPage")} <ExternalLink size={12} />
            </a>
          )}
          <div className="set-hint" style={{ fontSize: 12 }}>
            <strong>{t("settings.whatYouNeed")}</strong>{" "}
            {server.inputs.length === 0
              ? t("settings.nothingConnectsImmediately")
              : server.inputs
                  .map(
                    (i) =>
                      `${i.label}${i.secret ? ` ${t("settings.secretParen")}` : ""}${i.required ? "" : ` ${t("settings.optionalParen")}`}`,
                  )
                  .join(", ")}
          </div>
          <div>
            <div className="mdl-detail-section-label">
              {server.transport === "http" ? t("settings.endpointLabel") : t("settings.commandLabel")}
            </div>
            <code style={{ fontSize: 11, opacity: 0.75, wordBreak: "break-all" }}>
              {server.command} {server.args.join(" ")}
            </code>
          </div>
          <p className="set-hint" style={{ fontSize: 11, opacity: 0.65, margin: 0 }}>
            The tools exposed by the server will be visible after connection.
          </p>
          {server.inputs.map((input) => (
            <div key={input.key} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <label className="mdl-field-label">
                {input.label}
                {input.required ? " *" : " (optional)"}
                {input.secret && ` · ${t("settings.secret")}`}
              </label>
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  className="set-input"
                  type={input.secret && !reveal[input.key] ? "password" : "text"}
                  placeholder={input.default ?? input.key}
                  value={values[input.key] ?? ""}
                  onChange={(e) =>
                    setValues((prev) => ({ ...prev, [input.key]: e.target.value }))
                  }
                />
                {input.secret && (
                  <button
                    className="set-btn"
                    type="button"
                    onClick={() => setReveal((prev) => ({ ...prev, [input.key]: !prev[input.key] }))}
                    title={reveal[input.key] ? t("settings.hide") : t("settings.show")}
                  >
                    {reveal[input.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                )}
              </div>
            </div>
          ))}
          <button
            className="set-btn primary"
            type="button"
            style={{ alignSelf: "flex-start" }}
            disabled={busy || missingRequired}
            onClick={() => void connect()}
          >
            <Download size={14} />
            <span style={{ marginLeft: 6 }}>{busy ? t("settings.connecting") : t("settings.connect")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------- skills */

function SkillssPane() {
  const { t } = useTranslation();
  const [resp, setResp] = useState<SkillssResponse | null>(null);
  const [tab, setTab] = useState<"attive" | "catalogo">("attive");
  // Which group is open inside "Skills attive" ("" = the two group cards).
  const [group, setGroup] = useState<"" | "personali" | "homuncoder">("");
  // The skill whose detail modal is open (null = no modal).
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<SkillsDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setResp(await coreBridge.skills());
      } catch (e) {
        setError(t("settings.cannotReadSkills", { message: (e as Error).message }));
      }
    })();
  }, []);

  // Load the detail for whichever skill modal is open.
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const d = await coreBridge.skillDetail(selected);
        if (!cancelled) setDetail(d);
      } catch {
        if (!cancelled) setDetail(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const toggle = async (id: string, enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await coreBridge.setSkillsEnabled(id, enabled);
      setResp(r);
      setDetail((d) => (d && d.id === id ? { ...d, enabled } : d));
    } catch (e) {
      setError(t("settings.updateFailed", { message: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const skills = resp?.skills ?? [];
  // Methodology skills are grouped under "HomunCoder"; everything else is personal.
  const homuncoderSkillss = skills.filter((s) => s.source === "homuncoder");
  const personalSkillss = skills.filter((s) => s.source !== "homuncoder");
  // Enable/disable the WHOLE HomunCoder group at once. Each call returns the full updated
  // skills state; the last one reflects every change.
  const toggleGroup = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      let last = resp;
      for (const s of homuncoderSkillss) {
        if (s.enabled !== enabled) last = await coreBridge.setSkillsEnabled(s.id, enabled);
      }
      if (last) setResp(last);
    } catch (e) {
      setError(t("settings.groupUpdateFailed", { message: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const hcAllOn = homuncoderSkillss.length > 0 && homuncoderSkillss.every((s) => s.enabled);
  const groupSkillss = group === "homuncoder" ? homuncoderSkillss : personalSkillss;
  const renderSkillsCard = (s: (typeof skills)[number]) => (
    <div key={s.id} className="skl-card">
      <button type="button" className="skl-card-body" onClick={() => setSelected(s.id)}>
        <span className="skl-card-name">{s.name}</span>
        <span className="skl-card-meta">{t("settings.origin", { source: s.source })}</span>
      </button>
      <Toggle on={s.enabled} onChange={(v) => void toggle(s.id, v)} />
    </div>
  );

  return (
    <>
      <div className="set-seg skl-seg">
        <button
          type="button"
          className={`set-seg-item ${tab === "attive" ? "active" : ""}`}
          onClick={() => setTab("attive")}
        >
          {t("settings.activeSkills")}
        </button>
        <button
          type="button"
          className={`set-seg-item ${tab === "catalogo" ? "active" : ""}`}
          onClick={() => setTab("catalogo")}
        >
          {t("settings.catalog")}
        </button>
      </div>

      {tab === "attive" &&
        (skills.length === 0 ? (
          <SkillssEmpty dir={resp?.dir} onBrowse={() => setTab("catalogo")} />
        ) : group === "" ? (
          <div className="set-cards-grid cols-2">
            <button type="button" className="skl-group-card" onClick={() => setGroup("personali")}>
              <div className="skl-group-head">
                <span className="skl-group-icon brand">
                  <Sparkles size={17} />
                </span>
                <span className="skl-group-name">{t("settings.personalSkills")}</span>
                <ChevronRight size={16} className="skl-group-chev" />
              </div>
              <div className="skl-group-meta">
                {t("settings.personalSkillsMeta", { count: personalSkillss.length })}
              </div>
            </button>
            {homuncoderSkillss.length > 0 && (
              <button
                type="button"
                className="skl-group-card"
                onClick={() => setGroup("homuncoder")}
              >
                <div className="skl-group-head">
                  <span className="skl-group-icon">
                    <Boxes size={17} />
                  </span>
                  <span className="skl-group-name">HomunCoder</span>
                  <ChevronRight size={16} className="skl-group-chev" />
                </div>
                <div className="skl-group-meta">
                  {t("settings.homuncoderMeta", { count: homuncoderSkillss.length })}
                </div>
              </button>
            )}
          </div>
        ) : (
          <>
            <button type="button" className="skl-back" onClick={() => setGroup("")}>
              <ChevronLeft size={15} />
              {group === "homuncoder" ? "HomunCoder" : "Personal skills"}
            </button>
            {group === "homuncoder" && (
              <div className="skl-group-switch-row">
                <span>{t("settings.enableAllGroup")}</span>
                <Toggle on={hcAllOn} onChange={(v) => void toggleGroup(v)} />
              </div>
            )}
            <div className="set-cards-grid cols-2">{groupSkillss.map(renderSkillsCard)}</div>
          </>
        ))}

      {tab === "catalogo" && (
        <MarketplaceView installedIds={skills.map((s) => s.id)} onInstalled={(r) => setResp(r)} />
      )}

      {selected && (
        <div
          className="set-modal-overlay"
          role="dialog"
          aria-modal="true"
          onClick={() => setSelected(null)}
        >
          <div className="set-modal-scrim" />
          <div className="set-modal wide skl-modal" onClick={(e) => e.stopPropagation()}>
            {detail ? (
              <SkillsDetailView
                detail={detail}
                busy={busy}
                onToggle={toggle}
                onClose={() => setSelected(null)}
              />
            ) : (
              <div className="set-modal-body">
                <p className="set-hint">{t("settings.loadingShort")}</p>
              </div>
            )}
          </div>
        </div>
      )}

      {error && <p className="set-hint">{error}</p>}
    </>
  );
}

function SkillssEmpty({ dir, onBrowse }: { dir?: string; onBrowse: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="skl-empty">
      <span className="conn-avatar lg">
        <Sparkles size={20} />
      </span>
      <h3 className="mdl-detail-title">{t("settings.noSkillInstalled")}</h3>
      <p className="mdl-detail-sub">
        {t("settings.skillFolderHint")}
      </p>
      {dir && <code className="skl-path">{dir}</code>}
      <button className="set-btn primary" type="button" onClick={onBrowse} style={{ alignSelf: "flex-start" }}>
        <Download size={14} />
        <span style={{ marginLeft: 6 }}>{t("settings.browseCatalog")}</span>
      </button>
    </div>
  );
}

function MarketplaceView({
  installedIds,
  onInstalled,
}: {
  installedIds: string[];
  onInstalled: (resp: SkillssResponse, installedId: string) => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<SkillsCatalogResponse | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [previewSlug, setPreviewSlug] = useState<string | null>(null);

  const load = async (q: string, cat: string | null) => {
    setLoading(true);
    setNote(null);
    try {
      setData(await coreBridge.skillCatalog(q || undefined, cat || undefined));
    } catch (e) {
      setNote(t("settings.catalogUnavailable", { message: (e as Error).message }));
    } finally {
      setLoading(false);
    }
  };
  // Initial load + reload on category/query change (debounced for typing).
  useEffect(() => {
    const handle = window.setTimeout(() => void load(query, category), query ? 350 : 0);
    return () => window.clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, category]);

  const installed = new Set(installedIds);
  const skills = data?.skills ?? [];

  const install = async (slug: string, name: string) => {
    setBusy(slug);
    setNote(null);
    try {
      const r = await coreBridge.catalogInstall(slug);
      onInstalled(r, slug);
      setPreviewSlug(null);
      setNote(t("settings.installed", { name }));
    } catch (e) {
      setNote(t("settings.installationFailed", { message: (e as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="mdl-detail-head">
        <div className="conn-detail-title">
          <span className="conn-avatar lg">
            <Download size={18} />
          </span>
          <div className="conn-detail-titletext">
            <h3 className="mdl-detail-title">{t("settings.skillCatalog")}</h3>
            <p className="mdl-detail-sub">
              {data ? `${data.total} skills in the registry.` : "Browse and install from the registry."}{" "}
              {t("settings.skillsAreCode")}
            </p>
          </div>
        </div>
      </div>

      <div className="conn-search">
        <Search size={15} />
        <input
          className="conn-search-input"
          placeholder={t("settings.searchSkills")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {data && data.categories.length > 0 && (
        <div className="cmp-cats">
          <button
            type="button"
            className={`cmp-cat ${!category ? "active" : ""}`}
            onClick={() => setCategory(null)}
          >
            All
          </button>
          {data.categories.map((c) => (
            <button
              key={c.name}
              type="button"
              className={`cmp-cat ${category === c.name ? "active" : ""}`}
              onClick={() => setCategory(c.name)}
            >
              {c.name} · {c.count}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <p className="set-hint">{t("settings.loadingCatalog")}</p>
      ) : (
        <div className="conn-kit-grid">
          {skills.map((skill) => {
            const already = installed.has(skill.slug);
            return (
              <div
                key={skill.slug}
                className="conn-kit market clickable"
                role="button"
                tabIndex={0}
                title={t("settings.detailOf", { name: skill.name })}
                onClick={() => setPreviewSlug(skill.slug)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setPreviewSlug(skill.slug);
                }}
              >
                <span className="conn-kit-logo">
                  <span className="conn-kit-fallback">{skill.name.slice(0, 1).toUpperCase()}</span>
                </span>
                <div className="conn-kit-body">
                  <div className="conn-kit-name">{skill.name}</div>
                  <div className="conn-kit-meta market">{skill.description || skill.slug}</div>
                </div>
                {already ? (
                  <span className="set-badge dot green">{t("settings.installedBadge")}</span>
                ) : (
                  <button
                    className="mdl-icon-btn"
                    type="button"
                    disabled={busy === skill.slug}
                    title={t("settings.install", { name: skill.name })}
                    aria-label={t("settings.install", { name: skill.name })}
                    onClick={(e) => {
                      e.stopPropagation();
                      void install(skill.slug, skill.name);
                    }}
                  >
                    <Download size={15} />
                  </button>
                )}
              </div>
            );
          })}
          {!loading && skills.length === 0 && (
            <p className="set-hint">{t("settings.noSkillForFilter")}</p>
          )}
        </div>
      )}
      {note && <p className="set-hint">{note}</p>}
      {previewSlug && (
        <CatalogPreviewModal
          slug={previewSlug}
          installed={installed.has(previewSlug)}
          installing={busy === previewSlug}
          onClose={() => setPreviewSlug(null)}
          onInstall={(name) => void install(previewSlug, name)}
        />
      )}
    </>
  );
}

/** Preview of a catalog skill BEFORE installing: SKILL.md rendered + file list +
 *  security scan, with an Install action. */
function CatalogPreviewModal({
  slug,
  installed,
  installing,
  onClose,
  onInstall,
}: {
  slug: string;
  installed: boolean;
  installing: boolean;
  onClose: () => void;
  onInstall: (name: string) => void;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<CatalogPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const p = await coreBridge.catalogPreview(slug);
        if (!cancelled) setPreview(p);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [slug]);

  return (
    <div className="cmp-modal-overlay" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="cmp-modal skl-preview" onClick={(e) => e.stopPropagation()}>
        <div className="cmp-modal-head">
          <span className="conn-avatar lg">
            <Sparkles size={18} />
          </span>
          <div className="conn-detail-titletext">
            <h3 className="mdl-detail-title">{preview?.name ?? slug}</h3>
            <p className="mdl-detail-sub">
              {preview ? `${preview.files.length} file` : "Loading preview…"}
            </p>
          </div>
          <button className="mdl-icon-btn" type="button" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {error && <p className="cmp-confirm-err">{t("settings.previewUnavailable", { error })}</p>}

        {preview && (
          <>
            {preview.description && <p className="skl-desc">{preview.description}</p>}
            <SkillsSecuritySection report={preview.security} />
            <div className="skl-md-head">
              <span className="mdl-detail-section-label">SKILL.md</span>
              <div className="skl-md-toggle">
                <button
                  type="button"
                  className={`mdl-icon-btn ${!raw ? "active" : ""}`}
                  onClick={() => setRaw(false)}
                  aria-label={t("settings.preview")}
                >
                  <Eye size={15} />
                </button>
                <button
                  type="button"
                  className={`mdl-icon-btn ${raw ? "active" : ""}`}
                  onClick={() => setRaw(true)}
                  aria-label={t("settings.source")}
                >
                  <Code2 size={15} />
                </button>
              </div>
            </div>
            {raw ? (
              <pre className="skl-raw">{preview.body}</pre>
            ) : (
              <div className="skl-prose">
                <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                  {preview.body}
                </ReactMarkdown>
              </div>
            )}
          </>
        )}

        <button
          className="set-btn primary cmp-modal-btn"
          type="button"
          disabled={installed || installing || !preview}
          onClick={() => preview && onInstall(preview.name)}
        >
          {installed ? "Already installed" : installing ? "Installing…" : "Install"}
        </button>
      </div>
    </div>
  );
}

function SkillsDetailView({
  detail,
  busy,
  onToggle,
  onClose,
}: {
  detail: SkillsDetail;
  busy: boolean;
  onToggle: (id: string, enabled: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [raw, setRaw] = useState(false);
  return (
    <>
      <div className="set-modal-head">
        <span className="skl-modal-icon">
          <Sparkles size={18} />
        </span>
        <div>
          <div className="mt">{detail.name}</div>
          <div className="ms mono">
            {detail.id}
            {detail.version ? ` · v${detail.version}` : ""}
          </div>
        </div>
        <label className="skl-modal-active" title={t("settings.toggleSkill")}>
          <Toggle
            on={detail.enabled}
            onChange={(v) => {
              if (!busy) void onToggle(detail.id, v);
            }}
          />
          <span>{detail.enabled ? t("settings.skillEnabled") : t("settings.skillDisabled")}</span>
        </label>
        <button className="set-modal-close" type="button" aria-label="Close" onClick={onClose}>
          <X size={17} />
        </button>
      </div>

      <div className="set-modal-body">
        <div className="skl-pills">
          <span className="set-tag">{t("settings.origin", { source: detail.source })}</span>
          {detail.license && <span className="set-tag">{t("settings.license", { license: detail.license })}</span>}
          {(detail.allowed_tools ?? []).map((t) => (
            <span key={t} className="set-tag brand">
              {t}
            </span>
          ))}
        </div>

        {detail.description && <p className="skl-desc">{detail.description}</p>}

        {detail.security && <SkillsSecuritySection report={detail.security} />}

        <div className="skl-md-head">
          <span className="set-modal-label">SKILL.md</span>
          <div className="skl-md-toggle">
            <button
              type="button"
              className={`mdl-icon-btn ${!raw ? "active" : ""}`}
              onClick={() => setRaw(false)}
              title={t("settings.preview")}
              aria-label="Preview"
            >
              <Eye size={15} />
            </button>
            <button
              type="button"
              className={`mdl-icon-btn ${raw ? "active" : ""}`}
              onClick={() => setRaw(true)}
              title={t("settings.source")}
              aria-label="Source"
            >
              <Code2 size={15} />
            </button>
          </div>
        </div>
        {raw ? (
          <pre className="skl-raw">{detail.body}</pre>
        ) : (
          <div className="skl-prose">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
              {detail.body}
            </ReactMarkdown>
          </div>
        )}

        {detail.files.length > 0 && (
          <>
            <div className="set-modal-label skl-files-label">File</div>
            <div className="skl-tree">
              <SkillsTree nodes={detail.files} depth={0} />
            </div>
          </>
        )}
      </div>
    </>
  );
}

function SkillsTree({ nodes, depth }: { nodes: SkillsFileNode[]; depth: number }) {
  const { t } = useTranslation();
  return (
    <ul className="skl-tree-list">
      {nodes.map((node) => (
        <li key={node.path}>
          <span className="skl-tree-row" style={{ paddingLeft: 10 + depth * 16 }}>
            {node.is_dir ? <Folder size={14} /> : <FileText size={14} />}
            <span className="skl-tree-name">{node.name}</span>
          </span>
          {node.is_dir && node.children && node.children.length > 0 && (
            <SkillsTree nodes={node.children} depth={depth + 1} />
          )}
        </li>
      ))}
    </ul>
  );
}

function SkillsSecuritySection({ report }: { report: SkillsSecurityReport }) {
  const { t } = useTranslation();
  const level = report.blocked ? "high" : report.risk_score > 0 ? "warn" : "clean";
  const label =
    level === "high" ? "High risk" : level === "warn" ? "Needs review" : "Clean";
  return (
    <div className={`skl-sec ${level}`}>
      <div className="skl-sec-head">
        <ShieldCheck size={15} />
        <strong>{t("settings.security")}</strong>
        <span className="skl-sec-badge">
          {label} · {report.risk_score}/100
        </span>
        <span className="skl-sec-files">{t("settings.filesAnalyzed", { count: report.scanned_files })}</span>
      </div>
      {report.warnings.length === 0 ? (
        <p className="skl-sec-clean">{t("settings.noSuspiciousPattern")}</p>
      ) : (
        <ul className="skl-sec-list">
          {report.warnings.slice(0, 20).map((w, i) => (
            <li key={`${w.file}-${w.line}-${i}`} className={`skl-sec-warn ${w.severity}`}>
              <span className="skl-sec-sev">
                {w.severity === "critical" ? t("settings.severityCritical") : t("settings.severityWarning")}
              </span>
              <span className="skl-sec-desc">{w.description}</span>
              {w.file && (
                <code>
                  {w.file}
                  {w.line ? `:${w.line}` : ""}
                </code>
              )}
            </li>
          ))}
          {report.warnings.length > 20 && (
            <li className="set-hint">{t("settings.moreWarnings", { count: report.warnings.length - 20 })}</li>
          )}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ computer */

function ComputerPane({ computer }: { computer: ContainedComputerLive | null }) {
  const { t } = useTranslation();
  const enabled = Boolean(computer?.enabled);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [closing, setClosing] = useState(false);
  const [closedNote, setClosedNote] = useState<string | null>(null);

  const refresh = async () => {
    try {
      setStatus(await coreBridge.systemStatus());
    } catch {
      /* keep previous */
    }
  };
  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(id);
  }, []);

  const docker = status?.docker;
  const dockerLabel = !docker
    ? t("settings.checking")
    : !docker.installed
      ? "Not installed"
      : !docker.running
        ? t("settings.installedNotRunning")
        : docker.container_up
          ? t("settings.activeContainerUp")
          : "Running · container off";
  const dockerOk = Boolean(docker?.running && docker.container_up);

  const liveUrl = enabled ? computer?.novnc_url : null;

  return (
    <>
      <div className="set-section-label">{t("settings.computer.containedTitle")}</div>
      {/* Status card — title + subtitle left, live-state badge right (design 530). */}
      <div className="set-card set-computer-status">
        <div>
          <div className="set-card-name">{t("settings.status")}</div>
          <div className="set-computer-status-sub">
            {t("settings.realContainedBrowser")}
          </div>
        </div>
        <LocalComputerToggle enabled={enabled} />
      </div>

      <LocalComputerAutostartToggle />

      {/* Live view container — real noVNC iframe, striped placeholder otherwise (design 531). */}
      <div className="set-computer-live">
        {liveUrl ? (
          <>
            <iframe className="set-computer-live-frame" src={liveUrl} title={t("settings.liveViewNovnc")} />
            <a
              className="set-btn set-computer-live-open"
              href={liveUrl}
              target="_blank"
              rel="noreferrer"
            >
              <ExternalLink size={14} />
              <span style={{ marginLeft: 6 }}>{t("settings.openNovnc")}</span>
            </a>
          </>
        ) : (
          <div className="set-computer-live-empty">
            <span className="set-computer-live-empty-label">{t("settings.liveViewNovncLower")}</span>
          </div>
        )}
      </div>

      <div className="set-section-label">{t("settings.system")}</div>
      <div className="set-rows">
        <div className="set-row">
          <div>
            <div className="rk">Docker</div>
            <div className="rv">{dockerLabel}</div>
          </div>
          <span className={`set-badge ${dockerOk ? "green" : "muted"}`}>
            {dockerOk ? "OK" : t("settings.warning")}
          </span>
        </div>
        <div className="set-row">
          <div>
            <div className="rk">{t("settings.memoryAssistant")}</div>
            <div className="rv">{status ? `${status.gateway_memory_mb} MB` : "—"}</div>
          </div>
          {status?.container_memory_mb != null && (
            <div style={{ textAlign: "right" }}>
              <div className="rk">Container</div>
              <div className="rv">{status.container_memory_mb} MB</div>
            </div>
          )}
        </div>
        <div className="set-row">
          <div>
            <div className="rk">{t("settings.activeBrowserSessions")}</div>
            <div className="rv">{status ? status.browser_sessions : "—"}</div>
          </div>
          <button
            className="set-btn"
            type="button"
            disabled={closing}
            onClick={async () => {
              setClosing(true);
              setClosedNote(null);
              try {
                const result = await coreBridge.closeAllBrowsers();
                setClosedNote(
                  t("settings.closedSessionsTabs", { sessions: result.closed_sessions, tabs: result.closed_tabs }),
                );
                await refresh();
              } catch {
                setClosedNote("Close failed.");
              } finally {
                setClosing(false);
              }
            }}
          >
            {closing ? "Closing…" : "Close all browsers"}
          </button>
        </div>
      </div>
      {closedNote && <p className="set-hint">{closedNote}</p>}

      <MacAppsSettings />

    </>
  );
}

function MacAppsSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<HostComputerStatus | null>(null);
  const [apps, setApps] = useState<HostComputerApp[]>([]);
  const [grants, setGrants] = useState<HostComputerGrant[]>([]);
  const [selectedBundle, setSelectedBundle] = useState("");
  const [level, setLevel] = useState<"observe" | "control">("observe");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshHostComputer = async () => {
    const nextStatus = await hostComputerStatus();
    setStatus(nextStatus);
    if (!nextStatus.enabled || !nextStatus.available) {
      setApps([]);
      setGrants([]);
      setSelectedBundle("");
      return;
    }
    const [nextApps, nextGrants] = await Promise.all([hostComputerApps(), hostComputerGrants()]);
    setApps(nextApps.filter((app) => Boolean(app.bundle_id)));
    setGrants(nextGrants);
  };

  useEffect(() => {
    void refreshHostComputer().catch(() => setStatus(null));
    const id = window.setInterval(() => void refreshHostComputer().catch(() => {}), 5000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshHostComputer().catch(() => {});
    };
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, []);

  const changeOptIn = async (next: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await coreBridge.setRuntimeSettings({ mac_apps_beta_enabled: next });
      if (!next) {
        setApps([]);
        setGrants([]);
        setSelectedBundle("");
      }
      await refreshHostComputer();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };

  const selectedApp = apps.find((app) => app.bundle_id === selectedBundle);
  const permissionRow = (
    permission: "accessibility" | "screen_recording",
    value: HostComputerStatus["accessibility"],
  ) => (
    <div className="set-row" key={permission}>
      <div>
        <div className="rk">{t(`settings.computer.${permission}`)}</div>
        <div className="rv">{t(`settings.computer.permission.${value}`)}</div>
      </div>
      {value !== "granted" && (
        <button
          className="set-btn"
          type="button"
          disabled={busy || !status?.available}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await presentHostComputerPermission(permission);
              await refreshHostComputer();
            } catch (cause) {
              setError(String(cause));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("settings.computer.openSystemSettings")}
        </button>
      )}
    </div>
  );

  return (
    <section className="host-computer-settings" aria-labelledby="host-computer-title">
      <div className="set-section-label host-computer-heading" id="host-computer-title">
        <span>{t("settings.computer.macAppsTitle")}</span>
        <span className="set-badge muted">{t("settings.computer.macAppsBeta")}</span>
      </div>
      <p className="set-hint">{t("settings.computer.macAppsDescription")}</p>
      <p className="set-hint host-computer-beta-copy">{t("settings.computer.macAppsLocalScreenshot")}</p>

      {status?.supported === false ? (
        <p className="set-hint host-computer-unsupported">
          {t("settings.computer.macAppsAppleSiliconOnly")}
        </p>
      ) : (
        <div className="host-computer-opt-in" aria-busy={busy}>
          <div>
            <div className="rk">{t("settings.computer.macAppsOptIn")}</div>
            <div className="rv host-computer-beta-copy">{t("settings.computer.macAppsOptInHint")}</div>
          </div>
          <Toggle on={Boolean(status?.enabled)} onChange={(next) => void changeOptIn(next)} />
        </div>
      )}

      {status?.supported && !status.enabled && (
        <p className="set-hint host-computer-disabled">{t("settings.computer.macAppsDisabled")}</p>
      )}

      {status?.supported && status.enabled && (
        <div className="set-rows host-computer-permissions" aria-live="polite">
          <div className="set-row">
            <div>
              <div className="rk">{t("settings.computer.helper")}</div>
              <div className="rv">
                {status.available
                  ? t("settings.computer.helperReady", { version: status.helper_version ?? "—" })
                  : t("settings.computer.helperUnavailable")}
              </div>
            </div>
            <span className={`set-badge ${status.ready ? "green" : "muted"}`}>
              {status.ready ? t("settings.computer.ready") : t("settings.computer.setupRequired")}
            </span>
          </div>
          {permissionRow("accessibility", status.accessibility)}
          {permissionRow("screen_recording", status.screen_recording)}
        </div>
      )}

      {status?.enabled && status.available && (
        <>
          <div className="set-section-label">{t("settings.computer.appGrants")}</div>
          <div className="host-computer-grant-picker">
            <label>
              <span>{t("settings.computer.chooseApp")}</span>
              <select value={selectedBundle} onChange={(event) => setSelectedBundle(event.target.value)}>
                <option value="">{t("settings.computer.selectApp")}</option>
                {apps.map((app) => <option key={`${app.bundle_id}-${app.pid}`} value={app.bundle_id}>{app.display_name} · {app.bundle_id}</option>)}
              </select>
            </label>
            <label>
              <span>{t("settings.computer.accessLevel")}</span>
              <select value={level} onChange={(event) => setLevel(event.target.value as "observe" | "control")}>
                <option value="observe">{t("settings.computer.observe")}</option>
                <option value="control">{t("settings.computer.control")}</option>
              </select>
            </label>
            <button
              className="set-btn primary"
              type="button"
              disabled={busy || !selectedBundle}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await grantHostComputerApp({ bundle_id: selectedBundle, level });
                  await refreshHostComputer();
                } catch (cause) {
                  setError(String(cause));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t("settings.computer.authorize")}
            </button>
          </div>
          {selectedApp?.signing_identity && (
            <p className="set-hint host-computer-identity">
              {selectedApp.bundle_id} · {selectedApp.signing_identity.team_id} · {selectedApp.signing_identity.designated_requirement_sha256.slice(0, 12)}…
            </p>
          )}
          <div className="set-rows">
            {grants.length === 0 ? (
              <div className="set-row"><span className="rv">{t("settings.computer.noGrants")}</span></div>
            ) : grants.map((grant) => (
              <div className="set-row" key={grant.grant_id}>
                <div>
                  <div className="rk">{grant.display_name}</div>
                  <div className="rv">{grant.bundle_id} · {t(`settings.computer.${grant.level}`)}</div>
                </div>
                <button
                  className="set-btn"
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await revokeHostComputerGrant(grant.grant_id);
                      setSelectedBundle("");
                      await refreshHostComputer();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {t("settings.computer.revoke")}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="set-hint host-computer-privacy">{t("settings.computer.privacyNotice")}</p>
      <p className="set-hint host-computer-restrictions">{t("settings.computer.restrictions")}</p>
      {error && <p className="set-error" role="alert">{error}</p>}
    </section>
  );
}

function ArtifactsPane() {
  return (
    <>
      <ArtifactsCard />
      <DestinationsCard />
    </>
  );
}

function DestinationsCard() {
  const { t } = useTranslation();
  const [destinations, setDestinations] = useState<ArtifactDestination[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setDestinations(await coreBridge.artifactDestinations());
    } catch {
      /* keep previous */
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  async function add() {
    setBusy(true);
    try {
      const path = await coreBridge.pickFolder();
      if (path) {
        const label = path.replace(/\/+$/, "").split("/").pop() || path;
        setDestinations(await coreBridge.addArtifactDestination(label, path));
      }
    } catch {
      /* cancelled / unavailable */
    } finally {
      setBusy(false);
    }
  }

  async function remove(path: string) {
    setBusy(true);
    try {
      setDestinations(await coreBridge.removeArtifactDestination(path));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="set-section-label">{t("settings.destinationFolders")}</div>
      <div className="set-card">
        <div className="set-card-top">
          <span className="set-card-name">{t("settings.whereAssistantSaves")}</span>
          <button className="set-btn" type="button" disabled={busy} onClick={() => void add()}>
            <Plus size={14} />
            <span style={{ marginLeft: 6 }}>{t("common.add")}</span>
          </button>
        </div>
        <div className="set-card-divider" />
        <p className="set-meter-sub">
          {t("settings.destinationsDesc")}
        </p>
        {destinations.length ? (
          <div className="set-rows" style={{ marginTop: 8 }}>
            {destinations.map((destination) => (
              <div className="set-row" key={destination.path}>
                <div style={{ minWidth: 0 }}>
                  <div className="rk">{destination.label}</div>
                  <div
                    className="rv"
                    style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {destination.path}
                  </div>
                </div>
                <button
                  className="set-btn"
                  type="button"
                  disabled={busy}
                  aria-label={t("settings.removeNamed", { name: destination.label })}
                  onClick={() => void remove(destination.path)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="set-hint">{t("settings.noAuthorizedFolder")}</p>
        )}
      </div>
    </>
  );
}

function formatArtifactBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type ArtifactSourceFilter = "all" | "managed" | "memory";
type ArtifactLinkFilter = "all" | "linked" | "orphan";
type ArtifactThreadLabel = {
  title: string;
  workspace?: string;
};

function ArtifactFilterSelect({
  label,
  value,
  onChange,
  children,
  wide,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`artifacts-filter ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      <span className="set-select artifacts-filter-select">
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {children}
        </select>
        <ChevronDown className="chev" size={14} />
      </span>
    </label>
  );
}

function artifactFileKey(thread: string, file: ArtifactFileView) {
  return `${thread}\u0000${file.source ?? "managed"}\u0000${file.reference ?? ""}\u0000${file.name}`;
}

function artifactFileType(file: ArtifactFileView) {
  const ext = file.name.split(".").pop()?.trim().toLowerCase();
  return ext && ext !== file.name.toLowerCase() ? ext : "file";
}

function artifactFileSource(file: ArtifactFileView): "managed" | "memory" {
  return file.source === "memory" ? "memory" : "managed";
}

function artifactFileIsOrphan(file: ArtifactFileView) {
  return artifactFileSource(file) === "managed" && !file.reference;
}

function compactArtifactThreadId(thread: string) {
  if (thread.length <= 26) return thread;
  return `${thread.slice(0, 18)}…${thread.slice(-6)}`;
}

function artifactGroupLabel(
  thread: ArtifactThreadView,
  threadLabels: Record<string, ArtifactThreadLabel>,
  workspaceLabels: Record<string, string>,
) {
  const label = threadLabels[thread.thread];
  if (label) return label;
  if (thread.title?.trim()) {
    return {
      title: thread.title.trim(),
      workspace: thread.chat_missing ? "Deleted/unknown chat" : (thread.workspace_name ?? undefined),
    };
  }
  if (thread.thread.startsWith("memory:")) {
    const workspaceId = thread.workspace_id ?? thread.thread.slice("memory:".length);
    const workspace =
      thread.workspace_name ?? workspaceLabels[workspaceId] ?? (workspaceId === "__personal__" ? "Personal" : undefined);
    return {
      title: workspace ? `${workspace} memory artifacts` : "Memory artifacts",
      workspace,
    };
  }
  if (thread.thread === "default") {
    return { title: "Unscoped artifacts" };
  }
  return {
    title: "Unknown or deleted chat",
    workspace: thread.workspace_name ?? undefined,
  };
}

function artifactGroupOptionLabel(
  thread: ArtifactThreadView,
  threadLabels: Record<string, ArtifactThreadLabel>,
  workspaceLabels: Record<string, string>,
) {
  const label = artifactGroupLabel(thread, threadLabels, workspaceLabels);
  if (thread.chat_missing) {
    return label.workspace
      ? `${label.title} · ${label.workspace} · ${compactArtifactThreadId(thread.thread)}`
      : `${label.title} · ${compactArtifactThreadId(thread.thread)}`;
  }
  if (thread.title || threadLabels[thread.thread] || thread.thread.startsWith("memory:")) {
    return label.workspace ? `${label.title} · ${label.workspace}` : label.title;
  }
  return `${label.title} · ${compactArtifactThreadId(thread.thread)}`;
}

function artifactExportRequest(thread: ArtifactThreadView, file: ArtifactFileView): ExportArtifactFileRequest {
  return {
    thread: thread.thread,
    name: file.name,
    source: file.source ?? "managed",
    reference: file.reference ?? undefined,
  };
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ArtifactsCard() {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<ArtifactsUsage | null>(null);
  const [threadLabels, setThreadLabels] = useState<Record<string, ArtifactThreadLabel>>({});
  const [workspaceLabels, setWorkspaceLabels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [groupFilter, setGroupFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState<ArtifactSourceFilter>("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [linkFilter, setLinkFilter] = useState<ArtifactLinkFilter>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const toggleExpanded = (thread: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(thread)) next.delete(thread);
      else next.add(thread);
      return next;
    });

  const refresh = async () => {
    try {
      setUsage(await coreBridge.artifactsUsage());
    } catch {
      /* keep previous */
    }
  };
  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function refreshThreadLabels() {
      try {
        const workspaceSnap = await coreBridge.workspaces();
        if (cancelled) return;
        const workspaces = workspaceSnap.workspaces;
        const nextWorkspaces: Record<string, string> = {};
        const nextThreads: Record<string, ArtifactThreadLabel> = {};
        for (const workspace of workspaces) {
          nextWorkspaces[workspace.id] = workspace.name;
        }
        const threadSnaps = await Promise.all(
          workspaces.map(async (workspace) => {
            try {
              return {
                workspace,
                threads: (await coreBridge.chatThreads(workspace.id)).threads,
              };
            } catch {
              return { workspace, threads: [] as CoreChatThread[] };
            }
          }),
        );
        if (cancelled) return;
        for (const snap of threadSnaps) {
          for (const thread of snap.threads) {
            nextThreads[thread.thread_id] = {
              title: thread.title || compactArtifactThreadId(thread.thread_id),
              workspace: snap.workspace.name,
            };
          }
        }
        setWorkspaceLabels(nextWorkspaces);
        setThreadLabels(nextThreads);
      } catch {
        /* keep technical fallback */
      }
    }
    void refreshThreadLabels();
    return () => {
      cancelled = true;
    };
  }, []);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function deleteArtifactFile(thread: ArtifactThreadView, file: ArtifactFileView) {
    if (file.source === "memory" && file.reference) {
      await coreBridge.deleteMemoryArtifact(file.reference);
      return;
    }
    await coreBridge.deleteArtifactFile(thread.thread, file.name);
  }

  async function deleteArtifactGroup(thread: ArtifactThreadView) {
    const memoryFiles = thread.files.filter((file) => file.source === "memory" && file.reference);
    if (memoryFiles.length === thread.files.length && memoryFiles.length > 0) {
      for (const file of memoryFiles) {
        await coreBridge.deleteMemoryArtifact(file.reference!);
      }
      return;
    }
    await coreBridge.deleteArtifactThread(thread.thread);
  }

  const fileMatchesFilters = (thread: ArtifactThreadView, file: ArtifactFileView) => {
    if (groupFilter !== "all" && thread.thread !== groupFilter) return false;
    const source = artifactFileSource(file);
    if (sourceFilter !== "all" && source !== sourceFilter) return false;
    if (typeFilter !== "all" && artifactFileType(file) !== typeFilter) return false;
    if (linkFilter === "linked" && artifactFileIsOrphan(file)) return false;
    if (linkFilter === "orphan" && !artifactFileIsOrphan(file)) return false;
    return true;
  };

  const visibleThreads = (usage?.threads ?? [])
    .map((thread) => {
      const files = thread.files.filter((file) => fileMatchesFilters(thread, file));
      return {
        ...thread,
        files,
        bytes: files.reduce((sum, file) => sum + file.size, 0),
      };
    })
    .filter((thread) => thread.files.length > 0);
  const visibleFiles = visibleThreads.flatMap((thread) =>
    thread.files.map((file) => ({ thread, file })),
  );
  const selectedVisibleFiles = visibleFiles.filter(({ thread, file }) =>
    selected.has(artifactFileKey(thread.thread, file)),
  );
  const exportableFiles = selectedVisibleFiles.length > 0 ? selectedVisibleFiles : visibleFiles;
  const groupOptions =
    usage?.threads
      .slice()
      .sort((a, b) =>
        artifactGroupOptionLabel(a, threadLabels, workspaceLabels).localeCompare(
          artifactGroupOptionLabel(b, threadLabels, workspaceLabels),
        ),
      ) ?? [];
  const typeOptions = Array.from(
    new Set(
      (usage?.threads ?? []).flatMap((thread) => thread.files.map((file) => artifactFileType(file))),
    ),
  ).sort((a, b) => a.localeCompare(b));
  const selectedLabel =
    selectedVisibleFiles.length > 0
      ? `${selectedVisibleFiles.length} selected`
      : `${visibleFiles.length} visible`;

  function toggleSelected(thread: ArtifactThreadView, file: ArtifactFileView) {
    const key = artifactFileKey(thread.thread, file);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function exportArtifacts() {
    const files = exportableFiles.map(({ thread, file }) => artifactExportRequest(thread, file));
    const blob = await coreBridge.exportArtifacts(files);
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(blob, `homun-artifacts-${stamp}.zip`);
  }

  const hasArtifacts = (usage?.threads.length ?? 0) > 0;

  return (
    <>
      <div className="set-section-label">{t("settings.generatedFiles")}</div>
      <div className="set-card">
        <div className="set-card-top">
          <span className="set-card-name">{t("settings.spaceUsed")}</span>
          <span className="set-badge muted">
            {usage ? formatArtifactBytes(usage.total_bytes) : "—"}
          </span>
        </div>
        <div className="set-card-divider" />
        <p className="set-meter-sub">
          {t("settings.artifactsDesc", {
            location: usage?.base_path ? t("settings.artifactsLocation", { path: usage.base_path }) : "",
          })}
        </p>
        <div className="artifacts-actions">
          <button
            className="set-btn"
            type="button"
            onClick={() => void coreBridge.revealPath(usage?.base_path ?? "")}
            disabled={!usage?.base_path}
          >
            <Folder size={14} />
            <span>{t("chat.openFolder")}</span>
          </button>
          <button
            className="set-btn"
            type="button"
            disabled={busy || exportableFiles.length === 0}
            onClick={() => void run(exportArtifacts)}
          >
            <Download size={14} />
            <span>Export ZIP ({selectedLabel})</span>
          </button>
          <button
            className="set-btn danger"
            type="button"
            disabled={busy || !hasArtifacts}
            onClick={() => void run(() => coreBridge.clearArtifacts())}
          >
            <Trash2 size={14} />
            <span>{t("settings.deleteAll")}</span>
          </button>
        </div>
        {hasArtifacts && (
          <div className="artifacts-filters">
            <ArtifactFilterSelect
              label="Group"
              value={groupFilter}
              wide
              onChange={(value) => {
                setGroupFilter(value);
                setSelected(new Set());
              }}
            >
                <option value="all">All</option>
                {groupOptions.map((thread) => (
                  <option key={thread.thread} value={thread.thread}>
                    {artifactGroupOptionLabel(thread, threadLabels, workspaceLabels)}
                  </option>
                ))}
            </ArtifactFilterSelect>
            <ArtifactFilterSelect
              label="Source"
              value={sourceFilter}
              onChange={(value) => {
                setSourceFilter(value as ArtifactSourceFilter);
                setSelected(new Set());
              }}
            >
                <option value="all">All</option>
                <option value="managed">Managed</option>
                <option value="memory">Memory</option>
            </ArtifactFilterSelect>
            <ArtifactFilterSelect
              label="Type"
              value={typeFilter}
              onChange={(value) => {
                setTypeFilter(value);
                setSelected(new Set());
              }}
            >
                <option value="all">All</option>
                {typeOptions.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
            </ArtifactFilterSelect>
            <ArtifactFilterSelect
              label="Link"
              value={linkFilter}
              onChange={(value) => {
                setLinkFilter(value as ArtifactLinkFilter);
                setSelected(new Set());
              }}
            >
                <option value="all">All</option>
                <option value="linked">Memory-linked</option>
                <option value="orphan">Orphans</option>
            </ArtifactFilterSelect>
          </div>
        )}
        {hasArtifacts ? (
          <div className="set-rows artifacts-groups">
            {visibleThreads.map((thread) => {
              const open = expanded.has(thread.thread);
              const groupLabel = artifactGroupLabel(thread, threadLabels, workspaceLabels);
              const showThreadId =
                Boolean(thread.title || threadLabels[thread.thread] || thread.chat_missing) ||
                groupLabel.title === "Unknown or deleted chat";
              return (
                <div className="artifacts-group" key={thread.thread}>
                  <div className="set-row">
                    <button
                      className="artifacts-group-toggle"
                      type="button"
                      onClick={() => toggleExpanded(thread.thread)}
                      aria-expanded={open}
                    >
                      <ChevronRight
                        className="artifacts-chevron"
                        size={14}
                        data-open={open ? "true" : "false"}
                      />
                      <span className="artifacts-group-copy">
                        <div className="rk">
                          {groupLabel.title}
                        </div>
                        <div className="rv">
                          {groupLabel.workspace ? `${groupLabel.workspace} · ` : ""}
                          {thread.files.length} file · {formatArtifactBytes(thread.bytes)}
                          {showThreadId ? ` · ${compactArtifactThreadId(thread.thread)}` : ""}
                        </div>
                      </span>
                    </button>
                    <button
                      className="set-btn danger"
                      type="button"
                      disabled={busy}
                      onClick={() => void run(() => deleteArtifactGroup(thread))}
                    >
                      {t("settings.deleteAll")}
                    </button>
                  </div>
                  {open && (
                    <div className="artifacts-file-list">
                      {thread.files.map((file) => (
                        <div className="set-row" key={artifactFileKey(thread.thread, file)}>
                          <label className="artifacts-file-check">
                            <input
                              type="checkbox"
                              checked={selected.has(artifactFileKey(thread.thread, file))}
                              onChange={() => toggleSelected(thread, file)}
                              aria-label={`Select ${file.name}`}
                            />
                            <span className="artifacts-file-copy">
                              <div className="rk">
                                {file.title || file.name}
                              </div>
                              <div className="rv">
                                {file.project_relative_path || file.name} · {artifactFileSource(file)} · {artifactFileType(file)} ·{" "}
                                {artifactFileIsOrphan(file) ? "orphan" : "memory-linked"} · {formatArtifactBytes(file.size)}
                              </div>
                            </span>
                          </label>
                          <button
                            className="set-btn"
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              void run(() => deleteArtifactFile(thread, file))
                            }
                          >
                            {t("common.remove")}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {visibleThreads.length === 0 && (
              <p className="set-hint">No files match the current artifact filters.</p>
            )}
          </div>
        ) : (
          <p className="set-hint">{t("settings.noGeneratedFile")}</p>
        )}
      </div>
    </>
  );
}


/* --------------------------------------------------------------- channels */

type WhatsAppStatus = {
  connected: boolean;
  needs_pairing: boolean;
  qr: string | null;
  pair_code: string | null;
  running: boolean;
};

/** Normalize a contact identifier: trim + drop a leading "+". Keeps a full JID
 *  (e.g. "1234@lid") intact so power users can allowlist a precise address. */
function normalizeContact(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith("+") ? trimmed.slice(1).trim() : trimmed;
}

/** Telegram (Bot API) connect/status section. Auth is a @BotFather token —
 *  no phone pairing — persisted server-side so reconnect needs no re-entry.
 *  Renders the "Status" block of the channel modal (label + status card) and
 *  reports its connection state up so the parent grid card + modal header can
 *  show the badge. */
function TelegramSection({
  onStatusChange,
}: {
  onStatusChange?: (status: CoreTelegramStatus | null) => void;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CoreTelegramStatus | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const next = await coreBridge.telegramStatus();
      setStatus(next);
      onStatusChange?.(next);
    } catch {
      /* keep previous */
    }
  };
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 2500);
    return () => clearInterval(id);
  }, []);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await coreBridge.telegramConnect(token.trim() || undefined);
      setToken("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await coreBridge.telegramDisconnect();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="set-modal-label">{t("settings.status")}</div>
      {status?.connected ? (
        <div className="set-card chan-status-card">
          <div className="chan-status-on">
            <span className="chan-status-check" aria-hidden>
              <Check size={11} strokeWidth={2.6} />
            </span>
            {t("settings.connected")}{status.bot_username ? ` — @${status.bot_username}` : ""}
          </div>
          <button
            className="set-btn danger"
            type="button"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            {t("settings.disconnect")}
          </button>
        </div>
      ) : (
        <div className="set-card chan-connect-card">
          <p className="set-hint" style={{ marginTop: 0 }}>
            Create a bot with <strong>@BotFather</strong> and paste the token here. If you already
            entered, press <strong>Connect</strong> (the token stays saved).
          </p>
          <div className="chan-connect-field">
            <input
              type="password"
              placeholder={t("settings.botTokenPlaceholder")}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              className="set-btn primary"
              type="button"
              disabled={busy}
              onClick={() => void connect()}
            >
              {t("settings.connect")}
            </button>
          </div>
          {status?.running && !status.connected && (
            <p className="set-hint">{t("settings.bridgeVerifyingToken")}</p>
          )}
          {status?.error && (
            <p className="set-hint" style={{ color: "var(--danger)" }}>
              {status.error}
            </p>
          )}
          {error && (
            <p className="set-hint" style={{ color: "var(--danger)" }}>
              {error}
            </p>
          )}
        </div>
      )}
    </>
  );
}

function ChannelsPane() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [settings, setSettings] = useState<CoreChannelSettings | null>(null);
  const [newContact, setNewContact] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  // Which channel modal is open (presentational); null = grid only.
  const [openChannel, setOpenChannel] = useState<"whatsapp" | "telegram" | null>(null);
  // Mirrored from TelegramSection so the grid card + modal header show the badge.
  const [telegramConnected, setTelegramConnected] = useState(false);

  const refresh = async () => {
    try {
      setStatus(await coreBridge.whatsappStatus());
    } catch {
      /* leave previous */
    }
    // Poll Telegram here too so the grid card badge stays current even when the
    // Telegram modal is closed. Otherwise the badge only updates while the modal
    // (which mounts the polling TelegramSection) is open → grid shows a stale
    // "not connected" even though Telegram is connected.
    try {
      const tg = await coreBridge.telegramStatus();
      setTelegramConnected(!!tg?.connected);
    } catch {
      /* leave previous */
    }
  };
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), 2500);
    return () => clearInterval(id);
  }, []);
  // Settings are user-edited, not live state: load once, then mutate locally.
  useEffect(() => {
    void coreBridge.channelSettings().then(setSettings);
  }, []);

  // Persist optimistically: the gateway is the source of truth, so we echo its
  // saved copy back into state and roll back on failure.
  const saveSettings = async (next: CoreChannelSettings) => {
    const previous = settings;
    setSettings(next);
    setSavingSettings(true);
    setSettingsError(null);
    try {
      setSettings(await coreBridge.setChannelSettings(next));
    } catch (e) {
      setSettings(previous);
      setSettingsError((e as Error).message);
    } finally {
      setSavingSettings(false);
    }
  };

  const addContact = () => {
    if (!settings) return;
    const contact = normalizeContact(newContact);
    if (!contact || settings.allowlist.includes(contact)) {
      setNewContact("");
      return;
    }
    void saveSettings({ ...settings, allowlist: [...settings.allowlist, contact] });
    setNewContact("");
  };
  const removeContact = (contact: string) => {
    if (!settings) return;
    void saveSettings({
      ...settings,
      allowlist: settings.allowlist.filter((c) => c !== contact),
    });
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await coreBridge.whatsappConnect(phone.trim() || undefined);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    setBusy(true);
    try {
      await coreBridge.whatsappDisconnect();
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const whatsappConnected = !!status?.connected;

  // WhatsApp / Telegram brand marks (inline to match the design's rounded chip).
  const whatsappMark = (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 3 A9 9 0 0 0 4 16 L3 21 L8.2 20 A9 9 0 1 0 12 3 Z M12 5 A7 7 0 1 1 7.4 17.7 L6 18 L6.3 16.6 A7 7 0 0 1 12 5 Z" />
    </svg>
  );
  const telegramMark = (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M21 5 L2.5 12 L8 13.5 L9 19 L12 15.5 L16.5 18.5 Z" />
    </svg>
  );

  // Shared global settings rendered inside whichever channel modal is open:
  // Auto-risposta (the two kill-switch toggles) + Allowlist. Both apply to all
  // channels, matching the design copy ("vale per tutti i canali").
  const sharedSettings = (
    <>
      <div className="set-modal-label">{t("settings.autoReply")}</div>
      <div className="set-card rows chan-settings-rows">
        <div className="set-trow">
          <div>
            <div className="tt">{t("settings.activeChannel")}</div>
            <div className="td">
              {settings?.enabled
                ? t("settings.incomingProcessed")
                : "Master switch: all incoming messages are ignored."}
            </div>
          </div>
          <Toggle
            on={!!settings?.enabled}
            onChange={(on) => {
              if (settings) void saveSettings({ ...settings, enabled: on });
            }}
          />
        </div>
        <div className="set-trow">
          <div>
            <div className="tt">{t("settings.autoReplyTextOnly")}</div>
            <div className="td">
              {t("settings.autoReplyDesc")}
            </div>
          </div>
          <Toggle
            on={!!settings?.auto_reply}
            onChange={(on) => {
              if (settings) void saveSettings({ ...settings, auto_reply: on });
            }}
          />
        </div>
      </div>
      {settings && !settings.enabled && (
        <p className="set-hint">
          {t("settings.channelOffHint")}
        </p>
      )}

      <div className="set-modal-label">Allowlist</div>
      <p className="set-hint" style={{ marginTop: 0 }}>
        {t("settings.allowlistHint")}
      </p>
      {settings && settings.allowlist.length > 0 ? (
        <div className="set-card rows chan-allow-rows">
          {settings.allowlist.map((contact) => (
            <div key={contact} className="set-row chan-allow-row">
              <span className="set-mono-faint chan-allow-id">{contact}</span>
              <button
                className="set-btn danger"
                type="button"
                disabled={savingSettings}
                onClick={() => removeContact(contact)}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="set-hint">{t("settings.noContactInAllowlist")}</p>
      )}
      <div className="chan-allow-add">
        <input
          placeholder={t("settings.numberOrIdPlaceholder")}
          className="chan-allow-input"
          value={newContact}
          onChange={(e) => setNewContact(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addContact();
          }}
        />
        <button
          className="set-btn primary"
          type="button"
          disabled={savingSettings || !newContact.trim()}
          onClick={addContact}
        >
          Add
        </button>
      </div>
      {settingsError && (
        <p className="set-hint" style={{ color: "var(--danger)" }}>
          {settingsError}
        </p>
      )}
      <p className="set-hint">
        {t("settings.untrustedDataHint")}
      </p>
    </>
  );

  return (
    <>
      <div className="set-cards-grid cols-3">
        <button type="button" className="set-channel" onClick={() => setOpenChannel("whatsapp")}>
          <div className="set-channel-top">
            <span className="set-channel-icon whatsapp">{whatsappMark}</span>
            <span className="set-channel-name">WhatsApp</span>
          </div>
          {whatsappConnected ? (
            <span className="set-badge dot green">{t("settings.connected")}</span>
          ) : (
            <span className="set-badge muted">{t("settings.notConnected")}</span>
          )}
        </button>

        <button type="button" className="set-channel" onClick={() => setOpenChannel("telegram")}>
          <div className="set-channel-top">
            <span className="set-channel-icon telegram">{telegramMark}</span>
            <span className="set-channel-name">Telegram</span>
          </div>
          {telegramConnected ? (
            <span className="set-badge dot green">{t("settings.connected")}</span>
          ) : (
            <span className="set-badge muted">{t("settings.notConnected")}</span>
          )}
        </button>

        <div className="set-add-card" aria-hidden>
          <Plus size={14} strokeWidth={1.9} />
          {t("settings.addChannel")}
        </div>
      </div>

      {/* Keep the Telegram hooks mounted whenever its modal is open. */}
      {openChannel === "telegram" && (
        <div className="set-modal-overlay" role="dialog" aria-modal="true">
          <div className="set-modal-scrim" onClick={() => setOpenChannel(null)} />
          <div className="set-modal chan-modal">
            <div className="set-modal-head">
              <span className="set-channel-icon telegram">{telegramMark}</span>
              <span className="mt">Telegram</span>
              {telegramConnected && <span className="set-badge dot green">{t("settings.connected")}</span>}
              <button
                className="set-modal-close"
                type="button"
                aria-label="Close"
                onClick={() => setOpenChannel(null)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="set-modal-body">
              <TelegramSection onStatusChange={(s) => setTelegramConnected(!!s?.connected)} />
              {sharedSettings}
            </div>
          </div>
        </div>
      )}

      {openChannel === "whatsapp" && (
        <div className="set-modal-overlay" role="dialog" aria-modal="true">
          <div className="set-modal-scrim" onClick={() => setOpenChannel(null)} />
          <div className="set-modal chan-modal">
            <div className="set-modal-head">
              <span className="set-channel-icon whatsapp">{whatsappMark}</span>
              <span className="mt">WhatsApp</span>
              {whatsappConnected && <span className="set-badge dot green">{t("settings.connected")}</span>}
              <button
                className="set-modal-close"
                type="button"
                aria-label="Close"
                onClick={() => setOpenChannel(null)}
              >
                <X size={17} />
              </button>
            </div>
            <div className="set-modal-body">
              <div className="set-modal-label">{t("settings.status")}</div>
              {whatsappConnected ? (
                <div className="set-card chan-status-card">
                  <div className="chan-status-on">
                    <span className="chan-status-check" aria-hidden>
                      <Check size={11} strokeWidth={2.6} />
                    </span>
                    {t("settings.connected")}
                  </div>
                  <button
                    className="set-btn danger"
                    type="button"
                    disabled={busy}
                    onClick={() => void disconnect()}
                  >
                    {t("settings.disconnect")}
                  </button>
                </div>
              ) : status?.qr ? (
                <div className="set-card chan-connect-card">
                  <p className="set-hint" style={{ marginTop: 0 }}>
                    Scan with WhatsApp on your phone:{" "}
                    <strong>Settings → Linked devices → Link a device</strong>.
                  </p>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "center",
                      alignSelf: "center",
                      padding: 16,
                      background: "#fff",
                      borderRadius: 10,
                    }}
                  >
                    <QRCodeSVG value={status.qr} size={220} level="M" />
                  </div>
                  <button
                    className="set-btn"
                    type="button"
                    disabled={busy}
                    onClick={() => void disconnect()}
                    style={{ alignSelf: "flex-start" }}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              ) : status?.pair_code ? (
                <div className="set-card chan-connect-card">
                  <p className="set-hint" style={{ marginTop: 0 }}>
                    {t("settings.whatsappPairPrefix")}{" "}
                    <strong>Link with phone number</strong>{t("settings.whatsappPairSuffix")}
                  </p>
                  <div className="chan-pair-code">{status.pair_code}</div>
                  <button
                    className="set-btn"
                    type="button"
                    disabled={busy}
                    onClick={() => void disconnect()}
                    style={{ alignSelf: "flex-start" }}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              ) : (
                <div className="set-card chan-connect-card">
                  <p className="set-hint" style={{ marginTop: 0 }}>
                    {t("settings.whatsappConnectPrefix")} <strong>Connect</strong>{t("settings.whatsappConnectSuffix")}
                  </p>
                  <div className="chan-connect-field">
                    <input
                      placeholder={t("settings.phoneNumberPlaceholder")}
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      style={{ flex: 1 }}
                    />
                    <button
                      className="set-btn primary"
                      type="button"
                      disabled={busy}
                      onClick={() => void connect()}
                    >
                      {t("settings.connect")}
                    </button>
                  </div>
                  {status?.running && (
                    <p className="set-hint">{t("settings.bridgeWaitingConnection")}</p>
                  )}
                  {error && (
                    <p className="set-hint" style={{ color: "var(--danger)" }}>
                      {error}
                    </p>
                  )}
                </div>
              )}
              {sharedSettings}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* --------------------------------------------------------------- memory */

function MemoryPane() {
  const { t } = useTranslation();
  return (
    <>
      <p className="set-hint" style={{ marginTop: 0 }}>
        {t("settings.memoryPaneIntro")}
      </p>
      <p className="set-hint">
        {t("settings.memoryPaneContacts")}
      </p>
      <MemoryItemsList />
    </>
  );
}

/* What the assistant has learned about you (M5): list + confirm/reject/delete.
   Personal scope spans all projects; project scope is the active workspace. */
type MemoryItem = {
  reference: string;
  scope: string;
  memory_type: string;
  status: string;
  sensitivity: string;
  confidence: number;
  text: string;
};

function MemoryItemsList() {
  const { t } = useTranslation();
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ ref: string; text: string } | null>(null);

  const load = async () => {
    try {
      setItems((await coreBridge.memoryItems()).items);
    } catch {
      setItems([]);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const decide = async (
    reference: string,
    action: "confirm" | "reject" | "delete" | "edit",
    text?: string,
  ) => {
    setBusy(true);
    try {
      await coreBridge.decideMemory(reference, action, text);
      setEditing(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (!items) return null;

  const groups = [
    { key: "personal", label: t("settings.scopePersonal") },
    { key: "project", label: t("settings.scopeProject") },
  ];

  return (
    <>
      <div className="set-section-label">{t("settings.whatIRemember")}</div>
      {items.length === 0 ? (
        <p className="set-hint">
          {t("settings.nothingStoredYet")}
        </p>
      ) : (
        groups.map((group) => {
          const rows = items.filter((item) => item.scope === group.key);
          if (rows.length === 0) return null;
          return (
            <div key={group.key}>
              <p className="set-meter-sub">{group.label}</p>
              <div className="set-rows">
                {rows.map((item) => {
                  const isEditing = editing?.ref === item.reference;
                  return (
                    <div className="set-row" key={item.reference}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        {isEditing ? (
                          <input
                            autoFocus
                            value={editing.text}
                            onChange={(e) =>
                              setEditing({ ref: item.reference, text: e.target.value })
                            }
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void decide(item.reference, "edit", editing.text);
                              if (e.key === "Escape") setEditing(null);
                            }}
                            style={{ width: "100%" }}
                          />
                        ) : (
                          <div className="rv">{item.text}</div>
                        )}
                        <div className="rk">
                          {item.memory_type}
                          {item.status === "candidate" ? ` · ${t("settings.toConfirm")}` : ""}
                          {item.sensitivity !== "internal" && item.sensitivity !== "public"
                            ? ` · ${item.sensitivity}`
                            : ""}
                        </div>
                      </div>
                      <div style={{ display: "flex", gap: 6, flex: "none" }}>
                        {isEditing ? (
                          <>
                            <button
                              className="set-btn"
                              type="button"
                              disabled={busy}
                              onClick={() => void decide(item.reference, "edit", editing.text)}
                            >
                              Save
                            </button>
                            <button
                              className="set-btn"
                              type="button"
                              disabled={busy}
                              onClick={() => setEditing(null)}
                            >
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            {item.status === "candidate" && (
                              <>
                                <button
                                  className="set-btn"
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void decide(item.reference, "confirm")}
                                >
                                  Confirm
                                </button>
                                <button
                                  className="set-btn"
                                  type="button"
                                  disabled={busy}
                                  onClick={() => void decide(item.reference, "reject")}
                                >
                                  Reject
                                </button>
                              </>
                            )}
                            <button
                              className="set-btn"
                              type="button"
                              disabled={busy}
                              onClick={() => setEditing({ ref: item.reference, text: item.text })}
                            >
                              Edit
                            </button>
                            <button
                              className="set-btn danger"
                              type="button"
                              disabled={busy}
                              onClick={() => void decide(item.reference, "delete")}
                            >
                              {t("settings.forget")}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })
      )}
    </>
  );
}

// Addons manager (ADR 0011 §6/§10-A): each registry plugin is self-contained
// (panel + engine). Toggling persists the enabled flag in the backend, which
// gates BOTH — detaching makes the nav entry, panel AND engine vanish together.
function AddonsPane({ onChanged }: { onChanged?: () => void }) {
  const { t } = useTranslation();
  const [states, setStates] = useState<PluginState[]>([]);
  const [cache, setCache] = useState<CachedPluginRegistryView | null>(null);
  const [installed, setInstalled] = useState<InstalledPluginPackagesView>({ plugins: [] });
  const [updates, setUpdates] = useState<PluginPackageUpdatesView>({ updates: [] });
  const [trustedKeys, setTrustedKeys] = useState<TrustedPluginPublicKeysView>({
    schema_version: 1,
    beta_enabled: false,
    public_keys: [],
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [loadingRegistry, setLoadingRegistry] = useState(false);
  const [registryUrl, setRegistryUrl] = useState("");
  const [registryError, setRegistryError] = useState<string | null>(null);

  async function loadRegistryState() {
    setLoadingRegistry(true);
    setRegistryError(null);
    try {
      const [cached, installedPackages, updateCandidates, trusted] = await Promise.all([
        coreBridge.pluginRegistryCache(),
        coreBridge.installedPluginPackages(),
        coreBridge.pluginPackageUpdates(),
        coreBridge.trustedPluginPublicKeys(),
      ]);
      setCache(cached);
      setInstalled(installedPackages);
      setUpdates(updateCandidates);
      setTrustedKeys(trusted);
    } catch (error) {
      setRegistryError((error as Error).message);
    } finally {
      setLoadingRegistry(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    void coreBridge.plugins().then((s) => {
      if (!cancelled) setStates(s);
    });
    void loadRegistryState();
    return () => {
      cancelled = true;
    };
  }, []);

  const isEnabled = (id: string) => states.find((s) => s.id === id)?.enabled !== false;
  const installedById = new Map(installed.plugins.map((plugin) => [plugin.plugin_id, plugin]));
  const updateById = new Map(updates.updates.map((update) => [update.plugin_id, update]));
  const trustedKeySet = new Set(trustedKeys.public_keys.map((key) => key.toLowerCase()));

  async function toggle(id: string) {
    setBusy(id);
    const next = await coreBridge.togglePlugin(id);
    if (next) {
      setStates((cur) => {
        const rest = cur.filter((s) => s.id !== id);
        return [...rest, next];
      });
      onChanged?.();
    }
    setBusy(null);
  }

  async function fetchRegistry() {
    const sourceUrl = registryUrl.trim();
    if (!sourceUrl) return;
    setLoadingRegistry(true);
    setRegistryError(null);
    try {
      const cached = await coreBridge.fetchPluginRegistry(sourceUrl);
      setCache(cached);
      setInstalled(await coreBridge.installedPluginPackages());
      setUpdates(await coreBridge.pluginPackageUpdates());
    } catch (error) {
      setRegistryError((error as Error).message);
    } finally {
      setLoadingRegistry(false);
    }
  }

  async function trustSigner(publicKey: string) {
    const nextKeys = Array.from(new Set([...trustedKeys.public_keys, publicKey.toLowerCase()]));
    const next = await coreBridge.setTrustedPluginPublicKeys(nextKeys, trustedKeys.beta_enabled);
    setTrustedKeys(next);
  }

  async function setBetaEnabled(enabled: boolean) {
    const next = await coreBridge.setTrustedPluginPublicKeys(trustedKeys.public_keys, enabled);
    setTrustedKeys(next);
  }

  async function installEntry(entry: NonNullable<CachedPluginRegistryView["registry"]["plugins"]>[number]) {
    setBusy(entry.plugin_id);
    setRegistryError(null);
    try {
      const update = updateById.get(entry.plugin_id);
      const isUpdate = update?.candidate.version === entry.version;
      const installedPackages = isUpdate
        ? await coreBridge.updatePluginPackageFromRegistry({
            registry_entry: entry,
            beta_enabled: trustedKeys.beta_enabled,
          })
        : await coreBridge.installPluginPackageFromRegistry({
            registry_entry: entry,
            beta_enabled: trustedKeys.beta_enabled,
          });
      setInstalled(installedPackages);
      setUpdates(await coreBridge.pluginPackageUpdates());
    } catch (error) {
      setRegistryError((error as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <p className="set-hint">
        {t("settings.addonsIntro")}
      </p>
      <div className="addon-list">
        {pluginRegistry.map((p) => {
          const on = isEnabled(p.id);
          return (
            <div key={p.id} className="addon-row">
              <div className="addon-row-main">
                <div className="addon-row-title">
                  <p.navIcon size={16} aria-hidden="true" />
                  <span>{t(p.name)}</span>
                  <span className={`addon-badge ${on ? "on" : "off"}`}>
                    {on ? t("settings.active2") : t("settings.disabled")}
                  </span>
                </div>
                <p className="addon-row-desc">{t(p.description)}</p>
                <div className="addon-caps">
                  {p.capabilities.map((c) => (
                    <span key={c} className="addon-cap">
                      {c}
                    </span>
                  ))}
                </div>
              </div>
              <div className={busy === p.id ? "addon-row-toggle is-busy" : "addon-row-toggle"}>
                <Toggle on={on} onChange={() => void toggle(p.id)} />
              </div>
            </div>
          );
        })}
      </div>
      <div className="addon-market-head">
        <div>
          <p className="addon-market-eyebrow">{t("settings.addonsMarketplace")}</p>
          <p className="set-hint">{t("settings.addonsMarketplaceIntro")}</p>
        </div>
        <button
          type="button"
          className="set-icon-btn"
          aria-label={t("settings.refresh")}
          disabled={loadingRegistry}
          onClick={() => void loadRegistryState()}
        >
          <RefreshCw size={15} />
        </button>
      </div>
      <div className="addon-fetch-row">
        <input
          value={registryUrl}
          onChange={(event) => setRegistryUrl(event.target.value)}
          placeholder="https://homun.app/plugins/registry.json"
          aria-label={t("settings.addonsRegistryUrl")}
        />
        <button
          type="button"
          className="set-btn"
          disabled={loadingRegistry || registryUrl.trim().length === 0}
          onClick={() => void fetchRegistry()}
        >
          <Download size={15} />
          <span>{t("settings.addonsFetchRegistry")}</span>
        </button>
      </div>
      <div className="addon-beta-row">
        <div>
          <span>{t("settings.addonsBetaOptIn")}</span>
          <small>{t("settings.addonsBetaOptInHint")}</small>
        </div>
        <Toggle on={trustedKeys.beta_enabled} onChange={() => void setBetaEnabled(!trustedKeys.beta_enabled)} />
      </div>
      {registryError && <p className="set-hint set-hint-error">{registryError}</p>}
      {!cache ? (
        <div className="addon-empty">
          <p>{t("settings.addonsNoRegistryCache")}</p>
        </div>
      ) : (
        <>
          <div className="addon-cache-meta">
            <span>{t("settings.addonsRegistryGenerated", { date: cache.registry.generated_at })}</span>
            {cache.source_url && <span>{cache.source_url}</span>}
          </div>
          <div className="addon-list">
            {cache.registry.plugins.map((entry) => {
              const installedPlugin = installedById.get(entry.plugin_id);
              const update = updateById.get(entry.plugin_id);
              const signerTrusted = trustedKeySet.has(entry.signature.public_key.toLowerCase());
              const installing = busy === entry.plugin_id;
              return (
                <div key={`${entry.plugin_id}@${entry.version}`} className="addon-row">
                  <div className="addon-row-main">
                    <div className="addon-row-title">
                      <Boxes size={16} aria-hidden="true" />
                      <span>{entry.plugin_id}</span>
                      <span className="addon-badge">{entry.version}</span>
                      <span className={`addon-badge ${entry.channel === "stable" ? "on" : ""}`}>
                        {entry.channel}
                      </span>
                      {installedPlugin && (
                        <span className="addon-badge on">{t("settings.addonsInstalled")}</span>
                      )}
                      {update?.candidate.version === entry.version && (
                        <span className="addon-badge update">
                          {t("settings.addonsUpdateAvailable")}
                        </span>
                      )}
                    </div>
                    <p className="addon-row-desc">
                      {entry.entitlement}
                      {entry.min_homun_version
                        ? ` · min Homun ${entry.min_homun_version}`
                        : ""}
                    </p>
                    <div className="addon-caps">
                      <span className="addon-cap">{entry.package_sha256.slice(0, 19)}…</span>
                      <span className="addon-cap">{entry.signature.algorithm}</span>
                      <span className="addon-cap">{entry.signature.public_key.slice(0, 16)}…</span>
                    </div>
                    {installedPlugin && (
                      <p className="addon-install-path">{installedPlugin.install_dir}</p>
                    )}
                  </div>
                  <div className="addon-row-actions">
                    {!signerTrusted ? (
                      <button
                        type="button"
                        className="set-btn"
                        disabled={loadingRegistry}
                        onClick={() => void trustSigner(entry.signature.public_key)}
                      >
                        <ShieldCheck size={15} />
                        <span>{t("settings.addonsTrustSigner")}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="set-btn primary"
                        disabled={
                          installing ||
                          (Boolean(installedPlugin) && update?.candidate.version !== entry.version) ||
                          (entry.channel === "beta" && !trustedKeys.beta_enabled)
                        }
                        onClick={() => void installEntry(entry)}
                      >
                        <Download size={15} />
                        <span>
                          {update?.candidate.version === entry.version
                            ? t("settings.addonsUpdatePackage")
                            : t("settings.addonsInstallPackage")}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}
