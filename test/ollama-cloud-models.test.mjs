import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, unlink, writeFile } from "node:fs/promises";
import extension, { createCloudModelLoader, register } from "../extensions/ollama-cloud-models.ts";

const cacheFile = join(homedir(), ".pi", "agent", "extensions", ".ollama-cloud-cache.json");

async function withoutCache(callback) {
  let backup;
  try {
    backup = await readFile(cacheFile);
  } catch {}
  await unlink(cacheFile).catch(() => {});
  try {
    return await callback();
  } finally {
    if (backup) await writeFile(cacheFile, backup);
    else await unlink(cacheFile).catch(() => {});
  }
}

const model = {
  id: "glm-5.2:cloud",
  baseId: "glm-5.2",
  reasoning: true,
  input: ["text"],
  contextWindow: 131072,
  capabilities: ["thinking"],
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitFor(predicate) {
  return new Promise((resolve) => {
    const check = () => predicate() ? resolve() : setImmediate(check);
    check();
  });
}

function deps(overrides = {}) {
  return {
    readCache: async () => null,
    writeCache: async () => {},
    fetch: async () => [model],
    register: () => {},
    updateStatus: () => {},
    now: () => 1_000,
    timeout: () => undefined,
    ...overrides,
  };
}

test("factory invocation does not fetch models", () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("factory must not fetch");
  };
  try {
    extension({ registerProvider() {}, on() {}, registerCommand() {} });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
});

