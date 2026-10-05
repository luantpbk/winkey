import urllib.request
import json
import ssl

ctx = ssl._create_unverified_context()
req = urllib.request.Request(
    "https://winkey.vn/v1/auth/login",
    data=json.dumps({"email": "sec1-tester@winkey.vn", "password": "P@ssw0rd123_sec1"}).encode(),
    headers={"Content-Type": "application/json"}
)
with urllib.request.urlopen(req, context=ctx) as r:
    tok = json.loads(r.read())["access_token"]

del_req = urllib.request.Request(
    "https://winkey.vn/v1/videos/01a10c49-d30d-7b84-85bf-8288bf200a8d",
    headers={"Authorization": f"Bearer {tok}"},
    method="DELETE"
)
with urllib.request.urlopen(del_req, context=ctx) as r:
    print("DELETE status:", r.status)
