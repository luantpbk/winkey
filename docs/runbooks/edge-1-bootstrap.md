# Runbook — Bootstrap edge-1 (Tailscale, firewall, hostname)

**Mục tiêu:** edge-1 (`138.2.93.173`) tham gia tailnet với tên `edge-1` và tag `tag:edge`, mở đúng các cổng public, và SSH được qua Tailscale. Sau bước này, cài k3s thuộc task I1 (Antigravity 2).

**Ai chạy:** bạn, hoặc một phiên Claude Code chạy trên máy Windows có sẵn SSH key. Mất khoảng 10 phút.
**Không** dán mật khẩu hay private key vào chat, issue hoặc repo.

## 1. Tailscale admin console (làm trước)

1. *Access controls*: dán policy ở [INFRASTRUCTURE.md §4.2](../INFRASTRUCTURE.md), rồi **Save**. Phải có `tag:edge` / `tag:gpu` trước thì bước 3 mới gắn tag được.
2. *Machines* → máy nhà:
   - **Edit machine name** → `gpu-01`.
   - **Edit ACL tags** → `tag:gpu`.

## 2. OCI Console → VCN → Security List của subnet edge-1

Thêm các ingress rule, source `0.0.0.0/0`:

| Protocol | Port | Mục đích |
|---|---|---|
| TCP | 80 | HTTP → redirect HTTPS, ACME |
| TCP | 443 | Web, API, media, s3 |
| UDP | 41641 | Tailscale kết nối trực tiếp |

Giữ TCP 22 cho tới khi bước 4 kiểm tra xong Tailscale SSH. Sau đó có thể giới hạn 22 về IP nhà để làm đường cứu hộ.

## 3. Trên edge-1

```powershell
# Từ máy Windows (PowerShell)
ssh -i C:\Users\Admin\Documents\OpenSSHKey opc@138.2.93.173
```

```bash
# Thông tin nền — gửi lại kết quả cho architect (issue I0)
uname -m; head -4 /etc/os-release; nproc; free -g; df -h /

# Hostname
sudo hostnamectl set-hostname edge-1

# Tailscale (script chính thức hỗ trợ Oracle Linux/RHEL/Ubuntu)
curl -fsSL https://tailscale.com/install.sh | sh
sudo systemctl enable --now tailscaled
sudo tailscale up --ssh --hostname=edge-1 --advertise-tags=tag:edge
#   → mở URL được in ra, đăng nhập bằng tài khoản admin của tailnet
tailscale ip -4

# Firewall — Oracle Linux (firewalld)
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --permanent --add-port=41641/udp
sudo firewall-cmd --permanent --zone=trusted --add-interface=tailscale0   # traffic tailnet đã có ACL kiểm soát
sudo firewall-cmd --reload
sudo firewall-cmd --list-all
#   Nếu là Ubuntu (không có firewall-cmd): dùng iptables — chèn ACCEPT cho 80, 443/tcp và 41641/udp
#   TRƯỚC rule REJECT trong /etc/iptables/rules.v4, rồi `sudo netfilter-persistent reload`.
```

## 4. Kiểm tra

Chạy từ **máy của bạn đã cài Tailscale** (thiết bị do admin sở hữu, không gắn tag). gpu-01 mang `tag:gpu` nên theo policy **không** SSH được vào edge; điều này là cố ý.

```bash
tailscale status              # thấy edge-1 (tag:edge) và gpu-01 (tag:gpu)
tailscale ping edge-1         # phải là "via <ip>:<port>" (direct), không phải DERP
ssh opc@edge-1 'hostname'     # Tailscale SSH, không cần key → in ra "edge-1"
```

Trên gpu-01: `tailscale ping edge-1` cũng phải là direct (kết nối cho k3s agent sau này).

## 5. Báo lại

Gửi cho architect, hoặc dán vào issue `[I0] Hardware verification`:
- output `uname -m` và `/etc/os-release`;
- `tailscale status`.

Nếu `uname -m` **không phải** `aarch64` thì báo ngay, vì cần xem lại ADR-012.
