---
type: task
status: doing
priority: high
due: 2026-11-09
created: 2026-10-20
tags: kubernetes, raspberry-pi
---

# Run a k3s cluster on the Pis

One server, two agents, Longhorn for storage. Everything declared in a Git repo
and applied with Flux, so the cluster can be rebuilt from scratch.

## Checklist

- [x] Install k3s on pi-1 with `--disable traefik`
- [x] Join pi-2 and pi-3 as agents
- [x] Install MetalLB with a pool of 192.168.1.240–250
- [ ] Install Longhorn and test a volume failover
- [ ] Bootstrap Flux from the `homelab-gitops` repo
- [ ] Move Immich (photos) onto the cluster

## Files

- [Install log](./install-log.md)
- [Open questions](./questions.md)
