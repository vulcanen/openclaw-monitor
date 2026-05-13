import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(HERE, "..", "ui");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

const NOT_FOUND_BODY = `<!doctype html><html><head><meta charset="utf-8"><title>OpenClaw Monitor</title></head><body><h1>OpenClaw Monitor UI not built</h1><p>Run <code>npm run build</code> in the plugin source repo before publishing. The published tarball must include <code>dist/ui/index.html</code>.</p></body></html>`;

function safeJoin(root: string, relative: string): string | undefined {
  const resolved = path.resolve(root, "." + (relative.startsWith("/") ? relative : `/${relative}`));
  // Plain `startsWith(root)` would accept a sibling directory like
  // `${root}-evil` whose absolute path shares the same prefix string —
  // standard path-traversal hardening requires the next character to be
  // the platform separator (or equality for the root itself).
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return undefined;
  return resolved;
}

function contentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

function fallbackIndexPath(): string | undefined {
  const candidate = path.join(UI_ROOT, "index.html");
  return fs.existsSync(candidate) ? candidate : undefined;
}

export function createStaticUiHandler(opts: { basePath: string }): OpenClawPluginHttpRouteHandler {
  const base = opts.basePath.replace(/\/$/, "");
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const queryStart = url.indexOf("?");
    const pathname = queryStart === -1 ? url : url.slice(0, queryStart);
    if (!pathname.startsWith(base)) return false;
    let relative = pathname.slice(base.length) || "/";
    if (relative === "/" || relative === "") relative = "/index.html";

    const resolved = safeJoin(UI_ROOT, relative);
    if (!resolved) {
      res.statusCode = 400;
      res.end("bad path");
      return true;
    }

    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      res.statusCode = 200;
      res.setHeader("Content-Type", contentType(resolved));
      res.setHeader(
        "Cache-Control",
        relative === "/index.html" ? "no-cache" : "public, max-age=3600",
      );
      fs.createReadStream(resolved).pipe(res);
      return true;
    }

    const fallback = fallbackIndexPath();
    if (fallback) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      fs.createReadStream(fallback).pipe(res);
      return true;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(NOT_FOUND_BODY);
    return true;
  };
}
