#!/usr/bin/env python3
"""Prepare OpenCurtainLab release artefacts from the canonical web/manifest.json.

This script updates version references, regenerates the embedded setup portal,
and builds the self-contained WebUI release file. It keeps the generated HTML
readable and only removes standalone JavaScript comment lines.
"""
from __future__ import annotations

import argparse
import gzip
import html
import json
import os
import re
import sys
from pathlib import Path

VERSION_RE = re.compile(r'^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9_.-]+)?$')
APP_VERSION_RE = re.compile(r"const\s+APP_VERSION\s*=\s*['\"]([^'\"]+)['\"]")
FIRMWARE_VERSION_RE = re.compile(r'#define\s+FIRMWARE_VERSION\s+"([^"]+)"')
DEFAULT_LANG = 'en'
LANGS = ('de', 'en')


def discover_project_root(start: Path | None = None) -> Path:
    here = (start or Path(__file__)).resolve()
    for candidate in [here.parent, *here.parents]:
        if (candidate / 'OpenCurtainLab.ino').exists() and (candidate / 'web' / 'manifest.json').exists():
            return candidate
    raise FileNotFoundError('Could not locate OpenCurtainLab project root')


ROOT = discover_project_root()
WEB = ROOT / 'web'
MANIFEST_PATH = WEB / 'manifest.json'


def debug_enabled(explicit: bool = False) -> bool:
    return explicit or os.environ.get('OCL_DEBUG', '').lower() in {'1', 'true', 'yes', 'on'}


def debug_print(enabled: bool, message: str) -> None:
    if enabled:
        print(f'[release] {message}', file=sys.stderr)


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def resolve_project_path(value: str | Path) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path.resolve()
    return (ROOT / path).resolve()


def read_text(path: Path) -> str:
    return path.read_text(encoding='utf-8')


def read_json(path: Path) -> object:
    return json.loads(read_text(path))


def write_if_changed(path: Path, text: str) -> bool:
    if path.exists() and path.read_text(encoding='utf-8') == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')
    return True


def require_files(paths: list[tuple[Path, str]]) -> None:
    missing = [(path, label) for path, label in paths if not path.is_file()]
    if not missing:
        return
    lines = [
        'Required source files were not found.',
        f'Current working directory: {Path.cwd()}',
        f'Script path: {Path(__file__).resolve()}',
        f'Detected project root: {ROOT}',
        'Missing files:',
    ]
    lines.extend(f'  - {label}: {path}' for path, label in missing)
    raise FileNotFoundError('\n'.join(lines))


def read_manifest() -> dict:
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
    except json.JSONDecodeError as exc:
        raise ValueError(f'Invalid manifest JSON: {exc}') from exc
    if not isinstance(manifest, dict):
        raise ValueError('web/manifest.json must contain a JSON object')
    return manifest


def read_project_version(manifest: dict) -> str:
    version = str(manifest.get('projectVersion') or manifest.get('version') or '').strip()
    if not VERSION_RE.match(version):
        raise ValueError(f'Invalid or missing projectVersion in web/manifest.json: {version!r}')
    return version


def replace_once(path: Path, pattern: re.Pattern[str], repl: str, description: str) -> None:
    text = path.read_text(encoding='utf-8')
    if not pattern.search(text):
        raise ValueError(f'Could not find {description} in {rel(path)}')
    new_text = pattern.sub(repl, text, count=1)
    changed = write_if_changed(path, new_text)
    print(('updated' if changed else 'ok') + f' {rel(path)}')


def update_version_references(version: str) -> None:
    replace_once(
        ROOT / 'src' / 'Config.h',
        FIRMWARE_VERSION_RE,
        f'#define FIRMWARE_VERSION            "{version}"',
        'FIRMWARE_VERSION define',
    )
    replace_once(
        WEB / 'js' / 'state-storage.js',
        APP_VERSION_RE,
        f"const APP_VERSION = '{version}'",
        'APP_VERSION constant',
    )


def validate_manifest(manifest: dict, version: str) -> None:
    entries = manifest.get('entries')
    if not isinstance(entries, list):
        raise ValueError('web/manifest.json must contain an entries array')

    for entry in entries:
        if not isinstance(entry, dict):
            continue
        entry_version = str(entry.get('version', '')).strip()
        entry_url = str(entry.get('url', '')).strip()
        entry_match = str(entry.get('match') or entry.get('firmware') or '').strip()
        if entry_version == version and entry_url and entry_match:
            print('ok web/manifest.json contains a release entry for the built WebUI')
            return

    raise ValueError(
        f'No complete web/manifest.json entry with version {version!r}. '
        'Add or update match, version, and url manually.'
    )


