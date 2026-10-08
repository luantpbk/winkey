"""Synthetic HTTP fixture; no external requests, credentials or journals."""
import json
import os
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

video = json.loads((Path(__file__).parent / "mock-video.json").read_text())
summary = {k: video[k] for k in ["id", "title", "owner", "duration_ms", "view_count", "published_at"]}
summary["thumbnail_url"] = video["playback"]["thumbnail_url"]
mode = os.environ["PROBE_MODE"]
segment_requests = 0
paths = []


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        global segment_requests
        status = 200
        if self.path == "/_probe":
            body = json.dumps({"paths": paths, "segment_requests": segment_requests})
        else:
            paths.append(self.path)
            if self.path.startswith("/v1/videos?"):
                body = json.dumps({"items": [] if mode == "empty" else [summary], "next_cursor": None})
            elif self.path == "/v1/videos/" + video["id"]:
                body = json.dumps(video)
            elif self.path.endswith("master.m3u8"):
                body = "#EXTM3U\n" if mode == "invalid-master" else "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\n480p/index.m3u8\n"
            elif self.path.endswith("index.m3u8"):
                body = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2.0,\nseg_00000.m4s\n#EXT-X-ENDLIST\n'
            elif self.path.endswith(".m4s"):
                segment_requests += 1
                if (mode == "first-500" and segment_requests == 1) or (mode == "remaining-500" and segment_requests > 1):
                    status = 500
                body = "fixture bytes"
            else:
                status, body = 404, "missing"
        raw = body.encode()
        self.send_response(status)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


# k6 shares this isolated container's network namespace; no host port published.
server = HTTPServer(("127.0.0.1", 17878), Handler)
print("PROBE_READY", flush=True)
server.serve_forever()
