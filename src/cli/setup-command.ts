import type { Command } from "commander";
import type { OpenClawPluginApi, PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "openclaw-monitor";

export type SetupOptions = {
  audit?: boolean;
};

export type MonitorCliContext = {
  api: OpenClawPluginApi;
  logger: PluginLogger;
};

export const MONITOR_CLI_OPTIONS = {
  commands: ["monitor"],
  descriptors: [
    {
      name: "monitor",
      description: "OpenClaw Monitor plugin commands",
      hasSubcommands: true,
    },
  ],
} as const;

/**
 * Build the `openclaw monitor *` command tree on a Commander program.
 *
 * Shared by both the main plugin entry (`src/index.ts`) and the CLI-metadata
 * entry (`cli-metadata.js`). The CLI-metadata entry is what host 5.18 loads
 * in its dedicated metadata pass — see decision #58 in
 * rules/host-contract.md for the load-path split.
 */
export function buildMonitorCommands(program: Command, ctx: MonitorCliContext): void {
  const { api, logger } = ctx;
  const root = program.command("monitor").description("OpenClaw Monitor plugin commands");

  root
    .command("setup")
    .description("Trust openclaw-monitor and (optionally) enable conversation audit")
    .option(
      "--audit",
      "Also enable M5 content audit (writes allowConversationAccess + audit.enabled)",
    )
    .action(async (opts: SetupOptions) => {
      await runSetup({ api, logger, audit: Boolean(opts.audit) });
    });

  root
    .command("status")
    .description("Show effective config flags for openclaw-monitor")
    .action(() => {
      showStatus({ api, logger });
    });
}

export function registerSetupCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program, logger }) => {
      buildMonitorCommands(program, { api, logger });
    },
    {
      commands: [...MONITOR_CLI_OPTIONS.commands],
      descriptors: MONITOR_CLI_OPTIONS.descriptors.map((d) => ({ ...d })),
    },
  );
}

type SetupParams = {
  api: OpenClawPluginApi;
  logger: PluginLogger;
  audit: boolean;
};

async function runSetup(params: SetupParams): Promise<void> {
  const { api, logger, audit } = params;

  const before = api.runtime.config.current();
  const beforeAllow = (before.plugins as { allow?: string[] } | undefined)?.allow ?? [];
  const beforeEntry = readMonitorEntry(before);

  const willAddAllow = !beforeAllow.includes(PLUGIN_ID);
  const willSetConv = audit && beforeEntry.hooks?.allowConversationAccess !== true;
  const willEnableAudit = audit && beforeEntry.config?.audit?.enabled !== true;

  if (!willAddAllow && !willSetConv && !willEnableAudit) {
    logger.info?.(
      `[${PLUGIN_ID}] setup: nothing to do (allow=${beforeAllow.includes(PLUGIN_ID)}, audit.enabled=${beforeEntry.config?.audit?.enabled === true}, allowConversationAccess=${beforeEntry.hooks?.allowConversationAccess === true})`,
    );
    return;
  }

  await api.runtime.config.mutateConfigFile({
    afterWrite: {
      mode: "restart",
      reason: `${PLUGIN_ID} setup applied: ${[
        willAddAllow && "plugins.allow",
        willSetConv && "hooks.allowConversationAccess",
        willEnableAudit && "config.audit.enabled",
      ]
        .filter(Boolean)
        .join(" + ")}`,
    },
    mutate: (draft) => {
      const plugins = ensureRecord(draft, "plugins") as Record<string, unknown>;
      const allow = ensureArray(plugins, "allow");
      if (!allow.includes(PLUGIN_ID)) {
        allow.push(PLUGIN_ID);
      }
      const entries = ensureRecord(plugins, "entries") as Record<string, unknown>;
      const entry = ensureRecord(entries, PLUGIN_ID) as Record<string, unknown>;
      if (audit) {
        // host-level hook gate
        const hooks = ensureRecord(entry, "hooks") as Record<string, unknown>;
        hooks["allowConversationAccess"] = true;
        // plugin's own configSchema-driven data nests under .config
        const pluginCfg = ensureRecord(entry, "config") as Record<string, unknown>;
        const auditCfg = ensureRecord(pluginCfg, "audit") as Record<string, unknown>;
        auditCfg["enabled"] = true;
      }
    },
  });

  logger.info?.(
    `[${PLUGIN_ID}] setup wrote: ${[
      willAddAllow && "plugins.allow += openclaw-monitor",
      willSetConv && "plugins.entries.openclaw-monitor.hooks.allowConversationAccess = true",
      willEnableAudit && "plugins.entries.openclaw-monitor.config.audit.enabled = true",
    ]
      .filter(Boolean)
      .join(", ")}. Run \`openclaw gateway restart\` to apply.`,
  );
}

type MonitorEntry = {
  hooks?: { allowConversationAccess?: boolean };
  config?: { audit?: { enabled?: boolean } };
};

function readMonitorEntry(
  config: ReturnType<OpenClawPluginApi["runtime"]["config"]["current"]>,
): MonitorEntry {
  const entries = (config.plugins as { entries?: Record<string, unknown> } | undefined)?.entries;
  if (!entries || typeof entries !== "object") return {};
  const entry = entries[PLUGIN_ID];
  if (!entry || typeof entry !== "object") return {};
  return entry;
}

function showStatus(params: { api: OpenClawPluginApi; logger: PluginLogger }): void {
  const config = params.api.runtime.config.current();
  const allow = (config.plugins as { allow?: string[] } | undefined)?.allow ?? [];
  const entry = readMonitorEntry(config);
  const lines = [
    `plugin id: ${PLUGIN_ID}`,
    `plugins.allow includes: ${allow.includes(PLUGIN_ID)}`,
    `config.audit.enabled: ${entry.config?.audit?.enabled === true}`,
    `hooks.allowConversationAccess: ${entry.hooks?.allowConversationAccess === true}`,
  ];
  for (const line of lines) {
    params.logger.info?.(line);
  }
}

function ensureRecord(host: Record<string, unknown>, key: string): unknown {
  const existing = host[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing;
  }
  const fresh = {};
  host[key] = fresh;
  return fresh;
}

function ensureArray(host: Record<string, unknown>, key: string): string[] {
  const existing = host[key];
  if (Array.isArray(existing)) {
    return existing as string[];
  }
  const fresh: string[] = [];
  host[key] = fresh;
  return fresh;
}

// Suppress unused-import warning for Command (kept for type clarity)
export type _CommandUnused = Command;
