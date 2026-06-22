#!/usr/bin/env python3
"""Compatibility wrapper. Release builds are implemented in tools/release.py."""
from __future__ import annotations
from release import build_webui_cli

if __name__ == "__main__":
    raise SystemExit(build_webui_cli())
