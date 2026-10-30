---
type: task
status: todo
priority: high
due: 2026-11-21
created: 2026-10-12
tags: pytorch, training
---

# Train on Tiny Shakespeare

6 layers, 6 heads, 384-dim embeddings, context of 256 tokens. Target: validation
loss under 1.5 and samples that look like a play.

- [ ] Data loader with random 256-token windows
- [ ] Model: embeddings, causal self-attention, MLP, layer norm
- [ ] Training loop with AdamW and a cosine learning-rate schedule
- [ ] Log loss every 100 steps, sample text every 1,000
- [ ] Mixed precision so it fits in 12 GB

## Files

- [Training runs](./runs.md)
