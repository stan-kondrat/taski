# Install log

```sh
# pi-1 (server)
curl -sfL https://get.k3s.io | sh -s - server --disable traefik --write-kubeconfig-mode 644

# pi-2, pi-3 (agents)
curl -sfL https://get.k3s.io | K3S_URL=https://pi-1:6443 K3S_TOKEN=$TOKEN sh -
```

- **2026-10-21** — agents joined, `kubectl get nodes` shows three Ready nodes.
- **2026-10-24** — MetalLB hands out 192.168.1.240 to the test nginx service.
