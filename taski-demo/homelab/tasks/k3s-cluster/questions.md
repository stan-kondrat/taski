# Open questions

- Longhorn on NVMe over USB 3 or the PCIe HAT? Benchmark both with `fio`.
- Is one control-plane node enough, or is embedded etcd on all three worth it?
- Where should Flux pull from if the Git server itself runs on the cluster?
