#!/usr/bin/env python3
"""Serve the OpenCurtainLab raw Web UI for local development.

Run from the repository root:
  python3 tools/serve_webui.py

Then open:
  http://127.0.0.1:8000/?lang=de
  http://127.0.0.1:8000/?lang=en
"""
from __future__ import annotations

import argparse
import http.server
import socketserver
from functools import partial
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve web/ for OpenCurtainLab Web UI development")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address, default: 127.0.0.1")
    parser.add_argument("--port", type=int, default=8000, help="Port, default: 8000")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[1] / "web"
    handler = partial(http.server.SimpleHTTPRequestHandler, directory=str(root))

    class ReusableTCPServer(socketserver.TCPServer):
        allow_reuse_address = True

    with ReusableTCPServer((args.host, args.port), handler) as httpd:
        print(f"Serving OpenCurtainLab Web UI from {root}")
        print(f"German:  http://{args.host}:{args.port}/?lang=de")
        print(f"English: http://{args.host}:{args.port}/?lang=en")
        httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
