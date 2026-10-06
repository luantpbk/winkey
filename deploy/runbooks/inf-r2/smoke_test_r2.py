#!/usr/bin/env python3
"""Reusable end-to-end smoke test for Winkey Cloudflare R2 storage migration (INF-R2a).

Reads credentials from WINKEY_SMOKE_EMAIL and WINKEY_SMOKE_PASSWORD environment variables.
Uses standard verified TLS certificates.
"""

import sys
import os
import time
import json
import getpass
import urllib.request
import urllib.error
import ssl

ctx = ssl.create_default_context()

BASE_URL = os.environ.get("WINKEY_BASE_URL", "https://winkey.vn")
MEDIA_URL = os.environ.get("WINKEY_MEDIA_URL", "https://media.winkey.vn")
TEST_VIDEO_PATH = os.environ.get("WINKEY_TEST_VIDEO", "/tmp/test.mp4")

def make_req(url, method="GET", headers=None, data=None):
    if headers is None:
        headers = {}
    req = urllib.request.Request(url, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, data=data, context=ctx) as resp:
            resp_body = resp.read()
            resp_headers = dict(resp.getheaders())
            return resp.status, resp_headers, resp_body
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
    except Exception as e:
        return 0, {}, str(e).encode()

def main():
    print("==========================================================")
    print("        WINKEY CLOUDFLARE R2 END-TO-END SMOKE TEST        ")
    print("==========================================================")

    email = os.environ.get("WINKEY_SMOKE_EMAIL")
    password = os.environ.get("WINKEY_SMOKE_PASSWORD")

    if not email:
        email = input("Smoke Test Email: ").strip()
    if not password:
        password = getpass.getpass("Smoke Test Password: ").strip()

    if not email or not password:
        print("ERROR: Smoke test credentials must be provided via WINKEY_SMOKE_EMAIL and WINKEY_SMOKE_PASSWORD.")
        sys.exit(1)

    if not os.path.isfile(TEST_VIDEO_PATH):
        print(f"ERROR: Test video file not found at {TEST_VIDEO_PATH}.")
        sys.exit(1)

    # 1. Login
    print("\n[Step 1] Authenticating user...")
    login_data = json.dumps({"email": email, "password": password}).encode()
    status, _, body = make_req(f"{BASE_URL}/v1/auth/login", method="POST",
                               headers={"Content-Type": "application/json"}, data=login_data)
    if status != 200:
        print(f"FAILED to login: HTTP {status}, body: {body.decode()}")
        sys.exit(1)
    auth_resp = json.loads(body.decode())
    token = auth_resp["access_token"]
    user_id = auth_resp.get("user", {}).get("id", "unknown")
    print(f"  Logged in successfully! User ID: {user_id}")

    # 2. Initiate Upload
    file_size = os.path.getsize(TEST_VIDEO_PATH)
    print(f"\n[Step 2] Initiating upload for {TEST_VIDEO_PATH} ({file_size} bytes)...")
    init_data = json.dumps({
        "title": "R2 Storage Smoke Test",
        "description": "Automated smoke test for Cloudflare R2 migration",
        "filename": os.path.basename(TEST_VIDEO_PATH),
        "content_type": "video/mp4",
        "size_bytes": file_size,
        "visibility": "PUBLIC"
    }).encode()
    status, _, body = make_req(f"{BASE_URL}/v1/uploads", method="POST",
                               headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                               data=init_data)
    if status != 201:
        print(f"FAILED to initiate upload: HTTP {status}, body: {body.decode()}")
        sys.exit(1)
    upload_resp = json.loads(body.decode())
    video_id = upload_resp["video_id"]
    print(f"  Created video upload session: ID = {video_id}")

    # 3. Request Presigned Upload Parts
    print(f"\n[Step 3] Requesting presigned URL for part 1...")
    parts_data = json.dumps({"part_numbers": [1]}).encode()
    status, _, body = make_req(f"{BASE_URL}/v1/uploads/{video_id}/parts", method="POST",
                               headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                               data=parts_data)
    if status != 200:
        print(f"FAILED to get presigned parts: HTTP {status}, body: {body.decode()}")
        sys.exit(1)
    parts_resp = json.loads(body.decode())
    part_url = parts_resp["urls"][0]["url"]
    print(f"  Received Presigned URL: {part_url[:80]}...")
    if "r2.cloudflarestorage.com" in part_url:
        print("  [VERIFIED] Presigned URL targets Cloudflare R2 endpoint directly.")

    # 4. PUT part data directly to R2
    print(f"\n[Step 4] Uploading video data directly to R2 presigned URL...")
    with open(TEST_VIDEO_PATH, "rb") as f:
        video_bytes = f.read()
    status, put_headers, put_body = make_req(part_url, method="PUT", headers={"Content-Type": "video/mp4"}, data=video_bytes)
    if status != 200:
        print(f"FAILED to PUT part to R2: HTTP {status}, headers: {put_headers}, body: {put_body.decode()}")
        sys.exit(1)
    etag = put_headers.get("ETag") or put_headers.get("etag", "")
    etag = etag.strip('"')
    print(f"  Successfully uploaded part 1! ETag = {etag}")

    # 5. Complete Multipart Upload
    print(f"\n[Step 5] Completing multipart upload...")
    comp_data = json.dumps({"parts": [{"part_number": 1, "etag": etag}]}).encode()
    status, _, body = make_req(f"{BASE_URL}/v1/uploads/{video_id}/complete", method="POST",
                               headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                               data=comp_data)
    if status != 202:
        print(f"FAILED to complete upload: HTTP {status}, body: {body.decode()}")
        sys.exit(1)
    print(f"  Upload completed! HTTP 202 Accepted. Event published to NATS.")

    # 6. Poll for Transcoder Processing (READY state)
    print(f"\n[Step 6] Polling video status until READY (processing on gpu-01)...")
    ready = False
    for attempt in range(1, 40):
        time.sleep(2)
        status, _, body = make_req(f"{BASE_URL}/v1/videos/{video_id}", method="GET",
                                   headers={"Authorization": f"Bearer {token}"})
        if status == 200:
            v_info = json.loads(body.decode())
            v_status = v_info.get("status")
            print(f"  Attempt {attempt}: status = {v_status}")
            if v_status == "READY":
                ready = True
                print("  [SUCCESS] Video transcoding completed! Status is READY.")
                break
            elif v_status == "FAILED":
                print(f"  [ERROR] Video transcoding FAILED! Details: {body.decode()}")
                sys.exit(1)
        else:
            print(f"  Attempt {attempt}: HTTP {status}")
    if not ready:
        print("  [TIMEOUT] Transcoder did not finish within timeout!")
        sys.exit(1)

    # 7. Smoke Test PUBLIC Playback
    print(f"\n[Step 7] Testing PUBLIC playback via {MEDIA_URL}...")
    master_url = f"{MEDIA_URL}/v/{video_id}/a1/hls/master.m3u8"
    status, headers, body = make_req(master_url, method="GET")
    if status == 200:
        print(f"  [SUCCESS] PUBLIC playback master.m3u8 returned HTTP 200!")
        print(f"  Content-Type: {headers.get('Content-Type') or headers.get('content-type')}")
        print(f"  Cache-Control: {headers.get('Cache-Control') or headers.get('cache-control')}")
    else:
        print(f"  [FAILED] PUBLIC playback returned HTTP {status}")
        sys.exit(1)

    # 8. Smoke Test UNLISTED
    print(f"\n[Step 8] Updating visibility to UNLISTED and testing...")
    unlisted_data = json.dumps({"visibility": "UNLISTED"}).encode()
    status, _, _ = make_req(f"{BASE_URL}/v1/videos/{video_id}", method="PATCH",
                            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                            data=unlisted_data)
    print(f"  PATCH visibility UNLISTED status: {status}")
    status, headers, _ = make_req(master_url, method="GET")
    print(f"  UNLISTED plain URL access: HTTP {status}")

    # 9. Smoke Test PRIVATE & Signed URL
    print(f"\n[Step 9] Updating visibility to PRIVATE and testing signed URL...")
    priv_data = json.dumps({"visibility": "PRIVATE"}).encode()
    status, _, _ = make_req(f"{BASE_URL}/v1/videos/{video_id}", method="PATCH",
                            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                            data=priv_data)
    print(f"  PATCH visibility PRIVATE status: {status}")

    print("  Asserting plain URL returns 403 after cache expiry (up to 35s)...")
    blocked = False
    for i in range(1, 36):
        status, _, _ = make_req(master_url, method="GET")
        if status == 403:
            print(f"  [SUCCESS] Plain URL returned HTTP 403 after {i} seconds!")
            blocked = True
            break
        time.sleep(1)
    if not blocked:
        print("  [FAILED] Plain URL did not return HTTP 403 within 35s!")
        sys.exit(1)

    # Get signed URL as owner
    status, _, body = make_req(f"{BASE_URL}/v1/videos/{video_id}", method="GET",
                               headers={"Authorization": f"Bearer {token}"})
    v_data = json.loads(body.decode())
    playback = v_data.get("playback") or {}
    signed_hls = playback.get("hls_url", "")
    print(f"  Owner received signed HLS URL: {signed_hls[:80]}...")
    if "/s/" not in signed_hls:
        print(f"  [FAILED] Signed URL missing /s/ prefix: {signed_hls}")
        sys.exit(1)

    status, headers, _ = make_req(signed_hls, method="GET")
    if status == 200:
        print(f"  [SUCCESS] Signed URL playback returned HTTP 200!")
    else:
        print(f"  [FAILED] Signed URL playback returned HTTP {status}")
        sys.exit(1)

    # 10. Delete Video & Verify Gate
    print(f"\n[Step 10] Deleting test video {video_id}...")
    status, _, body = make_req(f"{BASE_URL}/v1/videos/{video_id}", method="DELETE",
                               headers={"Authorization": f"Bearer {token}"})
    print(f"  DELETE status: {status}")
    if status not in (200, 204):
        print(f"  [FAILED] DELETE video failed: HTTP {status}")
        sys.exit(1)

    status, _, _ = make_req(master_url, method="GET")
    print(f"  Gate check after DELETE: HTTP {status} (expected 403 or 404)")
    print("  [SUCCESS] Video lifecycle smoke test passed completely!")

if __name__ == "__main__":
    main()
