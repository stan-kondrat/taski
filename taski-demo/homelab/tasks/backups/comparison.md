# Backup tools

| Tool    | Dedup | Encryption | Cloud targets       | Notes                     |
|---------|:-----:|:----------:|---------------------|---------------------------|
| restic  |  ✓    |     ✓      | S3, B2, SFTP, many  | single binary, simple     |
| borg    |  ✓    |     ✓      | SSH only            | fastest, needs borg remote |
| rclone  |  –    |  optional  | everything          | sync, not snapshots       |

Leaning towards **restic**: one tool for both local and B2.
