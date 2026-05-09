import { useEffect, useState, type ReactNode } from "react";
import { onUnauthorized, tokenStore } from "../api.js";

export function TokenGate({ children }: { children: ReactNode }) {
  const [hasToken, setHasToken] = useState<boolean>(() => Boolean(tokenStore.get()));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    return onUnauthorized(() => {
      tokenStore.clear();
      setHasToken(false);
      setError("token rejected (401) — please re-enter");
    });
  }, []);

  if (hasToken) return <>{children}</>;

  return (
    <div className="token-gate">
      <div className="token-gate-card">
        <h1>OpenClaw Monitor</h1>
        <p className="token-gate-lead">
          Paste your OpenClaw gateway operator token to access this dashboard. The token is
          stored only in your browser localStorage and added as <code>Authorization: Bearer …</code>{" "}
          to every API call from this page.
        </p>
        <p className="token-gate-help">
          Find the token with: <code>openclaw config get gateway.auth.token</code>
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget as HTMLFormElement;
            const input = form.elements.namedItem("token") as HTMLInputElement | null;
            const value = input?.value.trim() ?? "";
            if (!value) {
              setError("token cannot be empty");
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
            placeholder="paste gateway token here"
            spellCheck={false}
          />
          <button type="submit" className="primary">
            unlock dashboard
          </button>
        </form>
        {error ? <div className="token-gate-error">{error}</div> : null}
      </div>
    </div>
  );
}
