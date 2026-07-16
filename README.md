# pi-ollama-cloud-models

A [pi](https://pi.dev) extension that keeps your Ollama Cloud model list up to
date automatically. It fetches the models available on
[ollama.com](https://ollama.com) and registers them under a dedicated
`ollama-cloud` provider, so they show up in `/model` without manually editing
`~/.pi/agent/models.json`.

Cloud models are reached through your **local Ollama daemon**
(`http://127.0.0.1:11434/v1`) using the `:cloud` / `-cloud` name suffix, so this
extension is non-destructive: it does not touch any existing `ollama` provider
you have configured.

## Install

```bash
pi install npm:pi-ollama-cloud-models
```

Or try it without installing:

```bash
pi -e npm:pi-ollama-cloud-models
```

## What it does

- On startup, registers an `ollama-cloud` provider populated from
  `https://ollama.com/v1/models`, enriched with per-model capabilities and
  context length from `https://ollama.com/api/show`.
- Caches the list for 1 hour at
  `~/.pi/agent/extensions/.ollama-cloud-cache.json`; falls back to a stale cache
  if the network is down.
- Adds a `/ollama-cloud-refresh` command to force-refresh the list and
  re-register the provider immediately (no `/reload` needed).

## Requirements

- A running local [Ollama](https://ollama.com) daemon (`ollama serve`) at
  `http://127.0.0.1:11434`.
- An Ollama account signed in (`ollama sign in`) so cloud models can be
  offloaded from your machine.

## Model metadata

| Field          | Source                                                    |
|----------------|-----------------------------------------------------------|
| `id`           | `<base>:cloud` (untagged) or `<base>-cloud` (tagged)      |
| `reasoning`    | `true` when `/api/show` reports the `thinking` capability |
| `input`        | `["text", "image"]` when `vision` is reported             |
| `contextWindow`| `<arch>.context_length` from `model_info`                |

## License

MIT