# JavaScript cleanup --------------------------------------------------------

def strip_js_comment_lines(source: str) -> str:
    """Remove standalone JavaScript comment lines without touching executable code lines."""
    out: list[str] = []
    in_block_comment = False

    for line in source.splitlines():
        stripped = line.strip()

        if not stripped:
            out.append(line)
            continue

        if in_block_comment:
            if '*/' in stripped:
                in_block_comment = False
            continue

        if stripped.startswith('//'):
            continue

        if stripped.startswith(('/*', '/*!')):
            if '*/' not in stripped:
                in_block_comment = True
            continue

        if stripped.startswith(('*', '*/')):
            continue

        out.append(line)

    return '\n'.join(out)


def strip_js_comment_lines_from_html(markup: str) -> str:
    """Apply JS comment-line stripping to executable inline scripts in generated HTML."""
    script_re = re.compile(r'(<script\b(?P<attrs>[^>]*)>)(?P<body>.*?)(</script>)', re.I | re.S)

    def replace(match: re.Match[str]) -> str:
        attrs = match.group('attrs') or ''
        type_match = re.search(r'\btype=["\']?([^"\'\s>]+)', attrs, re.I)
        script_type = (type_match.group(1).lower() if type_match else 'text/javascript')
        if script_type not in {'text/javascript', 'application/javascript', 'module'}:
            return match.group(0)
        body = match.group('body')
        return match.group(1) + strip_js_comment_lines(body) + match.group(4)

    return script_re.sub(replace, markup)


# Setup portal build ---------------------------------------------------------

def format_c_array(data: bytes, values_per_line: int = 14) -> str:
    lines = []
    for i in range(0, len(data), values_per_line):
        chunk = data[i : i + values_per_line]
        lines.append('  ' + ', '.join(f'0x{byte:02x}' for byte in chunk))
    return ',\n'.join(lines)