test("session_start begins exactly one deferred load and reports success", async () => {
  const pending = deferred();
  let sessionStart;
  let fetchCalls = 0;
  const statuses = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls++;
    return pending.promise;
  };
  const pi = {
    registerProvider() {},
    on(event, handler) {
      assert.equal(event, "session_start");
      sessionStart = handler;
    },
    registerCommand() {},
  };
  await withoutCache(async () => {
    try {
      extension(pi);
      const ctx = { ui: { setStatus: (...args) => statuses.push(args) } };
      sessionStart({}, ctx);
      sessionStart({}, ctx);
      await waitFor(() => fetchCalls === 1);
      assert.equal(fetchCalls, 1);
      assert.deepEqual(statuses, [["ollama-cloud", "Loading Ollama Cloud models…"]]);
      pending.resolve({ ok: true, json: async () => ({ data: [] }) });
      await waitFor(() => statuses.length === 2);
      assert.deepEqual(statuses, [
        ["ollama-cloud", "Loading Ollama Cloud models…"],
        ["ollama-cloud", undefined],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("factory registers refresh and retry commands; retry recovers after failure", async () => {
  let sessionStart;
  const commands = new Map();
  const statuses = [];
  const notifications = [];
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    fetchCalls++;
    if (fetchCalls === 1) throw new Error("offline");
    return { ok: true, json: async () => ({ data: [] }) };
  };
  const pi = {
    registerProvider() {},
    on(_event, handler) {
      sessionStart = handler;
    },
    registerCommand(name, options) {
      commands.set(name, options.handler);
    },
  };
  const ctx = {
    ui: {
      setStatus: (...args) => statuses.push(args),
      notify: (...args) => notifications.push(args),
    },
  };
  await withoutCache(async () => {
    try {
      extension(pi);
      assert.deepEqual([...commands.keys()], ["ollama-cloud-refresh", "ollama-cloud-retry"]);
      sessionStart({}, ctx);
      await waitFor(() => statuses.at(-1)?.[1] === "Ollama Cloud unavailable — /ollama-cloud-retry");
      assert.equal(statuses.at(-1)[1], "Ollama Cloud unavailable — /ollama-cloud-retry");
      await assert.doesNotReject(() => commands.get("ollama-cloud-retry")("", ctx));
      assert.equal(fetchCalls, 2);
      assert.deepEqual(notifications.at(-1), ["Ollama Cloud models loaded", "info"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("start returns before a deferred fetch resolves", async () => {
  const pending = deferred();
  let fetchCalls = 0;
  const loader = createCloudModelLoader(
    deps({
      fetch: () => {
        fetchCalls++;
        return pending.promise;
      },
    }),
  );

  const started = loader.start();
  await Promise.resolve();
  assert.equal(fetchCalls, 1);
  assert.equal(loader.state().status, "loading");
  assert.equal(await Promise.race([started.then(() => "done"), Promise.resolve("pending")]), "pending");

  pending.resolve([model]);
  await started;
  assert.equal(loader.state().status, "ready");
});

test("duplicate starts share one promise and register once", async () => {
  const pending = deferred();
  let fetchCalls = 0;
  let registerCalls = 0;
  const loader = createCloudModelLoader(
    deps({
      fetch: () => {
        fetchCalls++;
        return pending.promise;
      },
      register: () => registerCalls++,
    }),
  );

  const first = loader.start();
  const second = loader.start();
  assert.strictEqual(first, second);
  pending.resolve([model]);
  await first;
  assert.equal(fetchCalls, 1);
  assert.equal(registerCalls, 1);
});

test("successful load clears status", async () => {
  const statuses = [];
  const loader = createCloudModelLoader(
    deps({ updateStatus: (status) => statuses.push(status) }),
  );

  await loader.start();
  assert.equal(loader.state().status, "ready");
  assert.equal(statuses.at(-1), null);
});

test("cache reader rejection transitions to failed and retry remains available", async () => {
  let attempts = 0;
  const loader = createCloudModelLoader(
    deps({
      readCache: async () => {
        attempts++;
        if (attempts === 1) throw new Error("cache unavailable");
        return null;
      },
    }),
  );

  await assert.rejects(loader.start(), /cache unavailable/);
  assert.equal(loader.state().status, "failed");
  await loader.retry();
  assert.equal(loader.state().status, "ready");
});

test("failed load transitions to failed and retry can succeed", async () => {
  let attempts = 0;
  const loader = createCloudModelLoader(
    deps({
      fetch: async () => {
        attempts++;
        if (attempts === 1) throw new Error("offline");
        return [model];
      },
    }),
  );

  await assert.rejects(loader.start(), /offline/);
  assert.equal(loader.state().status, "failed");
  await loader.retry();
  assert.equal(attempts, 2);
  assert.equal(loader.state().status, "ready");
});

test("rejected success status cleanup does not downgrade fresh load", async () => {
  const stale = { fetchedAt: 1, models: [{ ...model, id: "stale:cloud", baseId: "stale" }] };
  const fresh = { ...model, id: "fresh:cloud", baseId: "fresh" };
  let registered;
  const loader = createCloudModelLoader(
    deps({
      readCache: async () => stale,
      fetch: async () => [fresh],
      now: () => 60 * 60 * 1000 + 2,
      register: (models) => {
        registered = models;
      },
      updateStatus: (status) => {
        if (status === null) throw new Error("status unavailable");
      },
    }),
  );

  await loader.start();
  assert.deepEqual(registered, [fresh]);
  assert.equal(loader.state().status, "ready");
});

test("cache write rejection does not fail a successful load", async () => {
  let registered;
  const loader = createCloudModelLoader(
    deps({
      writeCache: () => {
        throw new Error("disk full");
      },
      register: (models) => {
        registered = models;
      },
    }),
  );

  await loader.start();
  assert.deepEqual(registered, [model]);
  assert.equal(loader.state().status, "ready");
});

test("fresh cache registers without fetching", async () => {
  const cached = { fetchedAt: 900, models: [model] };
  let fetchCalls = 0;
  let registered;
  const loader = createCloudModelLoader(
    deps({
      readCache: async () => cached,
      fetch: async () => {
        fetchCalls++;
        return [];
      },
      register: (models) => {
        registered = models;
      },
    }),
  );

  await loader.start();
  assert.equal(fetchCalls, 0);
  assert.deepEqual(registered, [model]);
  assert.equal(loader.state().status, "ready");
});

test("refresh waits for existing work and bypasses fresh cache", async () => {
  const cached = { fetchedAt: 900, models: [model] };
  const fresh = { ...model, id: "fresh:cloud", baseId: "fresh" };
  let fetchCalls = 0;
  let registered;
  const loader = createCloudModelLoader(
    deps({
      readCache: async () => cached,
      fetch: async () => {
        fetchCalls++;
        return [fresh];
      },
      register: (models) => {
        registered = models;
      },
    }),
  );

  await loader.start();
  assert.equal(fetchCalls, 0);
  await loader.refresh();
  assert.equal(fetchCalls, 1);
  assert.deepEqual(registered, [fresh]);
});

test("refresh prevents stale startup completion from overwriting fresh models", async () => {
  const startup = deferred();
  const refresh = deferred();
  const stale = { ...model, id: "stale:cloud", baseId: "stale" };
  const fresh = { ...model, id: "fresh:cloud", baseId: "fresh" };
  const registered = [];
  let fetchCalls = 0;
  const loader = createCloudModelLoader(
    deps({
      fetch: () => {
        fetchCalls++;
        return fetchCalls === 1 ? startup.promise : refresh.promise;
      },
      register: (models) => registered.push(models),
    }),
  );

  const startupLoad = loader.start();
  const refreshLoad = loader.refresh();
  await waitFor(() => fetchCalls === 1);
  assert.equal(fetchCalls, 1);
  startup.resolve([stale]);
  await waitFor(() => fetchCalls === 2);
  assert.equal(fetchCalls, 2);
  refresh.resolve([fresh]);
  await Promise.all([startupLoad, refreshLoad]);
  assert.deepEqual(loader.state(), { status: "ready", models: [fresh] });
  assert.deepEqual(registered, [[stale], [fresh]]);
});

test("retry is a no-op unless the previous load failed", async () => {
  let fetchCalls = 0;
  const statuses = [];
  const loader = createCloudModelLoader(
    deps({
      fetch: async () => {
        fetchCalls++;
        if (fetchCalls === 1) throw new Error("offline");
        return [model];
      },
      updateStatus: (status) => statuses.push(status),
    }),
  );

  await loader.retry();
  assert.equal(fetchCalls, 0);
  await assert.rejects(loader.start(), /offline/);
  assert.equal(loader.state().status, "failed");
  assert.equal(statuses.at(-1).message, "offline");
  await loader.retry();
  assert.equal(fetchCalls, 2);
  assert.deepEqual(loader.state(), { status: "ready", models: [model] });
  assert.equal(statuses.at(-1), null);
});

test("successful fetch writes cache and propagates timeout signal", async () => {
  const signal = new AbortController().signal;
  let timeoutMs;
  let receivedSignal;
  let written;
  const loader = createCloudModelLoader(
    deps({
      timeout: (milliseconds) => {
        timeoutMs = milliseconds;
        return signal;
      },
      fetch: async (received) => {
        receivedSignal = received;
        return [model];
      },
      writeCache: async (cache) => {
        written = cache;
      },
    }),
  );

  await loader.start();
  assert.equal(timeoutMs, 15_000);
  assert.strictEqual(receivedSignal, signal);
  assert.deepEqual(written.models, [model]);
});

test("provider mapping preserves cloud model fields", () => {
  let provider;
  register({ registerProvider: (_name, value) => (provider = value) }, [model]);
  assert.equal(provider.name, "Ollama Cloud");
  assert.equal(provider.baseUrl, "http://127.0.0.1:11434/v1");
  assert.deepEqual(provider.models, [{
    id: model.id,
    name: model.baseId,
    reasoning: true,
    input: ["text"],
    contextWindow: model.contextWindow,
    maxTokens: 32768,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }]);
});

test("empty fetch retains stale models", async () => {
  const stale = { fetchedAt: 1, models: [model] };
  let registered;
  const loader = createCloudModelLoader(
    deps({
      readCache: async () => stale,
      fetch: async () => [],
      now: () => 60 * 60 * 1000 + 2,
      register: (models) => {
        registered = models;
      },
    }),
  );

  await loader.start();
  assert.deepEqual(registered, [model]);
  assert.deepEqual(loader.state(), { status: "ready", models: [model] });
});

test("empty fetch with failed stale registration transitions to failed", async () => {
  const stale = { fetchedAt: 1, models: [model] };
  const loader = createCloudModelLoader(
    deps({
      readCache: async () => stale,
      fetch: async () => [],
      now: () => 60 * 60 * 1000 + 2,
      register: () => {
        throw new Error("registration failed");
      },
    }),
  );

  await assert.rejects(loader.start(), /registration failed/);
  assert.equal(loader.state().status, "failed");
});

test("stale cache is registered after fetch rejection", async () => {
  const stale = { fetchedAt: 1, models: [model] };
  let registered;
  const loader = createCloudModelLoader(
    deps({
      readCache: async () => stale,
      fetch: async () => {
        throw new Error("offline");
      },
      register: (models) => {
        registered = models;
      },
      now: () => 60 * 60 * 1000 + 2,
    }),
  );

  await assert.rejects(loader.start(), /offline/);
  assert.deepEqual(registered, [model]);
  assert.equal(loader.state().status, "failed");
});
