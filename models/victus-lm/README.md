# Victus Language Model

This directory defines the first trainable **Victus Language Model (Victus LM)** for Nova AI.

## What this is

Victus LM is the model layer underneath the existing Victus Intelligence Architecture. The architecture remains responsible for memory, planning, tool permissions, research, verification, self-monitoring, and safety locks. The model is responsible for language/code generation.

The included stack uses `Qwen/Qwen3-0.6B` as a configurable starting checkpoint and fine-tunes it into a Victus-specialized model. The repository does **not** contain trained weights; training a useful model requires a machine with an appropriate GPU.

Qwen3-0.6B is an openly available causal language model and its model card documents direct Transformers usage. Hugging Face's current TRL docs also demonstrate SFT on Qwen3-0.6B.

## Install

```bash
cd models/victus-lm
python -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -e .
```

## Validate data

```bash
python scripts/validate_dataset.py data/seed.jsonl
```

## Train a first adapter

```bash
victus-train --train data/seed.jsonl --output ./outputs/victus-lm
```

For a serious model, replace the seed dataset with a much larger curated dataset covering coding, reasoning, research, tool use, safety, and verification.

## Serve locally

```bash
victus-serve --model ./outputs/victus-lm --host 127.0.0.1 --port 8100
# If using the default LoRA adapter output, --base-model is read from victus-config.json automatically.
```

The server exposes:

`POST http://127.0.0.1:8100/v1/chat/completions`

## Connect Nova AI

Set these server-side environment variables:

```env
VICTUS_MODEL_URL=http://127.0.0.1:8100
VICTUS_MODEL_NAME=victus-lm
VICTUS_MODEL_KEY=
```

Then Nova AI can route requests to Victus LM as a model provider.

## Safety boundary

Victus LM cannot change its own software, permissions, training data, or safety rules. The model server exposes text generation only. High-impact actions remain outside the model behind the locked Victus control plane.

See `MODEL_CARD.md` for the training status and safety boundary.
