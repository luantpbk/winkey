# Hạ tầng thử nghiệm (small-scale, self-hosted)

> Owner: Antigravity 2 (triển khai), Opus (quyết định). Tài liệu này là nguồn sự thật về **chạy cái gì ở đâu**.
> Các số liệu có đánh dấu **[đo]** là ước tính và phải được kiểm chứng ở task **I0**.

## 0. Giai đoạn hiện tại: **1 VPS** (ADR-013)

Trong giai đoạn phát triển chỉ dùng **edge-1** (`138.2.93.173`, user `opc`, nhiều khả năng Oracle Linux) cùng **gpu-01** (`192.168.1.4` trong LAN). edge-2 và edge-3 chưa tham gia. Mọi workload đánh dấu cho edge-2/edge-3 ở §3 tạm dồn về edge-1, với số bản sao như sau:

| Thành phần | Giai đoạn 1 VPS | Khi thêm edge-2/3 |
|---|---|---|
| k3s | 1 server, khởi tạo bằng `--cluster-init` (etcd nhúng) | Join thêm 2 server → HA, không cần dựng lại |
| Garage | 1 node, `replication_factor = 1`, **dữ liệu coi như dùng một lần** | Dựng cluster mới RF 2, `rclone sync` bucket sang, rồi đổi endpoint |
| NATS JetStream | 1 node, stream `replicas: 1` | Chuyển sang cluster 3 node, `nats stream edit --replicas 3` |
| PostgreSQL (CNPG) | `instances: 1`, backup hằng đêm về gpu-01 | `instances: 2` |
| Valkey, media-cache, Traefik, app | 1 bản | Như §3 |

- **Môi trường dev chung**: stack docker compose của F3 chạy trên **gpu-01** (64 GB RAM, cùng LAN với mọi agent). edge-1 là **staging public** (`winkey.vn`) khi các service đã có image.
- **Truy cập**: SSH vào edge-1 bằng key của bạn (không lưu trong repo); vào gpu-01 qua LAN. Sau bootstrap thì dùng Tailscale SSH (`ssh opc@edge-1`).
- Runbook bootstrap edge-1: [runbooks/edge-1-bootstrap.md](runbooks/edge-1-bootstrap.md).

### 0.1 Thực tế edge-1 sau task I1 (báo cáo 2026-09-29)

