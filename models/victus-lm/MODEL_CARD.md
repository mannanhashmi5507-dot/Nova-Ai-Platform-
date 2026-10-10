# Victus Language Model — Model Card

## Identity

**Name:** Victus Language Model (Victus LM)  
**Version:** 0.1.0  
**Role:** Language/code generation model inside Nova AI's Victus Intelligence Architecture.

## What is in this repository

This repository contains the trainable model stack, not a claim of already-trained frontier weights. The default starting checkpoint is `Qwen/Qwen3-0.6B`, which is an Apache-2.0 licensed causal language model documented by its publisher for Transformers-based use. Victus LM is intended to be a specialized derivative created by supervised fine-tuning and later evaluation.

## Intended uses

- General assistant dialogue
- Software engineering assistance
- Research synthesis when paired with Victus's source-aware research pipeline
- Structured reasoning and verification-oriented responses
- Tool-planning language generation under Victus's control plane

## Safety boundary

The model does not receive authority to:
- change Nova AI source code by itself
- change permissions or safety policies
- approve its own upgrade proposals
- expand its own tool or research allowlists
- rewrite or delete audit records

Those controls remain outside the model in the locked Victus architecture.

## Limitations

A language model can produce incorrect or incomplete output. Victus's verification, provenance, permissions, and human-approval systems should be treated as separate controls rather than assuming model output is inherently trustworthy.

## Training status

The repository includes a small seed dataset for smoke testing and development. A useful production model requires a much larger, licensed/authorized dataset, careful deduplication, held-out evaluations, safety testing, and GPU training.
