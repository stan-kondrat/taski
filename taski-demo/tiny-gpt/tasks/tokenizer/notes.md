# Implementation notes

```python
def most_common_pair(ids):
    counts = {}
    for pair in zip(ids, ids[1:]):
        counts[pair] = counts.get(pair, 0) + 1
    return max(counts, key=counts.get)
```

- 4,096 merges take ~40 s on 1 MB of text. Fine for now; a heap would fix it.
- Emoji split across several byte tokens — decode must join bytes before UTF-8.
