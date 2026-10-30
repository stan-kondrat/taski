---
type: task
status: doing
priority: high
due: 2026-11-07
created: 2026-10-12
tags: python, nlp
---

# Write a byte-pair encoding tokenizer

Start from raw UTF-8 bytes, merge the most frequent pair until the vocabulary
has 4,096 tokens. No libraries, so I understand every step.

- [x] Count byte pairs over the training text
- [x] Merge loop and saved merge table
- [ ] `encode` / `decode` round-trip test on random Unicode
- [ ] Compare token counts with a production tokenizer

## Files

- [Implementation notes](./notes.md)
