import test from "node:test";
import assert from "node:assert/strict";
import extension, { createCloudModelLoader, register } from "../extensions/ollama-cloud-models.ts";

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
    extension({ registerProvider() {} });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
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

test("cache write rejection does not fail a successful load", async () => {
  let registered;
  const loader = createCloudModelLoader(
    deps({
      writeCache: async () => {
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
