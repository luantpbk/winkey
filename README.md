# Winkey

Nền tảng video streaming kiểu YouTube: upload, transcode HLS (1080p/720p/480p), phát qua cache, tài khoản và RBAC, tương tác realtime, gợi ý video. Dự án do một đội AI agent xây dựng; phân vai và quy tắc nằm trong [AGENTS.md](AGENTS.md).

| Tài liệu | Nội dung |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Kiến trúc, service, luồng dữ liệu, quy ước |
| [docs/INFRASTRUCTURE.md](docs/INFRASTRUCTURE.md) | Phần cứng (gpu-01 + 3 VPS Oracle qua Tailscale), bố trí workload, dung lượng, rủi ro |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture Decision Records |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phase và task board |
| [docs/prompts/](docs/prompts/README.md) | Prompt khởi động cho từng agent |
| [contracts/](contracts/events/README.md) | OpenAPI + event schema (nguồn sự thật) |
| [db/](db/README.md) | Migration PostgreSQL + SQL tests |

## Kiểm tra contract & DB

```bash
make contracts-lint
DATABASE_URL=postgres://user:pass@localhost:5432/winkey?sslmode=disable make db-test   # cần psql + migrate
```
