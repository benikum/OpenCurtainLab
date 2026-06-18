#!/usr/bin/env python3
"""
Generate the embedded Wi-Fi setup portal header.

The source HTML stays readable in src/setup_portal.html. This tool removes
comments and unnecessary whitespace, gzip-compresses the result, and writes
src/SetupPortalHtml.h as a PROGMEM byte array.
"""

from __future__ import annotations

import argparse
import gzip
import os
import re
import sys
from pathlib import Path


IDENT_CHARS = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$")
PUNCTUATION = set("{}[]();,:?=+-*/%<>!&|^~")


def strip_js_comments(source: str) -> str:
    """Remove JavaScript line and block comments while preserving quoted strings."""
    out: list[str] = []
    i = 0
    state = "code"
    quote = ""
    escape = False

    while i < len(source):
        ch = source[i]
        nxt = source[i + 1] if i + 1 < len(source) else ""

        if state == "code":
            if ch in ("'", '"', "`"):
                state = "string"
                quote = ch
                out.append(ch)
            elif ch == "/" and nxt == "/":
                state = "line_comment"
                i += 1
            elif ch == "/" and nxt == "*":
                state = "block_comment"
                i += 1
            else:
                out.append(ch)
        elif state == "string":
            out.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == quote:
                state = "code"
        elif state == "line_comment":
            if ch in "\r\n":
                out.append("\n")
                state = "code"
        elif state == "block_comment":
            if ch == "*" and nxt == "/":
                state = "code"
                i += 1

        i += 1

    return "".join(out)


def collapse_js_whitespace(source: str) -> str:
    """Collapse JavaScript whitespace without joining identifiers incorrectly."""
    out: list[str] = []
    i = 0
    state = "code"
    quote = ""
    escape = False
    pending_space = False

    def last_code_char() -> str:
        return out[-1] if out else ""

    while i < len(source):
        ch = source[i]

        if state == "code":
            if ch.isspace():
                pending_space = True
            elif ch in ("'", '"', "`"):
                if pending_space and last_code_char() in IDENT_CHARS:
                    out.append(" ")
                pending_space = False
                state = "string"
                quote = ch
                out.append(ch)
            else:
                prev = last_code_char()
                if pending_space and prev in IDENT_CHARS and ch in IDENT_CHARS:
                    out.append(" ")
                if ch in PUNCTUATION and out and out[-1] == " ":
                    out.pop()
                if ch not in PUNCTUATION or ch == "/":
                    out.append(ch)
                else:
                    out.append(ch)
                pending_space = False
        else:
            out.append(ch)
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == quote:
                state = "code"

        i += 1

    return "".join(out).strip()


def minify_js(source: str) -> str:
    """Minify JavaScript used by the setup portal."""
    return collapse_js_whitespace(strip_js_comments(source))


def minify_css(source: str) -> str:
    """Minify CSS by removing comments and compacting punctuation whitespace."""
    source = re.sub(r"/\*.*?\*/", "", source, flags=re.S)
    source = re.sub(r"\s+", " ", source)
    source = re.sub(r"\s*([{}:;,>])\s*", r"\1", source)
    source = source.replace(";}" , "}")
    return source.strip()


def minify_html(source: str) -> str:
    """Minify HTML while minifying embedded CSS and JavaScript blocks."""
    source = re.sub(r"<!--.*?-->", "", source, flags=re.S)

    def replace_style(match: re.Match[str]) -> str:
        return f"<style>{minify_css(match.group(1))}</style>"

    def replace_script(match: re.Match[str]) -> str:
        return f"<script>{minify_js(match.group(1))}</script>"

    source = re.sub(r"<style[^>]*>(.*?)</style>", replace_style, source, flags=re.S | re.I)
    source = re.sub(r"<script[^>]*>(.*?)</script>", replace_script, source, flags=re.S | re.I)
    source = re.sub(r">\s+<", "><", source)
    source = re.sub(r"\s+", " ", source)
    return source.strip()


