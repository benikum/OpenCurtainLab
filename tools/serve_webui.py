#!/usr/bin/env python3
"""Serve the OpenCurtainLab raw Web UI for local development.

Run from any directory:
  python3 tools/serve_webui.py

Then open:
  http://127.0.0.1:8000/?lang=de
  http://127.0.0.1:8000/?lang=en

Debugging:
  python3 tools/serve_webui.py --debug
  OCL_DEBUG=1 python3 tools/serve_webui.py
"""
from __future__ import annotations

import argparse
import http.server
import os
import socketserver
import sys
from functools import partial
from pathlib import Path


def discover_project_root(start: Path | None = None) -> Path:
    """Find the repository root independent of the current working directory."""
    here = (start or Path(__file__)).resolve()
    candidates = [here.parent, *here.parents]
    for candidate in candidates:
        if (candidate / "OpenCurtainLab.ino").exists() and (candidate / "web" / "index.html").exists():
            return candidate
    return here.parents[1]


def debug_enabled(explicit: bool = False) -> bool:
    return explicit or os.environ.get("OCL_DEBUG", "").lower() in {"1", "true", "yes", "on"}


def debug_print(enabled: bool, message: str) -> None:
    if enabled:
        print(f"[serve_webui] {message}", file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description="Serve web/ for OpenCurtainLab Web UI development")
    parser.add_argument("--host", default="127.0.0.1", help="Bind address, default: 127.0.0.1")
    parser.add_argument("--port", type=int, default=8000, help="Port, default: 8000")
    parser.add_argument("--debug", action="store_true", help="Print resolved paths before starting the server.")
    args = parser.parse_args()

    debug = debug_enabled(args.debug)
    project_root = discover_project_root()
    root = project_root / "web"
    index = root / "index.html"

    debug_print(debug, f"cwd: {Path.cwd()}")
    debug_print(debug, f"script: {Path(__file__).resolve()}")
    debug_print(debug, f"project root: {project_root}")
    debug_print(debug, f"web root: {root} [{'ok' if root.is_dir() else 'missing'}]")
    debug_print(debug, f"index: {index} [{'ok' if index.is_file() else 'missing'}]")

    if not root.is_dir() or not index.is_file():
        raise FileNotFoundError(
            "WebUI source directory was not found.\n"
            f"Current working directory: {Path.cwd()}\n"
            f"Script path: {Path(__file__).resolve()}\n"
            f"Detected project root: {project_root}\n"
            f"Expected web root: {root}\n"
            f"Expected index: {index}"
        )

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
