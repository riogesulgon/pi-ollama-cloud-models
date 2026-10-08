# Task 3 Report: Real-extension verification

## Status
**PASS with one environment/type-definition limitation.** The lazy loader unit suite passes, the local extension has no startup fetch/factory work, and the real installed extension was benchmarked before the change. The global installed package was not overwritten.

## Commit
- `e0a1587 fix: type cloud model input modalities`

The commit narrows `CloudModelDef.input` to `("text" | "image")[]`, fixing the model-field type error exposed by the available TypeScript checker. `.codegraph/` is pre-existing tool output and remains untracked.

## Tests and checks

- `node --test test/ollama-cloud-models.test.mjs`
  - **19 passed, 0 failed**
- `node --check extensions/ollama-cloud-models.ts`
  - **passed** (Node 24 TypeScript syntax check)
- `git diff --check`
  - **passed**
- `npm pack --dry-run`
  - **passed**; package contains exactly `extensions/`, `README.md`, `LICENSE`, and `package.json` (4 files; 5.7 kB tarball / 16.0 kB unpacked).
- Available `tsc` check:
  ```text
  /home/rio/.pi/agent/git/github.com/earendil-works/pi/node_modules/.bin/tsc \
    --noEmit --allowImportingTsExtensions --module NodeNext \
    --moduleResolution NodeNext --target ES2022 --skipLibCheck \
    extensions/ollama-cloud-models.ts
  ```
  The new input-type error is fixed. The remaining error is a pre-existing peer API mismatch: this checkout's installed `ProviderConfig` declaration does not accept the existing provider-level `compat` property at `extensions/ollama-cloud-models.ts:184`. This is not introduced by Task 3 and the runtime/Node syntax/tests pass.

## Startup benchmark evidence

### Before (real installed package)
The live installed extension was:
`/home/rio/.pi/agent/npm/node_modules/pi-ollama-cloud-models/extensions/ollama-cloud-models.ts`

The existing persisted startup benchmark recorded:

- total startup: **15,300.10 ms**
- extension module import: **0.565 ms**
- extension factory: **11,566.59 ms**

This confirms the old installed package performed the network work in its factory.

### After (local extension, no global install)
Pi was launched in an isolated temporary agent directory with the startup-benchmark extension and repository extension explicitly loaded:

```sh
PI_STARTUP_BENCHMARK=1 PI_TIMING=1 PI_OFFLINE=1 \
PI_CODING_AGENT_DIR=/tmp/pi-task3-after \
pi --offline --no-session \
  --extension /home/rio/.pi/agent/extensions/startup-benchmark/index.ts \
  --extension /home/rio/.pi/agent/git/github.com/riogesulgon/pi-ollama-cloud-models/extensions/ollama-cloud-models.ts
```

Pi exited successfully. Timing output showed:

- extension module import: **1 ms**
- extension factory: **0 ms**
- all extension startup: **22 ms**
- total startup: **246 ms**

The temporary settings did not persist a benchmark JSON snapshot, so the timing output is the authoritative after measurement. It directly demonstrates that the factory no longer performs the multi-second fetch.

## Command smoke test

A real default-extension harness exercised the registered commands with a mocked network and an induced first-load failure (cache was backed up and restored):

```json
{
  "calls": 3,
  "commands": ["ollama-cloud-refresh", "ollama-cloud-retry"],
  "lastStatus": ["ollama-cloud", null],
  "notifications": [
    ["Ollama Cloud models loaded", "info"],
    ["Ollama Cloud models refreshed", "info"]
  ]
}
```

This verifies startup failure status, `/ollama-cloud-retry` recovery, and `/ollama-cloud-refresh` completion/notification. The unit suite additionally verifies registration and refresh single-flight/race behavior.

## Installation recommendation

**Do not overwrite the live global package automatically.** The live package remains the pre-change package and was not modified. Recommended safe install procedure when explicitly authorized:

```sh
npm pack
live=/home/rio/.pi/agent/npm/node_modules/pi-ollama-cloud-models
backup=/tmp/pi-ollama-cloud-models-live-$(date +%Y%m%d-%H%M%S)
cp -a "$live" "$backup"
npm install -g ./pi-ollama-cloud-models-0.1.0.tgz
```

Rollback:

```sh
rm -rf /home/rio/.pi/agent/npm/node_modules/pi-ollama-cloud-models
cp -a "$backup" /home/rio/.pi/agent/npm/node_modules/pi-ollama-cloud-models
```

Prefer the isolated `pi --extension ...` verification above until explicit authorization is given.

## Remaining concerns

1. The installed global package still has the old multi-second factory and should be upgraded only with the backup/rollback procedure above.
2. Full `tsc` cleanliness cannot be claimed because the available Pi declaration package rejects the existing provider-level `compat` field; this is a dependency/API-version mismatch outside the lazy-loading change.
3. End-to-end command smoke testing used a deterministic mocked network rather than live Ollama endpoints; live model discovery is intentionally bounded by the 15-second loader timeout and depends on network availability.