| Hạng mục | Thực tế | Ghi chú |
|---|---|---|
| Vai trò máy | **Dùng chung**: nginx host (4 site cũ), 7 app Node, PostgreSQL host, Cockpit | Winkey phải cùng tồn tại, không được làm sập site cũ (ADR-014) |
| OS / CPU | Oracle Linux, **SELinux Permissive**, **`aarch64`** (đã xác nhận) | ADR-012 giữ nguyên |
| k3s | v1.36.4+k3s1, 1 server `--cluster-init`, secrets-encryption bật | Node IP = Tailscale `100.113.240.3`, flannel trên `tailscale0`, MTU 1230 |
| Ingress | nginx host :80/:443 (Certbot HTTP-01) → Traefik v3.7 NodePort 30080/30443 (chỉ trên IP Tailscale) | ADR-014 |
| Đĩa | 200 GB: `/` 70 GB, LV data 110 GB XFS cho `/var/lib/rancher/k3s/storage`, **VG còn ~3 GB** | Xem §5 (dung lượng giảm) |
| Firewall public | 80, 443, 41641/udp của Winkey; **9090 (Cockpit) và 7890 cũng đang mở public** | ⚠️ Xem §8 |
| Trusted zone | `tailscale0`, `10.42.0.0/16`, `10.43.0.0/16` | |
| Code triển khai | `deploy/ansible/` (đã merge, PR #5) | Chủ sở hữu từ nay: Antigravity 2 |

Ngân sách tài nguyên trên edge-1 (4 vCPU / 24 GB, dùng chung): Winkey giới hạn tổng **requests ≤ 2 vCPU / 10 GB**. Mọi pod phải đặt `resources.requests/limits`.

## 1. Kiểm kê phần cứng

| Node | Phần cứng | Kiến trúc | Mạng | Nhận xét quan trọng |
|---|---|---|---|---|
| **gpu-01** (nhà) | 2× Xeon E5-2690 (Sandy Bridge-EP, **16C/32T**, AVX, **không AVX2**), **64 GB** RAM, **RTX 5060 Ti** (Blackwell, NVENC/NVDEC thế hệ mới: H.264/HEVC/AV1), NVMe Kingmax 512 GB (root port CPU), NVMe Samsung PM981 256 GB (root port chipset X79, **PCIe 2.0**), 6 cổng SATA trống, 2× GbE 82574L | amd64 | Mạng gia đình, sau NAT, **uplink chưa rõ [đo]** | Mạnh về tính toán, yếu về uptime và băng thông upload → **không bao giờ phục vụ traffic public** |
| **edge-1/2/3** (Oracle, **cùng region**, Pay-As-You-Go) | VM QEMU/virtio, 4 vCPU, 24 GB RAM, 200 GB block volume (virtio-scsi), 1 NIC virtio | **arm64** (`uname -m` = `aarch64` trên edge-1) | IP public, ~1 Gbps/OCPU, **10 TB egress/tháng/tenancy** miễn phí | Ổn định, băng thông lớn, đĩa nhỏ → edge + dữ liệu trạng thái |

Tất cả kết nối với nhau qua **Tailscale** (tailnet riêng). Traffic nội bộ không bao giờ đi qua IP public.
Các AI agent (Sonnet 5.5, Antigravity 1–3) chạy trên máy **cùng LAN với gpu-01** và SSH được vào gpu-01.

### Đã xác nhận (2026-09-29)

| Hạng mục | Kết quả | Hệ quả |
|---|---|---|
| 3 VPS cùng region | ✅ | **k3s HA 3 server** (embedded etcd), không cần phương án 1 server + 2 agent |
| Tailscale kết nối trực tiếp | ✅ | Không qua DERP; throughput gpu-01 ↔ edge chỉ bị giới hạn bởi uplink nhà |
| Oracle Pay-As-You-Go | ✅ | Instance không bị thu hồi do "nhàn rỗi" |
| Tên miền | ✅ `winkey.vn` | Xem §4.1 |
| Kiến trúc VPS | 🟡 gần chắc chắn arm64 | Không chặn gì (image đa kiến trúc); chạy `uname -m` để chốt |
| Uplink nhà, NVENC benchmark, số phiên NVENC | ⬜ | Đo trong I0 (§9) |

## 2. Nguyên tắc phân bổ

1. **Edge (VPS) giữ mọi thứ user chạm vào và mọi dữ liệu trạng thái**: ingress, API, web, object storage, DB, queue, media cache.
2. **gpu-01 chỉ chạy batch, kéo việc từ queue**: transcode, lưu trữ archive, CI build amd64, observability, và sau này training recommendation. Khi gpu-01 mất mạng hoặc mất điện, job chỉ **xếp hàng chờ trong NATS**, không mất và site không sập (ADR-003).
3. **Mọi service stateful chạy 2–3 bản trên 3 VPS** để chịu được mất 1 node.

## 3. Bố trí workload

| Workload | edge-1 | edge-2 | edge-3 | gpu-01 | Ghi chú |
|---|:-:|:-:|:-:|:-:|---|
| k3s server (embedded etcd) | ● | ● | ● | | gpu-01 **không** tham gia k3s (ADR-015) |
| Traefik ingress | ● | ● | ● | | edge-1: NodePort 30080/30443 sau nginx host (ADR-014); edge-2/3: 80/443 trực tiếp |
| **media-cache** | ● | ● | ● | | edge-1: `proxy_cache` của nginx host (ADR-014); edge-2/3: DaemonSet, cache local 30 GB/node |
| **Garage** (S3) | ● | ● | ● | | `replication_factor = 2`, ~120 GB/node dành cho dữ liệu |
| **NATS JetStream** | ● | ● | ● | | Cluster 3 node, stream R3 |
| **PostgreSQL** (CloudNativePG) | primary | replica | | | Backup (barman) vào bucket `winkey-backups`; hằng đêm rclone về gpu-01 |
| Valkey (Redis-compatible) | | ● | | | Cache/rate-limit; mất thì chỉ chậm hơn, không mất dữ liệu |
| web, auth-svc, upload-svc, video-svc, social-svc, realtime-gw | ○ | ○ | ○ | | Stateless, 2 replica, anti-affinity |
| **transcoder** (NVENC) | | | | ● | Worker ngoài k3s (ADR-015), concurrency 2 (xem §6) |
| transcoder (x264, overflow) | | | | ● | Concurrency 1 |
| Raw archive, observability (VictoriaMetrics, Loki, Grafana), CI runner amd64 | | | | ● | Nội bộ, chỉ vào qua Tailscale |
| CI runner arm64 | | | ● | | Build image arm64 native |
| Uptime Kuma (giám sát từ ngoài) | ● | | | | Cảnh báo khi gpu-01 hoặc site chết |

● = cố định, ○ = scheduler tự chọn.

## 4. Mạng

- **Public**: chỉ `80/tcp`, `443/tcp` trên 3 VPS, và `41641/udp` để Tailscale kết nối trực tiếp. Cần mở ở **cả VCN Security List lẫn firewall của OS**: Oracle Linux dùng `firewalld`; nếu là image Ubuntu của OCI thì là iptables với rule REJECT mặc định. Oracle Linux bật **SELinux enforcing**: script cài k3s tự cài `k3s-selinux`, không tắt SELinux. SSH chỉ qua **Tailscale SSH**.
- **gpu-01**: không port-forward bất kỳ cổng nào trên router.
- **Tailscale**: tag và policy ở §4.2. Phân quyền giữa các pod dùng **Kubernetes NetworkPolicy** (k3s có sẵn controller), không dùng Tailscale ACL: traffic pod-to-pod đi trong VXLAN nên ACL theo cổng không nhìn thấy.
- **k3s qua Tailscale**: `--node-ip=<IP tailscale>`, `--flannel-iface=tailscale0`. **MTU của flannel ≤ 1230**, vì tailscale0 có MTU 1280 và VXLAN tốn thêm 50 byte. Nếu không chỉnh, pod-to-pod sẽ treo ngẫu nhiên với gói lớn.
- **TLS**: trên edge-1, Certbot HTTP-01 trên host, gia hạn bằng `certbot-renew.timer` (ADR-014). Khi có edge-2/3 riêng thì dùng cert-manager + Let's Encrypt **DNS-01** (Cloudflare API).

### 4.1 DNS — `winkey.vn`

Nameserver của `winkey.vn` chuyển sang **Cloudflare (gói Free)**, vì cert-manager cần DNS API để làm DNS-01. Tất cả record để **DNS-only (mây xám)** trong P1:
- `media`: điều khoản CDN không cho proxy video (ADR-005).
- `s3`: Cloudflare giới hạn request body 100 MB, trong khi part upload tới 16 MB+ và có thể dài hơn.
- Apex: để thống nhất; cân nhắc bật proxy ở P2 nếu cần chống DDoS.

| Record | Type | Giá trị | TTL | Dùng cho |
|---|---|---|---|---|
| `winkey.vn` | A ×3 | IP public edge-1, edge-2, edge-3 | 60 | Web + API `/v1/*` (cùng origin) |
| `www` | CNAME | `winkey.vn` | 300 | Traefik redirect 301 → apex |
| `media` | A ×3 | 3 IP edge | 60 | HLS qua media-cache |
| `s3` | A ×3 | 3 IP edge | 60 | Presigned upload vào Garage |
| `winkey.vn` | CAA | `0 issue "letsencrypt.org"` | 3600 | Chỉ Let's Encrypt được cấp cert |
| (tùy chọn) | AAAA ×3 | IPv6 của edge nếu VCN bật IPv6 | 60 | |

- DNS round-robin **không có health check**. Trình duyệt tự thử IP khác khi một IP không kết nối được; ngoài ra task EDGE làm thêm một CronJob gỡ/thêm A record qua Cloudflare API khi node chết hoặc hồi phục.
- Cloudflare API token: quyền **Zone → DNS → Edit**, chỉ cho zone `winkey.vn`. Lưu làm Kubernetes Secret, **không commit và không dán vào chat**.

### 4.2 Tailscale — tên máy, tag, policy

- Tên máy (MagicDNS): `gpu-01`, `edge-1`, `edge-2`, `edge-3`.
- Đăng ký node bằng `tailscale up --ssh --advertise-tags=tag:edge` (hoặc `tag:gpu`). Node có tag thì key không hết hạn.
- Dán policy dưới đây vào *Admin console → Access controls*, **thay thế toàn bộ nội dung**. Không để lại khối `grants` mặc định `{"src":["*"],"dst":["*"]}`, vì nó mở toàn bộ tailnet và vô hiệu hóa mọi luật bên dưới.
- **Mọi thiết bị (edge-1, gpu-01, máy admin) phải cùng một tailnet.** Máy nào đang ở tailnet khác thì `tailscale logout` rồi đăng nhập lại bằng tài khoản sở hữu tailnet của edge-1.

```hujson
{
  "tagOwners": {
    "tag:edge": ["autogroup:admin"],
    "tag:gpu":  ["autogroup:admin"],
  },
  "acls": [
    // Máy của bạn và các máy chạy agent (thiết bị do admin sở hữu): toàn quyền.
    {"action": "accept", "src": ["autogroup:admin"], "dst": ["*:*"]},
    // Edge ↔ edge: etcd, k3s, flannel, Garage RPC, NATS cluster, Postgres replication.
    {"action": "accept", "src": ["tag:edge"], "dst": ["tag:edge:*"]},
    // gpu-01 (transcoder worker, ADR-015) → edge: NodePort của NATS 30422, PostgreSQL Winkey 30432, Garage S3 30900.
    // KHÔNG mở 5432: đó là PostgreSQL của host (dữ liệu các site cũ).
    {"action": "accept", "src": ["tag:gpu"], "dst": ["tag:edge:30422,30432,30900"]},
    // edge → gpu-01: node-exporter / metrics của transcoder.
    {"action": "accept", "src": ["tag:edge"], "dst": ["tag:gpu:9100,9464"]},
  ],
  "ssh": [
    {"action": "accept", "src": ["autogroup:admin"], "dst": ["tag:edge", "tag:gpu"],
     "users": ["autogroup:nonroot", "root"]},
  ],
  "tests": [
    {"src": "tag:gpu",  "accept": ["tag:edge:30422", "tag:edge:30432", "tag:edge:30900"], "deny": ["tag:edge:22", "tag:edge:5432", "tag:edge:6443", "tag:edge:30080", "tag:edge:9090"]},
    {"src": "tag:edge", "accept": ["tag:gpu:9100"], "deny": ["tag:gpu:22"]},
  ],
}
```

## 5. Lưu trữ & dung lượng

| Bucket (Garage) | Nội dung | Vòng đời |
|---|---|---|
| `winkey-raw` | File gốc người dùng upload | Xóa sau **7 ngày** kể từ khi READY. Transcoder chép 1 bản sang archive trên gpu-01 trước khi xử lý |
| `winkey-media` | HLS + thumbnail, key `v/{video_id}/a{attempt}/…` | Vĩnh viễn; attempt cũ bị xóa bởi janitor |
| `winkey-backups` | Backup PostgreSQL | 14 ngày; bản sao hằng đêm ở gpu-01 |

- **Dung lượng dùng được**:
  - Mục tiêu 3 node: ≈ 3 × 120 GB / RF 2 ≈ **180 GB**.
  - **Hiện tại trên edge-1**: LV data 110 GB dùng chung cho mọi PVC (local-path). Phân bổ:
    - Garage ≈ **70 GB**, tức khoảng 15 giờ video 1080p đủ ladder;
    - PostgreSQL 15 GB;
    - NATS 5 GB;
    - dự phòng 20 GB.

    Cache media của nginx host đặt trên `/`, giới hạn `max_size=10g`. VG chỉ còn khoảng 3 GB nên **không mở rộng LV được**. Cần thêm dung lượng thì mua block volume, hoặc chuyển `winkey-media` sang R2 sớm hơn.
- 1 giờ video 1080p với đủ ladder (5.0 + 2.8 + 1.4 Mbps video + 3 × 128 kbps audio) ≈ **4.3 GB**, nên chứa được khoảng **35–40 giờ nội dung**. Đủ cho thử nghiệm.
- **Khi vượt ~70%**: chuyển origin `winkey-media` sang **Cloudflare R2** (không phí egress, được phép phục vụ video qua CDN của Cloudflare) hoặc Backblaze B2. Nhờ ADR-004 chỉ cần đổi endpoint.
- **Khuyến nghị cho gpu-01**: gắn thêm 1 HDD SATA 4–8 TB cho raw archive và bản sao backup. Đặt NVMe Kingmax (PCIe 3.0) làm **scratch cho transcode**, Samsung (PCIe 2.0) cho OS và log.

## 6. Năng lực transcode (gpu-01)

- **Pipeline mặc định** (ADR-006): NVDEC decode (`-hwaccel cuda`, frame được copy về RAM) → scale/format trên CPU → **h264_nvenc** encode 3 rendition.
- Nếu NVDEC không hỗ trợ codec đầu vào, FFmpeg tự fallback về software decode.
- **Giới hạn phiên NVENC của GeForce**: driver hiện hành cho tối đa 8 phiên đồng thời **[đo]**. Mỗi job dùng 3 phiên, nên **tối đa 2 job NVENC song song** (6 phiên), chừa phần dư cho test.
- **Ước tính [đo]**: một job 1080p30 chạy ~5–10× realtime trên NVENC, ~2× với x264 `veryfast` trên 32 thread. Nút thắt nhiều khả năng là **uplink nhà** khi đẩy HLS lên Garage: ~4.3 GB mỗi giờ video, tương đương khoảng 6 phút ở 100 Mbps.
- **Yêu cầu phần mềm**: driver NVIDIA ≥ 570 (Blackwell), NVIDIA Container Toolkit, FFmpeg ≥ 7.1 build có `--enable-nvenc --enable-cuvid`. Kiểm tra bằng `ffmpeg -encoders | grep nvenc` và một lần encode thử.
- **CPU không có AVX2**: x264 vẫn chạy tốt; x265/SVT-AV1 sẽ rất chậm. Dùng **av1_nvenc** nếu sau này làm AV1 (P4).

## 7. Băng thông phát

- **Egress miễn phí**: 10 TB/tháng/tenancy. Nếu 3 VPS thuộc 3 tenancy thì tổng khoảng 30 TB/tháng. Ở mức trung bình 3 Mbps/người xem (~1.35 GB/giờ), đủ cho khoảng **22.000 giờ xem/tháng**.
- **NIC**: khoảng 4 Gbps/VPS, về lý thuyết hơn 1.000 luồng 3 Mbps mỗi node. Giới hạn thực tế sẽ là egress quota, không phải NIC.
- Segment HLS **immutable**, nên cache hit ratio của media-cache sẽ > 95% sau lần xem đầu.

## 8. Rủi ro & biện pháp

| Rủi ro | Ảnh hưởng | Biện pháp |
|---|---|---|
| **edge-1 dùng chung: thay đổi Winkey làm sập site cũ** (đã xảy ra 2 lần, ~8 phút) | Site của khách khác sập | ADR-014; mọi thay đổi nginx/firewall/k3s chạy `--check --diff` trước, có rollback, làm theo khung giờ báo trước; smoke test 4 site cũ sau mỗi lần deploy |
| **Cockpit :9090 và :7890 mở public trên edge-1** | Bị dò mật khẩu / lạm dụng proxy (7890 thường là cổng proxy HTTP/SOCKS) | Đóng khỏi zone public, chỉ cho phép qua `tailscale0` (task SEC0) |
| Tranh chấp CPU/RAM với 7 app Node + PostgreSQL host | Winkey hoặc site cũ chậm | Requests/limits bắt buộc; ngân sách Winkey ≤ 2 vCPU / 10 GB (§0.1) |
| gpu-01 mất điện/mạng | Video mới không được xử lý | Queue giữ job (max age 7d); Uptime Kuma cảnh báo; worker x264 có thể tạm chạy trên edge nếu cần (image amd64 → **cần build arm64 cho transcoder-x264**, để dành cho P2) |
| Oracle thu hồi instance Always Free "nhàn rỗi" | Mất node | ✅ Đã nâng Pay-As-You-Go. Vẫn backup ra ngoài OCI (gpu-01) |
| Tailscale rơi về DERP relay (sau khi đổi mạng/router) | Throughput gpu-01 ↔ edge rất thấp | ✅ Hiện đang direct. Giữ UDP 41641 mở; Uptime Kuma kiểm tra định kỳ `tailscale ping` |
| Hỏng etcd khi mất 2/3 VPS | Control plane dừng | ✅ Cùng region nên chạy HA 3 server; snapshot etcd hằng ngày về gpu-01 |
| arm64 trên edge | Image không chạy | Mọi image build `linux/amd64,linux/arm64`; riêng transcoder-nvenc chỉ cần amd64 |
| Uplink nhà thấp/không ổn định | Chờ READY lâu | Multipart upload có retry; đo bằng `iperf3` qua Tailscale; cân nhắc giới hạn 1080p |
| Một GPU duy nhất | Single point of failure cho tốc độ | Fallback x264 tự động |

## 9. Checklist I0 (Antigravity 2 chạy, dán kết quả vào issue I0)

Đã xác nhận nên bỏ qua: cùng region, Tailscale direct, PAYG. Còn lại:

```bash
# Trên mỗi VPS
uname -m; cat /etc/os-release | head -3    # kỳ vọng aarch64; ghi lại distro
nproc; free -g; df -h /
ping -c 20 edge-2                           # RTT giữa các VPS (kỳ vọng < 2 ms)
iperf3 -s                                   # (trên edge-1)

# Trên gpu-01
nvidia-smi                                  # driver ≥ 570, nhận RTX 5060 Ti
iperf3 -c <edge-1 tailscale ip> -t 30       # uplink nhà → edge
iperf3 -c <edge-1 tailscale ip> -t 30 -R    # downlink
ffmpeg -hide_banner -encoders | grep nvenc
ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=30 -t 60 -c:v h264_nvenc -preset p5 -f null -   # tốc độ ×realtime
# Thử 3, 4, … phiên NVENC song song để xác nhận giới hạn phiên
```