def format_c_array(data: bytes, values_per_line: int = 14) -> str:
    """Format bytes as a compact C array initializer."""
    lines = []
    for i in range(0, len(data), values_per_line):
        chunk = data[i : i + values_per_line]
        lines.append("  " + ", ".join(f"0x{byte:02x}" for byte in chunk))
    return ",\n".join(lines)


def write_header(source_path: Path, source_label: str, output_path: Path, minified: bytes, compressed: bytes) -> None:
    """Write the gzip-compressed portal as a PROGMEM header."""
    header = f"""/*
 * Stores the gzip-compressed captive-portal HTML page used to configure WiFi credentials.
 * Generated by tools/build_setup_portal.py from {source_label}.
 * Source bytes: {len(source_path.read_bytes())}
 * Minified bytes: {len(minified)}
 * Gzip bytes: {len(compressed)}
 */

#pragma once
#include <pgmspace.h>
#include <stddef.h>
#include <stdint.h>

static const uint8_t SETUP_PORTAL_HTML_GZ[] PROGMEM = {{
{format_c_array(compressed)}
}};

static constexpr size_t SETUP_PORTAL_HTML_GZ_LEN = sizeof(SETUP_PORTAL_HTML_GZ);
"""
    output_path.write_text(header, encoding="utf-8")


def discover_project_root(start: Path | None = None) -> Path:
    """Find the repository root independent of the current working directory."""
    here = (start or Path(__file__)).resolve()
    candidates = [here.parent, *here.parents]
    for candidate in candidates:
        if (candidate / "OpenCurtainLab.ino").exists() and (candidate / "src").is_dir():
            return candidate
    return here.parents[1]


def debug_enabled(explicit: bool = False) -> bool:
    return explicit or os.environ.get("OCL_DEBUG", "").lower() in {"1", "true", "yes", "on"}


def debug_print(enabled: bool, message: str) -> None:
    if enabled:
        print(f"[build_setup_portal] {message}", file=sys.stderr)


def resolve_project_path(root: Path, value: str | Path) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path.resolve()
    return (root / path).resolve()


def rel_to_root(root: Path, path: Path) -> str:
    try:
        return path.resolve().relative_to(root).as_posix()
    except ValueError:
        return str(path)


def main() -> int:
    """Parse arguments and regenerate SetupPortalHtml.h."""
    parser = argparse.ArgumentParser(description="Build the embedded setup portal header.")
    parser.add_argument("--source", default="src/setup_portal.html", help="Readable setup portal HTML source. Relative paths are resolved from the project root.")
    parser.add_argument("--output", default="src/SetupPortalHtml.h", help="Generated PROGMEM header. Relative paths are resolved from the project root.")
    parser.add_argument("--debug", action="store_true", help="Print resolved paths and source-file checks before building.")
    args = parser.parse_args()

    project_root = discover_project_root()
    debug = debug_enabled(args.debug)
    source_path = resolve_project_path(project_root, args.source)
    output_path = resolve_project_path(project_root, args.output)

    debug_print(debug, f"cwd: {Path.cwd()}")
    debug_print(debug, f"script: {Path(__file__).resolve()}")
    debug_print(debug, f"project root: {project_root}")
    debug_print(debug, f"source: {source_path} [{'ok' if source_path.is_file() else 'missing'}]")
    debug_print(debug, f"output: {output_path}")

    if not source_path.is_file():
        raise FileNotFoundError(
            "Setup portal source file was not found.\n"
            f"Current working directory: {Path.cwd()}\n"
            f"Script path: {Path(__file__).resolve()}\n"
            f"Detected project root: {project_root}\n"
            f"Expected source: {source_path}"
        )

    source = source_path.read_text(encoding="utf-8")
    minified = minify_html(source).encode("utf-8")
    compressed = gzip.compress(minified, compresslevel=9, mtime=0)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    write_header(source_path, rel_to_root(project_root, source_path), output_path, minified, compressed)
    print(f"Generated {rel_to_root(project_root, output_path)}")
    print(f"Source:   {len(source.encode('utf-8'))} bytes")
    print(f"Minified: {len(minified)} bytes")
    print(f"Gzip:     {len(compressed)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
