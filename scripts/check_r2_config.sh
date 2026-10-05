#!/usr/bin/env bash
set -eo pipefail

echo "================================================================"
echo "         Kiểm Tra Danh Sách Cấu Hình Cloudflare R2             "
echo "================================================================"
echo ""

SECRETS=("r2-upload-svc" "r2-video-svc" "r2-media-origin" "r2-pg-backup" "r2-migration")
BUCKETS=("winkey-raw" "winkey-media" "winkey-media (ro)" "winkey-pg-backup" "All Buckets")

printf "%-18s %-20s %-12s %-12s %-30s\n" "Secret K8s" "Phạm Vi Bucket" "Key ID" "Secret Key" "Endpoint R2"
printf "%-18s %-20s %-12s %-12s %-30s\n" "------------------" "--------------------" "------------" "------------" "------------------------------"

ALL_VALID=true

for i in "${!SECRETS[@]}"; do
  s="${SECRETS[$i]}"
  b="${BUCKETS[$i]}"
  
  if ! sudo /usr/local/bin/k3s kubectl get secret "$s" -n default >/dev/null 2>&1; then
    printf "%-18s %-20s %-12s %-12s %-30s\n" "$s" "$b" "THIẾU" "THIẾU" "Chưa tạo Secret"
    ALL_VALID=false
    continue
  fi

  ep=$(sudo /usr/local/bin/k3s kubectl get secret "$s" -n default -o jsonpath='{.data.S3_ENDPOINT}' 2>/dev/null | base64 -d || true)
  kid=$(sudo /usr/local/bin/k3s kubectl get secret "$s" -n default -o jsonpath='{.data.S3_ACCESS_KEY_ID}' 2>/dev/null | base64 -d || true)
  if [ -z "$kid" ]; then
    kid=$(sudo /usr/local/bin/k3s kubectl get secret "$s" -n default -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' 2>/dev/null | base64 -d || true)
  fi
  sec=$(sudo /usr/local/bin/k3s kubectl get secret "$s" -n default -o jsonpath='{.data.S3_SECRET_ACCESS_KEY}' 2>/dev/null | base64 -d || true)
  if [ -z "$sec" ]; then
    sec=$(sudo /usr/local/bin/k3s kubectl get secret "$s" -n default -o jsonpath='{.data.AWS_SECRET_ACCESS_KEY}' 2>/dev/null | base64 -d || true)
  fi
  if [ -z "$ep" ]; then
    ep=$(sudo /usr/local/bin/k3s kubectl get secret r2-upload-svc -n default -o jsonpath='{.data.S3_ENDPOINT}' 2>/dev/null | base64 -d || true)
  fi

  # Check Key ID
  if [ -z "$kid" ]; then
    kid_status="RỖNG (Lỗi)"
    ALL_VALID=false
  else
    kid_len=${#kid}
    kid_status="${kid:0:4}...(${kid_len}kí tự)"
  fi

  # Check Secret
  if [ -z "$sec" ]; then
    sec_status="RỖNG (Lỗi)"
    ALL_VALID=false
  else
    sec_len=${#sec}
    sec_status="ĐÃ CÓ (${sec_len}kt)"
  fi

  # Check Endpoint
  if [ -z "$ep" ] || [ "$ep" = "https://.r2.cloudflarestorage.com" ]; then
    ep_status="THIẾU Account ID"
    ALL_VALID=false
  else
    ep_status="$ep"
  fi

  printf "%-18s %-20s %-12s %-12s %-30s\n" "$s" "$b" "$kid_status" "$sec_status" "$ep_status"
done

echo ""
echo "----------------------------------------------------------------"
if [ "$ALL_VALID" = true ]; then
  echo "Trạng thái: Tất cả Secret đã có dữ liệu hợp lệ!"
  echo "Đang thử nghiệm kết nối thực tế tới Cloudflare R2 qua pod kiểm tra..."
  
  sudo /usr/local/bin/k3s kubectl run r2-verify-test --rm -i --restart=Never --image=rclone/rclone:1.69.1 \
    --env=RCLONE_CONFIG_R2_TYPE=s3 \
    --env=RCLONE_CONFIG_R2_PROVIDER=Cloudflare \
    --env=RCLONE_CONFIG_R2_REGION=auto \
    --env=RCLONE_CONFIG_R2_ENDPOINT="$(sudo /usr/local/bin/k3s kubectl get secret r2-migration -n default -o jsonpath='{.data.S3_ENDPOINT}' | base64 -d)" \
    --env=RCLONE_CONFIG_R2_ACCESS_KEY_ID="$(sudo /usr/local/bin/k3s kubectl get secret r2-migration -n default -o jsonpath='{.data.S3_ACCESS_KEY_ID}' | base64 -d)" \
    --env=RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$(sudo /usr/local/bin/k3s kubectl get secret r2-migration -n default -o jsonpath='{.data.S3_SECRET_ACCESS_KEY}' | base64 -d)" \
    --command -- sh -c '
      echo "=== Kiểm tra truy cập từng Bucket trên Cloudflare R2 ==="
      for b in winkey-raw winkey-media winkey-pg-backup winkey-backup; do
        if rclone lsf "r2:$b" >/dev/null 2>&1; then
          echo "  [OK] Bucket $b: Kết nối thành công!"
        else
          echo "  [FAIL] Bucket $b: Lỗi truy cập hoặc chưa tạo trên Cloudflare!"
        fi
      done
    ' 2>&1
else
  echo "Trạng thái: CẦN CẬP NHẬT LẠI."
  echo "Một số secret đang bị rỗng (do khi chạy setup_r2_secrets.sh chưa nhập Account ID hoặc Token)."
  echo "Để cấu hình lại, bạn chỉ cần chạy lại: /tmp/setup_r2_secrets.sh"
fi
echo "================================================================"
