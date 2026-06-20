#!/usr/bin/env python3
"""
Build the OpenCurtainLab WebUI into one self-contained HTML file.

Development source layout:
  web/index.html
  web/app.css
  web/js/*.js
  web/app.js
  web/i18n/de.json
  web/i18n/en.json
  web/tutorial/de.html
  web/tutorial/en.html

Output:
  web/compiled/compiled-v<APP_VERSION>.html

The generated file has no CSS/JS/i18n/tutorial asset dependencies and can be
opened locally with file:// or downloaded from a release page. By default the
builder strips source comments and applies conservative whitespace compaction.

Debugging:
  python3 tools/build_webui.py --debug
  OCL_DEBUG=1 python3 tools/build_webui.py
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
from pathlib import Path

DEFAULT_LANG = 'en'
LANGS = ('de', 'en')


def discover_project_root(start: Path | None = None) -> Path:
    """Find the repository root independent of the current working directory."""
    here = (start or Path(__file__)).resolve()
    candidates = [here.parent, *here.parents]
    for candidate in candidates:
        if (candidate / 'OpenCurtainLab.ino').exists() and (candidate / 'web' / 'index.html').exists():
            return candidate
    return here.parents[1]


ROOT = discover_project_root()
WEB = ROOT / 'web'

default_version_re = re.compile(r"const\s+APP_VERSION\s*=\s*['\"]([^'\"]+)['\"]")

def discover_app_version() -> str:
    try:
        text = (WEB / 'js' / 'state-storage.js').read_text(encoding='utf-8')
        match = default_version_re.search(text)
        if match:
            return match.group(1)
    except OSError:
        pass
    return '0.1.0'


DEFAULT_OUT = WEB / 'compiled' / f'compiled-v{discover_app_version()}.html'


def debug_enabled(explicit: bool = False) -> bool:
    return explicit or os.environ.get('OCL_DEBUG', '').lower() in {'1', 'true', 'yes', 'on'}


def debug_print(enabled: bool, message: str) -> None:
    if enabled:
        print(f'[build_webui] {message}', file=sys.stderr)


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


def require_files(paths: list[tuple[Path, str]]) -> None:
    missing = [(path, label) for path, label in paths if not path.is_file()]
    if not missing:
        return
    lines = [
        'Required WebUI source files were not found.',
        f'Current working directory: {Path.cwd()}',
        f'Script path: {Path(__file__).resolve()}',
        f'Detected project root: {ROOT}',
        'Missing files:',
    ]
    lines.extend(f'  - {label}: {path}' for path, label in missing)
    raise FileNotFoundError('\n'.join(lines))


def read_text(path: Path) -> str:
    return path.read_text(encoding='utf-8')


def read_json(path: Path) -> object:
    return json.loads(read_text(path))


def script_tag(script_id: str, mime_type: str, content: str) -> str:
    # Escape closing script tags so embedded HTML/JSON cannot terminate the script element.
    safe = content.replace('</script', '<\\/script')
    return f'<script id="{script_id}" type="{mime_type}">{safe}</script>'


def strip_js_comments(source: str) -> str:
    r"""Remove source-level JavaScript comments without touching code literals.

    This intentionally removes only whole-line // comments and block comments that
    start on their own line. It is conservative: regex literals such as
    /^https?:\/\// stay intact, and inline explanatory comments may remain if
    removing them could change parsing.
    """
    out: list[str] = []
    in_block = False

    for line in source.splitlines():
        stripped = line.lstrip()

        if in_block:
            if '*/' in stripped:
                in_block = False
                after = stripped.split('*/', 1)[1].strip()
                if after:
                    out.append(after)
            continue

        if stripped.startswith('/*'):
            if '*/' not in stripped:
                in_block = True
                continue
            after = stripped.split('*/', 1)[1].strip()
            if after:
                out.append(after)
            continue

        if stripped.startswith('//'):
            continue

        out.append(line)

    return '\n'.join(out)


def minify_js(source: str) -> str:
    """Apply conservative JavaScript minification suitable for inline builds."""
    source = strip_js_comments(source)
    lines = [line.rstrip() for line in source.splitlines()]
    compact: list[str] = []
    previous_blank = False
    for line in lines:
        blank = not line.strip()
        if blank:
            if not previous_blank:
                compact.append('')
            previous_blank = True
        else:
            compact.append(line)
            previous_blank = False
    return '\n'.join(compact).strip() + '\n'


def minify_css(source: str) -> str:
    """Remove CSS comments and collapse common whitespace without changing selectors."""
    source = re.sub(r'/\*.*?\*/', '', source, flags=re.S)
    source = re.sub(r'\s+', ' ', source)
    source = re.sub(r'\s*([{}:;,>])\s*', r'\1', source)
    source = source.replace(';}', '}')
    return source.strip()


def minify_html_markup(source: str, *, preserve_build_markers: bool = False) -> str:
    """Remove HTML comments and inter-tag whitespace from templates/fragments."""
    def keep_or_drop(match: re.Match[str]) -> str:
        body = match.group(1)
        if preserve_build_markers and 'OCL_INLINE_' in body:
            return match.group(0)
        return ''

    source = re.sub(r'<!--(.*?)-->', keep_or_drop, source, flags=re.S)
    source = re.sub(r'>\s+<', '><', source)
    source = '\n'.join(line.strip() for line in source.splitlines() if line.strip())
    return source.strip() + '\n'


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
    """Pre-render simple static i18n defaults for the compiled HTML."""
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
    # The source HTML loads external files for development. The compiled HTML must not.
    markup = re.sub(r'\n?\s*<link\b[^>]*data-ocl-asset="css"[^>]*>\s*', '\n', markup, flags=re.I)
    markup = re.sub(r'\n?\s*<script\b[^>]*data-ocl-asset="js"[^>]*>\s*</script>\s*', '\n', markup, flags=re.I)
    markup = re.sub(r'\n?\s*<script\b[^>]*id="ocl-source-config"[^>]*>.*?</script>\s*', '\n', markup, flags=re.I | re.S)
    return markup


def webui_paths() -> tuple[Path, Path, list[Path], Path, Path]:
    index_path = WEB / 'index.html'
    css_path = WEB / 'app.css'
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
    return index_path, css_path, js_files, WEB / 'i18n', WEB / 'tutorial'


def validate_sources(debug: bool = False) -> None:
    index_path, css_path, js_files, i18n_dir, tutorial_dir = webui_paths()
    required: list[tuple[Path, str]] = [
        (index_path, 'WebUI template'),
        (css_path, 'WebUI CSS'),
        *[(path, f'JavaScript source {rel(path)}') for path in js_files],
        *[(i18n_dir / f'{lang}.json', f'i18n bundle {lang}') for lang in LANGS],
        *[(tutorial_dir / f'{lang}.html', f'tutorial fragment {lang}') for lang in LANGS],
    ]
    debug_print(debug, f'cwd: {Path.cwd()}')
    debug_print(debug, f'script: {Path(__file__).resolve()}')
    debug_print(debug, f'project root: {ROOT}')
    for path, label in required:
        debug_print(debug, f'{label}: {path} [{"ok" if path.is_file() else "missing"}]')
    require_files(required)


def build(default_lang: str, out_path: Path, *, minify: bool = True, debug: bool = False) -> Path:
    validate_sources(debug)
    index_path, css_path, js_files, i18n_dir, tutorial_dir = webui_paths()

    debug_print(debug, f'default language: {default_lang}')
    debug_print(debug, f'minify: {minify}')
    debug_print(debug, f'output: {out_path}')

    template = read_text(index_path)
    css = read_text(css_path)
    js_parts = []
    for path in js_files:
        debug_print(debug, f'embed JS: {rel(path)} ({path.stat().st_size} bytes)')
        js_parts.append(read_text(path))
    js = '\n'.join(js_parts)

    if minify:
        css = minify_css(css)
        js = minify_js(js)

    i18n = {lang: read_json(i18n_dir / f'{lang}.json') for lang in LANGS}
    i18n_blob = json.dumps(i18n, ensure_ascii=False, separators=(',', ':'))

    tutorials = []
    for lang in LANGS:
        path = tutorial_dir / f'{lang}.html'
        tutorial_html = read_text(path)
        if minify:
            tutorial_html = minify_html_markup(tutorial_html)
        tutorials.append(script_tag(f'ocl-tutorial-{lang}', 'text/html', tutorial_html))

    html_out = remove_dev_assets(template)
    if minify:
        html_out = minify_html_markup(html_out, preserve_build_markers=True)
    html_out = re.sub(r'<html\s+lang="[^"]*"', f'<html lang="{html.escape(default_lang)}"', html_out, count=1)
    html_out = apply_static_i18n_defaults(html_out, i18n[default_lang])
    html_out = html_out.replace('<!-- OCL_INLINE_CSS -->', '<style>\n' + css + '\n</style>')
    html_out = html_out.replace('<!-- OCL_INLINE_I18N -->', script_tag('ocl-i18n-all', 'application/json', i18n_blob))
    html_out = html_out.replace('<!-- OCL_INLINE_TUTORIALS -->', '\n'.join(tutorials))
    html_out = html_out.replace('<!-- OCL_INLINE_MANUALS -->', '\n'.join(tutorials))
    html_out = html_out.replace('<!-- OCL_INLINE_JS -->', '<script>\n' + js.replace('</script', '<\\/script') + '\n</script>')

    missing = [
        marker for marker in (
            'OCL_INLINE_CSS', 'OCL_INLINE_I18N', 'OCL_INLINE_TUTORIALS',
            'OCL_INLINE_MANUALS', 'OCL_INLINE_JS'
        ) if marker in html_out
    ]
    if missing:
        raise RuntimeError('Unreplaced build markers: ' + ', '.join(missing))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(html_out, encoding='utf-8')
    debug_print(debug, f'wrote {out_path} ({out_path.stat().st_size} bytes)')
    return out_path


def main() -> int:
    parser = argparse.ArgumentParser(description='Build a self-contained OpenCurtainLab WebUI HTML file.')
    parser.add_argument('--lang', choices=LANGS, default=DEFAULT_LANG, help='Initial language of the generated HTML. Defaults to English for the single-file release build.')
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT, help='Output HTML path. Relative paths are resolved from the project root.')
    parser.add_argument('--no-minify', action='store_true', help='Embed source files without comment stripping or whitespace compaction.')
    parser.add_argument('--debug', action='store_true', help='Print resolved paths and source-file checks before building.')
    args = parser.parse_args()

    debug = debug_enabled(args.debug)
    out_arg = args.out if args.out.is_absolute() else ROOT / args.out
    out = build(args.lang, out_arg.resolve(), minify=not args.no_minify, debug=debug)
    print(f'Built {rel(out)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
