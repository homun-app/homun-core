import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  IS_DESKTOP,
  currentGatewayToken,
  setGatewayToken,
  verifyGatewayToken,
} from "../lib/gatewayConfig";

/**
 * Web/self-hosted auth gate. Desktop is authenticated by the Electron shell, so
 * the gate is a no-op there. On the web build the bearer token is NOT baked into
 * the bundle: the user enters it once at this screen; it's validated against a
 * protected endpoint and persisted in localStorage. Front-gate this deployment
 * too (basic auth / private network) — this is the second layer, not the first.
 */
export function LoginGate({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"checking" | "needLogin" | "ok">(
    IS_DESKTOP ? "ok" : "checking",
  );
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (IS_DESKTOP) return;
    let active = true;
    void (async () => {
      const existing = currentGatewayToken();
      const ok = existing ? await verifyGatewayToken(existing) : false;
      if (active) setStatus(ok ? "ok" : "needLogin");
    })();
    return () => {
      active = false;
    };
  }, []);

  if (status === "checking") return null;
  if (status === "ok") return <>{children}</>;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = token.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    const ok = await verifyGatewayToken(value);
    setBusy(false);
    if (ok) {
      setGatewayToken(value);
      setStatus("ok");
    } else {
      setError(t("login.invalid"));
    }
  };

  return (
    <div className="login-gate">
      <form className="login-card" onSubmit={submit}>
        <h1 className="login-title">Homun</h1>
        <p className="login-sub">{t("login.subtitle")}</p>
        <input
          className="login-input"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={t("login.placeholder")}
          autoFocus
          autoComplete="current-password"
        />
        {error && <p className="login-error">{error}</p>}
        <button className="login-btn" type="submit" disabled={busy || !token.trim()}>
          {busy ? t("login.checking") : t("login.unlock")}
        </button>
      </form>
    </div>
  );
}
