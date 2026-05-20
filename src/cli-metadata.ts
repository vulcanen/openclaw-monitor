import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { MONITOR_CLI_OPTIONS } from "./cli/setup-command.js";

/**
 * CLI-metadata entry for openclaw-monitor.
 *
 * Host 2026.5.18 introduced a dedicated "cli-metadata" load pass that
 * resolves what CLI root commands each plugin owns *before* it loads the
 * plugin's main entry. The host probes `<pluginRoot>/cli-metadata.{ts,js,mjs,cjs}`
 * first and falls back to the main entry only when it's missing — see
 * decision #58 in rules/host-contract.md.
 *
 * This file is the metadata-pass entry. It must NOT touch any module-level
 * state that the main entry (src/index.ts) uses for idempotency
 * (`sharedBundle` / `routesAndServiceWired` — see CLAUDE.md decisions #12 / #43).
 * Keeping it as a separate module guarantees the metadata pass doesn't
 * pre-flip those flags and silently skip CLI / HTTP / service registration
 * when the host later runs the full discovery pass.
 *
 * The registrar function passed to `api.registerCli` is invoked lazily,
 * only when Commander dispatches `openclaw monitor *`, so the dynamic
 * import of `setup-command.js` (which pulls in nothing more than the
 * Commander Command type at runtime) costs nothing during gateway startup.
 */
export default definePluginEntry({
  id: "openclaw-monitor",
  name: "OpenClaw Monitor",
  description: "OpenClaw Monitor CLI metadata entry (lazy registrar for `openclaw monitor *`).",
  register(api) {
    api.registerCli(
      async ({ program, logger }) => {
        const { buildMonitorCommands } = await import("./cli/setup-command.js");
        buildMonitorCommands(program, { api, logger });
      },
      {
        commands: [...MONITOR_CLI_OPTIONS.commands],
        descriptors: MONITOR_CLI_OPTIONS.descriptors.map((d) => ({ ...d })),
      },
    );
  },
});
