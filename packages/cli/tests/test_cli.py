"""CLI tests. Spin up a tiny HTTP server that echoes the POST body so we can
verify what `report-bug` sends without depending on a real backend."""

from __future__ import annotations

import json
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from bug_report_cli import main


class _CaptureHandler(BaseHTTPRequestHandler):
    captured: list[dict] = []
    status_code = 201
    response_body = '{"id": "bug-20260101-000000-aaaaaa"}'

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length).decode("utf-8") if length else ""
        try:
            self.captured.append(json.loads(body))
        except json.JSONDecodeError:
            self.captured.append({"_raw": body})
        self.send_response(self.status_code)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(self.response_body.encode("utf-8"))

    def log_message(self, *args):  # noqa: D401
        return  # silence


@pytest.fixture
def capture_server():
    _CaptureHandler.captured = []
    _CaptureHandler.status_code = 201
    _CaptureHandler.response_body = '{"id": "bug-20260101-000000-aaaaaa"}'
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    server = ThreadingHTTPServer(("127.0.0.1", port), _CaptureHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    try:
        yield {"url": f"http://127.0.0.1:{port}/api/bugs", "handler": _CaptureHandler}
    finally:
        server.shutdown()
        server.server_close()


def test_basic_post(capture_server, capsys):
    rc = main(["-t", "ci flaky", "-d", "test_login fails 1/5 runs", "--url", capture_server["url"]])
    assert rc == 0
    posted = capture_server["handler"].captured[0]
    assert posted["title"] == "ci flaky"
    assert posted["details"] == "test_login fails 1/5 runs"
    assert "bug" in posted["tags"]
    assert posted["addedBy"] == "agent"  # CLI default


def test_extra_tags_passed_through(capture_server):
    main(["-t", "x", "-d", "y", "--tag", "perf", "--tag", "critical", "--url", capture_server["url"]])
    posted = capture_server["handler"].captured[0]
    assert "perf" in posted["tags"] and "critical" in posted["tags"]


def test_actor_email_from_env(monkeypatch, capture_server):
    monkeypatch.setenv("BUG_REPORTER_EMAIL", "ken@example.com")
    main(["-t", "x", "-d", "y", "--url", capture_server["url"]])
    assert capture_server["handler"].captured[0]["actorEmail"] == "ken@example.com"


def test_transcript_file(tmp_path, capture_server):
    transcript = [{"userMessage": "hi", "assistantResponse": "hello"}]
    fp = tmp_path / "t.json"
    fp.write_text(json.dumps(transcript))
    main(["-t", "x", "-d", "y", "--transcript-file", str(fp), "--url", capture_server["url"]])
    posted = capture_server["handler"].captured[0]
    assert posted["transcript"] == transcript


def test_empty_details_exits_2(capture_server, monkeypatch):
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    rc = main(["-t", "", "-d", "   ", "--url", capture_server["url"]])
    assert rc == 2


def test_server_error_returns_1(capture_server, capsys):
    capture_server["handler"].status_code = 500
    capture_server["handler"].response_body = '{"error":"boom"}'
    rc = main(["-t", "x", "-d", "y", "--url", capture_server["url"]])
    assert rc == 1
    err = capsys.readouterr().err
    assert "HTTP 500" in err


def test_unreachable_url_returns_1(capsys):
    rc = main(["-t", "x", "-d", "y", "--url", "http://127.0.0.1:1/api/bugs"])
    assert rc == 1
    assert "cannot reach" in capsys.readouterr().err
