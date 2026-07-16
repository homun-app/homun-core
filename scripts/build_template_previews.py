#!/usr/bin/env python3
"""Regenerate the committed preview assets of the bundled template packs.

Preview = TRUTH: every pack's preview.html/thumbnails are produced by the REAL
renderer (deck_render.render_html for "presentation" packs, doc_render.render_html
for "document" packs — dispatched per manifest.json "kind") on the pack's curated
example.json, so the catalog card shows exactly what make_deck/make_document will
produce. Assets are committed — the app and CI never need Chromium/poppler; this
script is a dev-time tool run only when a pack's design or example changes.

Usage:
    python3 scripts/build_template_previews.py [--only <slug>] [--skip-thumbnails]

Thumbnails need a Chromium binary (HOMUN_CHROMIUM_BIN overrides discovery) and
pdftoppm (poppler). Without them, run with --skip-thumbnails and regenerate the
PNGs on a machine that has both.
"""
import argparse
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES_DIR = os.path.join(REPO_ROOT, "templates")
DECK_RENDERER = os.path.join(REPO_ROOT, "runtimes", "contained-computer", "deck_render.py")
DOC_RENDERER = os.path.join(REPO_ROOT, "runtimes", "contained-computer", "doc_render.py")
MAX_THUMBNAILS = 6

CHROME_CANDIDATES = [
    os.environ.get("HOMUN_CHROMIUM_BIN"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome",
    "chromium",
    "chromium-browser",
]


def _load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_renderers():
    """Load both renderers so dispatch can pick one per pack by manifest "kind".

    doc_render imports design_tokens from its own directory (contained-computer/):
    exec_module alone doesn't add that dir to sys.path, so a plain load would
    raise ModuleNotFoundError on the sibling import. Insert it before loading."""
    contained_computer_dir = os.path.dirname(DOC_RENDERER)
    if contained_computer_dir not in sys.path:
        sys.path.insert(0, contained_computer_dir)
    return {
        "deck": _load_module("deck_render", DECK_RENDERER),
        "doc": _load_module("doc_render", DOC_RENDERER),
    }


def find_chromium():
    for candidate in CHROME_CANDIDATES:
        if not candidate:
            continue
        path = candidate if os.path.isabs(candidate) else shutil.which(candidate)
        if path and os.path.exists(path):
            return path
    return None


def run_tool(argv):
    """check=True alone buries the tool's stderr inside the exception; surface it
    so a Chromium/pdftoppm failure is actionable, not just "exit status N"."""
    try:
        subprocess.run(argv, check=True, capture_output=True)
    except subprocess.CalledProcessError as error:
        stderr = (error.stderr or b"").decode(errors="replace").strip()
        sys.exit(f"{argv[0]} failed (exit {error.returncode}):\n{stderr}")


def build_thumbnails(pack_dir, html_path):
    chromium = find_chromium()
    if not chromium or not shutil.which("pdftoppm"):
        sys.exit(
            "thumbnails need Chromium (set HOMUN_CHROMIUM_BIN) and pdftoppm (poppler); "
            "re-run with --skip-thumbnails to only rebuild preview.html"
        )
    thumbs = os.path.join(pack_dir, "thumbnails")
    shutil.rmtree(thumbs, ignore_errors=True)
    os.makedirs(thumbs)
    with tempfile.TemporaryDirectory() as tmp:
        pdf = os.path.join(tmp, "preview.pdf")
        run_tool(
            [chromium, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
             f"--print-to-pdf={pdf}", f"file://{os.path.abspath(html_path)}"])
        run_tool(
            ["pdftoppm", "-png", "-r", "96", "-f", "1", "-l", str(MAX_THUMBNAILS),
             pdf, os.path.join(tmp, "slide")])
        pages = sorted(p for p in os.listdir(tmp) if p.startswith("slide") and p.endswith(".png"))
        for index, page in enumerate(pages, start=1):
            shutil.copyfile(os.path.join(tmp, page),
                            os.path.join(thumbs, f"slide-{index:03d}.png"))
    return len(pages)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--only", help="rebuild a single pack slug")
    ap.add_argument("--skip-thumbnails", action="store_true")
    args = ap.parse_args()

    renderers = load_renderers()
    slugs = sorted(
        slug for slug in os.listdir(TEMPLATES_DIR)
        if os.path.isfile(os.path.join(TEMPLATES_DIR, slug, "example.json"))
    ) if os.path.isdir(TEMPLATES_DIR) else []
    if args.only:
        slugs = [slug for slug in slugs if slug == args.only]
    if not slugs:
        if args.only:
            sys.exit(f"pack '{args.only}' not found (or has no example.json) under {TEMPLATES_DIR}")
        else:
            sys.exit(f"no template packs with example.json under {TEMPLATES_DIR}")

    for slug in slugs:
        pack_dir = os.path.join(TEMPLATES_DIR, slug)
        with open(os.path.join(pack_dir, "example.json"), "r", encoding="utf-8") as fh:
            content = json.load(fh)
        with open(os.path.join(pack_dir, "manifest.json"), "r", encoding="utf-8") as fh:
            manifest = json.load(fh)
        # "document" packs render via doc_render (A4 blocks); everything else
        # (presentation, the only other kind today) keeps deck_render.
        renderer = renderers["doc"] if manifest.get("kind") == "document" else renderers["deck"]
        html = renderer.render_html(content, pack_dir)
        html_path = os.path.join(pack_dir, "preview.html")
        with open(html_path, "w", encoding="utf-8") as fh:
            fh.write(html)
        pages = 0 if args.skip_thumbnails else build_thumbnails(pack_dir, html_path)
        print(f"{slug}: preview.html ok, {pages} thumbnail(s)")


if __name__ == "__main__":
    main()
