import { useEffect, useState, type ReactNode } from "react";
import { onUnauthorized, tokenStore } from "../api.js";
import { useI18n } from "../i18n/index.js";

export function TokenGate({ children }: { children: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  const [hasToken, setHasToken] = useState<boolean>(() => Boolean(tokenStore.get()));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onUnauthorized(() => {
      tokenStore.clear();
      setHasToken(false);
      setError(t("tokenGate.rejectedError"));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (hasToken) return <>{children}</>;

  return (
    <div className="token-gate">
      <div className="token-gate-card">
        <div className="token-gate-lang">
          <button
            className="lang"
            onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
          >
            {t("action.langSwitch")}
          </button>
        </div>
        <h1>{t("tokenGate.title")}</h1>
        <p className="token-gate-lead">{t("tokenGate.lead")}</p>
        <p className="token-gate-help">{t("tokenGate.help")}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget as HTMLFormElement;
            const input = form.elements.namedItem("token") as HTMLInputElement | null;
            const value = input?.value.trim() ?? "";
            if (!value) {
              setError(t("tokenGate.emptyError"));
              return;
            }
            tokenStore.set(value);
            setError(null);
            setHasToken(true);
          }}
        >
          <input
            name="token"
            type="password"
            autoComplete="off"
            autoFocus
            placeholder={t("tokenGate.placeholder")}
            spellCheck={false}
          />
          <button type="submit" className="primary">
            {t("tokenGate.submit")}
          </button>
        </form>
        {error ? <div className="token-gate-error">{error}</div> : null}
      </div>
    </div>
  );
}
