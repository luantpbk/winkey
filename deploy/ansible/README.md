# deploy/ansible — node bootstrap + k3s (task I1)

Brings an edge node to: persistent hostname, Tailscale (`tag:edge`), firewalld, a data LV for
local-path volumes, and a k3s server over the tailnet. On edge-1 it also fronts Winkey with the
host nginx that already serves other sites (see [Shared nginx on edge-1](#shared-nginx-on-edge-1)).

## Run

Ansible has no Windows control node, so run it **on the node itself** (or from any Linux admin box
on the tailnet without `-c local`):

```bash
# once, on the node (Oracle Linux 9: ansible-core from appstream, collections from EPEL)
sudo dnf -y install ansible-core ansible-collection-ansible-posix ansible-collection-community-general
# copy this directory to ~/winkey-deploy/ansible, then:
cd ~/winkey-deploy/ansible
ansible-playbook site.yml -l edge-1 -c local --check --diff   # always look first
ansible-playbook site.yml -l edge-1 -c local
```

Override booleans with JSON (`-e '{"k3s_enable_traefik": false}'`), never `-e key=false`:
that passes the string `"false"`. The roles filter with `| bool` anyway.

## Roles

| Role | Does |
|---|---|
| `base` | hostname = inventory name, and stops OCI resetting it (`/etc/oci-hostname.conf` `PRESERVE_HOSTINFO=1`, cloud-init `preserve_hostname`); sysctls; NetworkManager ignores CNI interfaces |
| `tailscale` | package + `tailscaled`; asserts the node is logged in with `tag:edge`. Login stays manual (`tailscale up --ssh --hostname=… --advertise-tags=tag:edge`) unless `TS_AUTHKEY` is exported |
| `firewall` | public: `http`, `https`, `41641/udp`. trusted: `tailscale0`, pod CIDR, service CIDR |
| `storage` | LV `ocivolume/data` (110 GB, XFS) on `/var/lib/rancher/k3s/storage`, so Garage/Postgres cannot fill `/` |
| `k3s_server` | `/etc/rancher/k3s/config.yaml`, pinned k3s install, Traefik `HelmChartConfig`; asserts `FLANNEL_MTU <= 1230` |
| `nginx_front` | only where `nginx_front` is set: `/etc/nginx/conf.d/winkey.conf` with dedicated vhosts (`winkey.vn`, `s3.winkey.vn`, `media.winkey.vn`), `proxy_cache` on host disk (10 GB max), `client_max_body_size 64m` on s3, and Certbot TLS |
| `edge_ingress` | Traefik `IngressRoute` and `Middleware` (strip-user-headers, auth-verify forwardAuth, rate-limit), fixed internal NodePorts 30422/30432/30900 (ADR-015), and `whoami` smoke service via `/var/lib/rancher/k3s/server/manifests/` |

k3s: `cluster-init`, `node-ip`/`advertise-address` = Tailscale IP, `flannel-iface: tailscale0`,
`secrets-encryption`, `selinux: true`, kubeconfig `0600`. Joining servers (edge-2/3): set
`k3s_cluster_init: false`, `k3s_server_url: https://edge-1:6443`, export `K3S_TOKEN` (from
`/var/lib/rancher/k3s/server/token` on edge-1; never commit it).

## Shared nginx on edge-1

edge-1 also runs non-Winkey sites (kendrickheller.com, cuuhohanam.com, kidzlab.edu.vn,
sblaichau.vn) on a host nginx with its own certbot certs. So on edge-1:

```
client ─443─► host nginx ── winkey.vn, media., s3.  ─► Traefik NodePort 100.113.240.3:30080 ─► pods
                  └──────── other sites (unchanged)
```

- `traefik_service_type: NodePort` (host_vars). kube-proxy opens NodePorts **only on the Tailscale IP**
  (`nodeport-addresses`), because its DNAT happens before firewalld and would otherwise expose them.
- nginx terminates TLS, overwrites `X-Forwarded-For`/`X-Real-IP` with the client address and sets
  `X-Forwarded-Proto: https`. Traefik trusts forwarded headers only from `10.42.0.1` (host traffic
  to a NodePort is SNATed to cni0) and the node's Tailscale IP. Verified: backends see the real
  client IP, a client-sent `X-Forwarded-For` is dropped.
- Uploads: `client_max_body_size 64m` on `s3.winkey.vn` with streaming (`proxy_request_buffering off; proxy_buffering off;`).
- Web & API: `client_max_body_size 2m` on `winkey.vn` with normal buffering.
- Media streaming: `proxy_cache` on `media.winkey.vn` with `/var/cache/nginx/winkey-media` (max 10 GB), Range requests enabled, and `X-Cache-Status` header.
- nginx changes are limited to `conf.d/winkey.conf`. Do not let certbot's installer edit it (the role uses
  `certonly`). Backup of the pre-I1 nginx config: `/root/nginx-backup-20260929.tgz`.

## Edge Ingress & Gateway (Task EDGE)

Kubernetes manifests are located under `deploy/k8s/edge/`:
- `middlewares.yaml`: `strip-user-headers` (removes client `X-User-Id` / `X-User-Roles`), `auth-verify` (forwardAuth to `http://auth-svc:3001/v1/auth/verify`), and `rate-limit` (per client IP).
- `ingressroute.yaml`: Traefik `IngressRoute` implementing exact path rules from `deploy/compose/traefik/dynamic.yml` (`/v1/*` routes, `/smoke/whoami`, and web `/` excluding `/v1`).
- `nodeports.yaml`: Internal NodePorts 30422 (NATS), 30432 (PostgreSQL), and 30900 (Garage S3) bound strictly to the Tailscale IP per ADR-015.
- `whoami.yaml`: Stand-in upstream for smoke testing gateway header stripping and routing.
- `clusterip-services.yaml`: ClusterIP service definitions for in-cluster service resolution.
  - `social-svc`: port 3004 with `targetPort: http` (note: when deploying social-svc in task I2, configure `HTTP_PORT=3004` matching compose, or name container port `http`).
  - `realtime-svc`: port 3005 with `targetPort: http` (supports WebSocket and ticket issuance).

### Verification

Run the automated smoke test script from any client with public Internet access:
```bash
./deploy/edge/smoke-test.sh
```

Verifies:
1. `curl -I https://winkey.vn/v1/auth/verify` returns HTTP 404 (internal-only endpoint not publicly routed).
2. `curl -I https://winkey.vn/v1/nope` returns HTTP 404 (does not bleed into web router).
3. `curl -H "X-User-Id: spoofed" https://winkey.vn/smoke/whoami` proves client-supplied identity headers are stripped.
4. `curl --connect-timeout 2 http://138.2.93.173:<port>` fails for 30422, 30432, 30900 (blocked from public IP).


### Do not set `traefik_service_type: LoadBalancer` on edge-1

That makes servicelb DNAT 80/443 to Traefik ahead of nginx. It was tried on 2026-09-29 with TLS
passthrough (SNI) + PROXY protocol back to nginx on 8080/8443 and **took the other sites down**:

| When (UTC+7) | What | Down |
|---|---|---|
| 12:31–12:38 | `-e k3s_enable_traefik=false` was a string → Traefik came up with a LoadBalancer. From the Internet 80 and 443 timed out; inside the cluster HTTP reached nginx but SNI passthrough closed right after ClientHello, without Traefik ever dialing nginx:8443 (cause not found; nginx itself accepts PROXY v2 + TLS on 8443). | ~7 min |
| 12:49–12:50 | `service.type: NodePort` in the HelmChartConfig was ignored: chart 40.x reads **`service.spec.type`**. The k3s restart re-rendered a LoadBalancer. | ~1 min |

Recovery both times: `k3s kubectl -n kube-system patch svc traefik --type=merge -p '{"spec":{"type":"NodePort"}}'`.
Traefik can own 80/443 once the other sites have left edge-1 (then drop `nginx_front` and set LoadBalancer).