def build_setup_portal(
    source: str | Path = 'src/setup_portal.html',
    output: str | Path = 'src/SetupPortalHtml.h',
    *,
    debug: bool = False,
) -> Path:
    source_path = resolve_project_path(source)
    output_path = resolve_project_path(output)
    debug_print(debug, f'setup source: {source_path} [{"ok" if source_path.is_file() else "missing"}]')
    debug_print(debug, f'setup output: {output_path}')
    require_files([(source_path, 'setup portal HTML')])

    source_text = source_path.read_text(encoding='utf-8')
    cleaned_text = strip_js_comment_lines_from_html(source_text)
    compressed = gzip.compress(cleaned_text.encode('utf-8'), compresslevel=9, mtime=0)
    header = f"""/*
 * Stores the gzip-compressed captive-portal HTML page used to configure WiFi credentials.
 * Generated by tools/release.py from {rel(source_path)}.
 * Source bytes: {len(source_path.read_bytes())}
 * Cleaned bytes: {len(cleaned_text.encode('utf-8'))}
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
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(header, encoding='utf-8')
    print(f'Generated {rel(output_path)}')
    print(f'Source:  {len(source_text.encode("utf-8"))} bytes')
    print(f'Cleaned: {len(cleaned_text.encode("utf-8"))} bytes')
    print(f'Gzip:    {len(compressed)} bytes')
    return output_path


# WebUI build ----------------------------------------------------------------

def discover_app_version() -> str:
    try:
        match = APP_VERSION_RE.search((WEB / 'js' / 'state-storage.js').read_text(encoding='utf-8'))
        if match:
            return match.group(1)
    except OSError:
        pass
    return '0.1.0'


def script_tag(script_id: str, mime_type: str, content: str) -> str:
    safe = content.replace('</script', '<\\/script')
    return f'<script id="{html.escape(script_id, quote=True)}" type="{html.escape(mime_type, quote=True)}">{safe}</script>'


def template_tag(template_id: str, content: str) -> str:
    safe = content.replace('</template', '&lt;/template')
    return f'<template id="{html.escape(template_id, quote=True)}">{safe}</template>'


def lookup_text(bundle: object, dotted_key: str, fallback: str = '') -> str:
    cur = bundle
    for part in dotted_key.split('.'):
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return fallback
    if cur is None or isinstance(cur, (dict, list)):
        return fallback
    return str(cur)


def apply_static_i18n_defaults(markup: str, bundle: object) -> str:
    translated_attrs = ('title', 'aria-label', 'placeholder', 'value', 'alt')

    def translate_tag_attrs(match: re.Match[str]) -> str:
        tag = match.group(0)
        pairs = re.findall(r'\sdata-i18n-([a-zA-Z-]+)="([^"]+)"', tag)
        for attr, key in pairs:
            if attr not in translated_attrs:
                continue
            value = html.escape(lookup_text(bundle, key, ''), quote=True)
            if not value:
                continue
            attr_re = re.compile(r'(?<![\w-])' + re.escape(attr) + r'="[^"]*"')
            replacement = f'{attr}="{value}"'
            if attr_re.search(tag):
                tag = attr_re.sub(replacement, tag, count=1)
            else:
                tag = re.sub(r'\s*/?>$', ' ' + replacement + tag[tag.rfind('>'):], tag, count=1)
        return tag

    markup = re.sub(r'<[^<>]+\bdata-i18n-[a-zA-Z-]+="[^"]+"[^<>]*>', translate_tag_attrs, markup)

    def translate_simple_text(match: re.Match[str]) -> str:
        open_tag = match.group('open')
        key = match.group('key')
        body = match.group('body')
        close_tag = match.group('close')
        value = lookup_text(bundle, key, html.unescape(body).strip())
        return open_tag + html.escape(value, quote=False) + close_tag

    simple_re = re.compile(
        r'(?P<open><(?P<tag>[a-zA-Z][\w:-]*)(?=[^>]*\bdata-i18n="(?P<key>[^"]+)")[^>]*>)'
        r'(?P<body>[^<>]*)'
        r'(?P<close></(?P=tag)>)',
        flags=re.S,
    )
    return simple_re.sub(translate_simple_text, markup)


def remove_dev_assets(markup: str) -> str:
    markup = re.sub(r'\n?\s*<link\b[^>]*data-ocl-asset="css"[^>]*>\s*', '\n', markup, flags=re.I)
    markup = re.sub(r'\n?\s*<script\b[^>]*data-ocl-asset="js"[^>]*>\s*</script>\s*', '\n', markup, flags=re.I)
    markup = re.sub(r'\n?\s*<script\b[^>]*id="ocl-source-config"[^>]*>.*?</script>\s*', '\n', markup, flags=re.I | re.S)
    return markup


def webui_paths() -> tuple[Path, Path, list[Path], Path, Path]:
    js_files = [
        WEB / 'js' / 'i18n.js',
        WEB / 'js' / 'utils.js',
        WEB / 'js' / 'state-storage.js',
        WEB / 'js' / 'device-settings.js',
        WEB / 'js' / 'navigation.js',
        WEB / 'js' / 'measurements-projects.js',
        WEB / 'js' / 'project-analysis.js',
        WEB / 'js' / 'charts.js',
        WEB / 'js' / 'backup-export.js',
        WEB / 'app.js',
    ]
    return WEB / 'index.html', WEB / 'app.css', js_files, WEB / 'i18n', WEB / 'tutorial'


def validate_webui_sources(debug: bool = False) -> None:
    index_path, css_path, js_files, i18n_dir, tutorial_dir = webui_paths()
    required: list[tuple[Path, str]] = [
        (index_path, 'WebUI template'),
        (css_path, 'WebUI CSS'),
        *[(path, f'JavaScript source {rel(path)}') for path in js_files],
        *[(i18n_dir / f'{lang}.json', f'i18n bundle {lang}') for lang in LANGS],
        *[(tutorial_dir / f'{lang}.html', f'tutorial fragment {lang}') for lang in LANGS],
    ]
    for path, label in required:
        debug_print(debug, f'{label}: {path} [{"ok" if path.is_file() else "missing"}]')
    require_files(required)


def build_webui(
    default_lang: str = DEFAULT_LANG,
    out_path: str | Path | None = None,
    *,
    debug: bool = False,
) -> Path:
    validate_webui_sources(debug)
    if default_lang not in LANGS:
        raise ValueError(f'Unsupported language: {default_lang}')
    if out_path is None:
        out_path = WEB / 'compiled' / f'compiled-v{discover_app_version()}.html'
    out_path = resolve_project_path(out_path)

    index_path, css_path, js_files, i18n_dir, tutorial_dir = webui_paths()
    debug_print(debug, f'webui default language: {default_lang}')
    debug_print(debug, f'webui output: {out_path}')

    template = read_text(index_path)
    css = read_text(css_path)
    js = strip_js_comment_lines('\n'.join(read_text(path) for path in js_files))

    i18n = {lang: read_json(i18n_dir / f'{lang}.json') for lang in LANGS}
    i18n_blob = json.dumps(i18n, ensure_ascii=False, separators=(',', ':'))

    tutorials = []
    for lang in LANGS:
        tutorial_html = read_text(tutorial_dir / f'{lang}.html')
        tutorials.append(template_tag(f'ocl-tutorial-{lang}', tutorial_html))

    html_out = remove_dev_assets(template)
    html_out = re.sub(r'<html\s+lang="[^"]*"', f'<html lang="{html.escape(default_lang)}"', html_out, count=1)
    html_out = apply_static_i18n_defaults(html_out, i18n[default_lang])
    html_out = html_out.replace('<!-- OCL_INLINE_CSS -->', '<style>\n' + css + '\n</style>')
    html_out = html_out.replace('<!-- OCL_INLINE_I18N -->', script_tag('ocl-i18n-all', 'application/json', i18n_blob))
    html_out = html_out.replace('<!-- OCL_INLINE_TUTORIALS -->', '\n'.join(tutorials))
    html_out = html_out.replace('<!-- OCL_INLINE_JS -->', '<script>\n' + js.replace('</script', '<\\/script') + '\n</script>')

    missing = [
        marker for marker in (
            'OCL_INLINE_CSS', 'OCL_INLINE_I18N', 'OCL_INLINE_TUTORIALS',
            'OCL_INLINE_JS'
        ) if marker in html_out
    ]
    if missing:
        raise RuntimeError('Unreplaced build markers: ' + ', '.join(missing))

    html_out = strip_js_comment_lines_from_html(html_out) + '\n'

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html_out, encoding='utf-8')
    print(f'Built {rel(out_path)}')
    return out_path


def build_release(args: argparse.Namespace) -> int:
    debug = debug_enabled(args.debug)
    debug_print(debug, f'cwd: {Path.cwd()}')
    debug_print(debug, f'script: {Path(__file__).resolve()}')
    debug_print(debug, f'project root: {ROOT}')

    manifest = read_manifest()
    version = read_project_version(manifest)
    print(f'OpenCurtainLab release version: {version}')
    update_version_references(version)
    build_setup_portal(debug=debug)
    expected = WEB / 'compiled' / f'compiled-v{version}.html'
    build_webui(args.lang, expected, debug=debug)
    if not expected.is_file():
        raise FileNotFoundError(f'Expected WebUI build output was not created: {expected}')
    print(f'ok {rel(expected)}')
    if not args.skip_manifest_check:
        validate_manifest(manifest, version)
    print('release artefacts are up to date')
    return 0


def build_setup_portal_cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Build the embedded setup portal header.')
    parser.add_argument('--source', default='src/setup_portal.html')
    parser.add_argument('--output', default='src/SetupPortalHtml.h')
    parser.add_argument('--debug', action='store_true')
    args = parser.parse_args(argv)
    build_setup_portal(args.source, args.output, debug=debug_enabled(args.debug))
    return 0


def build_webui_cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Build a self-contained OpenCurtainLab WebUI HTML file.')
    parser.add_argument('--lang', choices=LANGS, default=DEFAULT_LANG)
    parser.add_argument('--out', type=Path, default=None)
    parser.add_argument('--debug', action='store_true')
    args = parser.parse_args(argv)
    build_webui(args.lang, args.out, debug=debug_enabled(args.debug))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Prepare OpenCurtainLab release artefacts')
    parser.add_argument('--debug', action='store_true', help='print resolved paths and source-file checks')
    parser.add_argument('--skip-manifest-check', action='store_true', help='do not validate web/manifest.json release entry')
    parser.add_argument('--lang', choices=LANGS, default=DEFAULT_LANG, help='initial language for the compiled WebUI')
    return build_release(parser.parse_args(argv))


if __name__ == '__main__':
    raise SystemExit(main())
