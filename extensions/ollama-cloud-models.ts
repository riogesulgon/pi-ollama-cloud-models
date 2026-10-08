/**
 * Ollama Cloud model list updater
 *
 * Registers a dedicated `ollama-cloud` provider whose model list is fetched
 * live from https://ollama.com. Cloud models are reached through the local
 * Ollama daemon (http://127.0.0.1:11434/v1) using the `:cloud` / `-cloud`
 * name suffix, so this extension is non-destructive: it does not touch the
 * existing `ollama` provider defined in ~/.pi/agent/models.json.
 *
 * - On startup: uses a cached list (1h TTL); falls back to a fresh fetch.
 * - `/ollama-cloud-refresh`: force-refresh the list from ollama.com and
 *   re-register the provider immediately (no /reload needed).
 *
 * Endpoints (both public, no auth required):
 *   GET  https://ollama.com/v1/models       -> { data: [{ id }] }
 *   POST https://ollama.com/api/show        -> { capabilities, model_info }
 *
 * Cloud naming convention (per Ollama docs):
 *   untagged model  -> append ":cloud"   (e.g. glm-5.2        -> glm-5.2:cloud)
 *   tagged model    -> append "-cloud"   (e.g. gpt-oss:120b  -> gpt-oss:120b-cloud)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const CLOUD_API = "https://ollama.com";
const LOCAL_BASE_URL = "http://127.0.0.1:11434/v1";
const PROVIDER = "ollama-cloud";
const PROVIDER_NAME = "Ollama Cloud";
const CACHE_FILE = join(
  homedir(),
  ".pi",
  "agent",
  "extensions",
  ".ollama-cloud-cache.json",
);
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SHOW_CONCURRENCY = 6;
const STARTUP_TIMEOUT_MS = 15_000;

interface CloudModelDef {
  id: string; // cloud-suffixed id passed to the local Ollama daemon
  baseId: string; // raw id from /v1/models
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  capabilities: string[];
}

interface CacheShape {
  fetchedAt: number;
  models: CloudModelDef[];
}

export type CloudModelLoaderState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; models: CloudModelDef[] }
  | { status: "failed"; error: unknown; models: CloudModelDef[] };

export interface CloudModelLoaderDeps {
  readCache: () => Promise<CacheShape | null>;
  writeCache: (cache: CacheShape) => Promise<void>;
  fetch: (signal?: AbortSignal) => Promise<CloudModelDef[]>;
  register: (models: CloudModelDef[]) => void;
  updateStatus: (status: unknown | null) => void | Promise<void>;
  now: () => number;
  timeout: (milliseconds: number) => AbortSignal | undefined;
}

/** Build the cloud-routed model id the local Ollama daemon expects. */
function cloudId(baseId: string): string {
  return baseId.includes(":") ? `${baseId}-cloud` : `${baseId}:cloud`;
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

/** Fetch capabilities + context length for one cloud model. Returns null if retired/unavailable. */
async function showModel(
  baseId: string,
  signal?: AbortSignal,
): Promise<CloudModelDef | null> {
  const name = cloudId(baseId);
  try {
    const data = await fetchJson(`${CLOUD_API}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
      signal,
    });
    const capabilities: string[] = Array.isArray(data?.capabilities)
      ? data.capabilities
      : [];
    const modelInfo: Record<string, unknown> = data?.model_info ?? {};
    let contextLength = 0;
    for (const [k, v] of Object.entries(modelInfo)) {
      if (k.endsWith(".context_length") && typeof v === "number") {
        contextLength = Math.max(contextLength, v);
      }
    }
    return {
      id: name,
      baseId,
      reasoning: capabilities.includes("thinking"),
      input: capabilities.includes("vision") ? ["text", "image"] : ["text"],
      contextWindow: contextLength || 131072,
      capabilities,
    };
  } catch {
    // Retired models and transient errors: skip silently.
    return null;
  }
}

/** Fetch the full cloud model list with per-model capability enrichment. */
async function fetchCloudModels(signal?: AbortSignal): Promise<CloudModelDef[]> {
  const payload = await fetchJson(`${CLOUD_API}/v1/models`, { signal });
  const baseIds: string[] = (payload?.data ?? [])
    .map((m: any) => m?.id)
    .filter((id: unknown): id is string => typeof id === "string" && id.length > 0);

  const results: (CloudModelDef | null)[] = [];
  const queue = [...baseIds];
  const workers = Array.from({ length: SHOW_CONCURRENCY }, async () => {
    while (queue.length) {
      const baseId = queue.shift()!;
      results.push(await showModel(baseId, signal));
    }
  });
  await Promise.all(workers);
  return results.filter((m): m is CloudModelDef => m !== null);
}

async function readCache(): Promise<CacheShape | null> {
  try {
    const raw = await readFile(CACHE_FILE, "utf8");
    const parsed = JSON.parse(raw) as CacheShape;
    if (
      parsed &&
      typeof parsed.fetchedAt === "number" &&
      Array.isArray(parsed.models)
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeCache(cache: CacheShape): Promise<void> {
  try {
    await mkdir(dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // Cache is best-effort; ignore write failures.
  }
}

/** Register (or replace) the ollama-cloud provider with the given model list. */
export function register(pi: ExtensionAPI, models: CloudModelDef[]): void {
  pi.registerProvider(PROVIDER, {
    name: PROVIDER_NAME,
    baseUrl: LOCAL_BASE_URL,
    api: "openai-completions",
    apiKey: "ollama", // placeholder; local Ollama daemon ignores it
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
    models: models.map((m) => ({
      id: m.id,
      name: m.baseId,
      reasoning: m.reasoning,
      input: m.input,
      contextWindow: m.contextWindow,
      maxTokens: 32768,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    })),
  });
}

export function createCloudModelLoader(deps: CloudModelLoaderDeps): {
  start: () => Promise<void>;
  retry: () => Promise<void>;
  state: () => CloudModelLoaderState;
} {
  let current: CloudModelLoaderState = { status: "idle" };
  let inFlight: Promise<void> | null = null;

  const load = async (): Promise<void> => {
    const updateStatus = (status: unknown | null): Promise<void> | undefined => {
      try {
        const result = deps.updateStatus(status);
        return result && typeof result.then === "function"
          ? result.catch(() => {})
          : undefined;
      } catch {
        return undefined;
      }
    };
    const registerModels = (models: CloudModelDef[]): boolean => {
      try {
        deps.register(models);
        return true;
      } catch {
        return false;
      }
    };
    let cache: CacheShape | null = null;
    try {
      current = { status: "loading" };
      const loadingStatus = updateStatus("loading");
      if (loadingStatus) await loadingStatus;
      cache = await deps.readCache();
      const cacheFresh =
        cache !== null &&
        cache.models.length > 0 &&
        deps.now() - cache.fetchedAt < CACHE_TTL_MS;

      if (cacheFresh) {
        deps.register(cache.models);
        current = { status: "ready", models: cache.models };
        const readyStatus = updateStatus(null);
        if (readyStatus) await readyStatus;
        return;
      }

      const models = await deps.fetch(deps.timeout(STARTUP_TIMEOUT_MS));
      const effectiveModels = models.length > 0 ? models : cache?.models ?? [];
      if (models.length > 0) {
        deps.register(models);
        try {
          await deps.writeCache({ fetchedAt: deps.now(), models });
        } catch {
          // Cache is best-effort; a successful fetch remains ready.
        }
      } else if (effectiveModels.length > 0) {
        registerModels(effectiveModels);
      }
      current = { status: "ready", models: effectiveModels };
      const readyStatus = updateStatus(null);
      if (readyStatus) await readyStatus;
    } catch (error) {
      const staleModels = cache?.models ?? [];
      if (staleModels.length > 0) registerModels(staleModels);
      current = { status: "failed", error, models: staleModels };
      const failedStatus = updateStatus(error);
      if (failedStatus) await failedStatus;
      throw error;
    }
  };

  const start = (): Promise<void> => {
    if (inFlight) return inFlight;
    inFlight = load().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  return { start, retry: start, state: () => current };
}

function createDefaultLoader(pi: ExtensionAPI) {
  return createCloudModelLoader({
    readCache,
    writeCache,
    fetch: fetchCloudModels,
    register: (models) => register(pi, models),
    updateStatus: (status) => {
      if (status !== null) console.error("[ollama-cloud-models] load status:", status);
    },
    now: Date.now,
    timeout: (milliseconds) => AbortSignal.timeout(milliseconds),
  });
}

/** The factory is side-effect free; lifecycle wiring starts the loader later. */
export default function (pi: ExtensionAPI): void {
  createDefaultLoader(pi);
}