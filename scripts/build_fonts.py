#!/usr/bin/env python3
"""Bundle curated Google fonts and their actual license metadata from @fontsource.

Generate the font files plus the Python and TypeScript manifests consumed by the
contained renderer and desktop UI. ONE source of truth for typography — run it
whenever the curated set changes. Idempotent.
"""
import base64, json, shutil
from pathlib import Path

# display name -> (@fontsource slug, [weights], category). Latin subset, 400+700.
CURATED = {
    # sans
    "Inter": ("inter", [400, 700], "sans"),
    "Roboto": ("roboto", [400, 700], "sans"),
    "Open Sans": ("open-sans", [400, 700], "sans"),
    "Lato": ("lato", [400, 700], "sans"),
    "Work Sans": ("work-sans", [400, 700], "sans"),
    "Montserrat": ("montserrat", [400, 700], "sans"),
    "Poppins": ("poppins", [400, 700], "sans"),
    "Source Sans 3": ("source-sans-3", [400, 700], "sans"),
    "Nunito Sans": ("nunito-sans", [400, 700], "sans"),
    "Mulish": ("mulish", [400, 700], "sans"),
    "Manrope": ("manrope", [400, 700], "sans"),
    "DM Sans": ("dm-sans", [400, 700], "sans"),
    "Figtree": ("figtree", [400, 700], "sans"),
    "Plus Jakarta Sans": ("plus-jakarta-sans", [400, 700], "sans"),
    "IBM Plex Sans": ("ibm-plex-sans", [400, 700], "sans"),
    "Archivo": ("archivo", [400, 700], "sans"),
    "Rubik": ("rubik", [400, 700], "sans"),
    "Karla": ("karla", [400, 700], "sans"),
    "Space Grotesk": ("space-grotesk", [400, 700], "sans"),
    "Sora": ("sora", [400, 700], "sans"),
    # serif
    "Source Serif 4": ("source-serif-4", [400, 700], "serif"),
    "Lora": ("lora", [400, 700], "serif"),
    "Merriweather": ("merriweather", [400, 700], "serif"),
    "Playfair Display": ("playfair-display", [400, 700], "serif"),
    "PT Serif": ("pt-serif", [400, 700], "serif"),
    "Libre Baskerville": ("libre-baskerville", [400, 700], "serif"),
    "EB Garamond": ("eb-garamond", [400, 700], "serif"),
    "Crimson Pro": ("crimson-pro", [400, 700], "serif"),
    "Spectral": ("spectral", [400, 700], "serif"),
    "Fraunces": ("fraunces", [400, 700], "serif"),
    # slab
    "Bitter": ("bitter", [400, 700], "slab"),
    "Roboto Slab": ("roboto-slab", [400, 700], "slab"),
    "Zilla Slab": ("zilla-slab", [400, 700], "slab"),
    # mono
    "JetBrains Mono": ("jetbrains-mono", [400, 700], "mono"),
    "IBM Plex Mono": ("ibm-plex-mono", [400, 700], "mono"),
    "Space Mono": ("space-mono", [400, 700], "mono"),
}

ROOT = Path(__file__).resolve().parent.parent
NODE = ROOT / "apps/desktop/node_modules/@fontsource"
FONTS_DIR = ROOT / "runtimes/contained-computer/fonts"
PY_MANIFEST = ROOT / "runtimes/contained-computer/fonts_manifest.py"
TS_MANIFEST = ROOT / "apps/desktop/src/components/fontsManifest.ts"

def slug(name): return name.lower().replace(" ", "-")

def _fonts_py_literal(py):
    # json.dumps() would stringify the int weight keys (JSON object keys must be
    # strings), breaking the documented dict[int, str] contract (and the int-key
    # lookups callers do, e.g. FONTS["Inter"][400]) — emit real Python int keys
    # instead of routing the weight sub-dicts through JSON.
    lines = ["{"]
    families = list(py.items())
    for fi, (family, weights) in enumerate(families):
        lines.append(f"    {json.dumps(family, ensure_ascii=False)}: {{")
        items = list(weights.items())
        for wi, (w, fname) in enumerate(items):
            comma = "," if wi < len(items) - 1 else ""
            lines.append(f"        {w}: {json.dumps(fname, ensure_ascii=False)}{comma}")
        comma = "," if fi < len(families) - 1 else ""
        lines.append(f"    }}{comma}")
    lines.append("}")
    return "\n".join(lines)

def _repository_url(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        url = value.get("url", "")
        directory = value.get("directory")
        return f"{url}#{directory}" if directory else url
    return ""


def _legal_files(package_dir):
    prefixes = ("license", "copying", "notice", "copyright")
    return sorted(
        path
        for path in package_dir.iterdir()
        if path.is_file() and path.name.lower().startswith(prefixes)
    )


def bundle_fonts(node_root, fonts_dir, py_manifest, ts_manifest, curated=CURATED):
    node_root = Path(node_root)
    fonts_dir = Path(fonts_dir)
    py_manifest = Path(py_manifest)
    ts_manifest = Path(ts_manifest)
    fonts_dir.mkdir(parents=True, exist_ok=True)
    for existing in fonts_dir.glob("*.woff2"):
        existing.unlink()
    licenses_dir = fonts_dir / "licenses"
    if licenses_dir.exists():
        shutil.rmtree(licenses_dir)
    licenses_dir.mkdir(parents=True)

    py = {}         # family -> {weight: filename}
    ts_faces = {}   # family -> [{weight, dataUri}]
    categories = {} # family -> category ("sans"|"serif"|"slab"|"mono")
    notices = []
    license_manifest = []
    copied_packages = set()
    for family, (pkg, weights, category) in curated.items():
        package_dir = node_root / pkg
        package_json = package_dir / "package.json"
        if not package_json.exists():
            raise SystemExit(f"missing Fontsource package metadata: {package_json}")
        metadata = json.loads(package_json.read_text())
        license_id = metadata.get("license")
        if not isinstance(license_id, str) or not license_id.strip():
            raise SystemExit(f"missing Fontsource license declaration: {package_json}")
        legal_files = _legal_files(package_dir)
        if not legal_files:
            raise SystemExit(
                f"missing Fontsource license text: {package_dir} ({license_id})"
            )
        if pkg not in copied_packages:
            package_license_dir = licenses_dir / pkg
            package_license_dir.mkdir(parents=True)
            for legal_file in legal_files:
                shutil.copyfile(legal_file, package_license_dir / legal_file.name)
            copied_packages.add(pkg)
        notices.append(
            {
                "family": family,
                "package": metadata.get("name", f"@fontsource/{pkg}"),
                "version": metadata.get("version", "unknown"),
                "license": license_id,
                "author": metadata.get("author", "not declared"),
                "repository": _repository_url(metadata.get("repository")),
            }
        )

        categories[family] = category
        py[family] = {}
        ts_faces[family] = []
        font_files = []
        for w in weights:
            src = package_dir / "files" / f"{pkg}-latin-{w}-normal.woff2"
            if not src.exists():
                # Fail LOUD: a missing source woff2 is a setup bug — never ship a
                # family that won't render (that reintroduces the very mismatch S3 fixes).
                raise SystemExit(f"missing woff2: {src} (did `npm install` run?)")
            fname = f"{slug(family)}-{w}.woff2"
            font_files.append(fname)
            shutil.copyfile(src, fonts_dir / fname)
            py[family][w] = fname
            b64 = base64.b64encode((fonts_dir / fname).read_bytes()).decode()
            ts_faces[family].append({"weight": w, "dataUri": f"data:font/woff2;base64,{b64}"})
        license_manifest.append(
            {
                "family": family,
                "package": metadata.get("name", f"@fontsource/{pkg}"),
                "version": metadata.get("version", "unknown"),
                "license": license_id,
                "fontFiles": font_files,
                "licenseFiles": [f"licenses/{pkg}/{item.name}" for item in legal_files],
            }
        )

    py_manifest.write_text(
        "# GENERATED by scripts/build_fonts.py — do not edit by hand.\n"
        "# family -> {weight: woff2 filename (relative to fonts/)}\n"
        f"FONTS = {_fonts_py_literal(py)}\n"
    )
    families = list(curated.keys())
    ts = (
        "// GENERATED by scripts/build_fonts.py — do not edit by hand.\n"
        "export const FONT_FAMILIES: string[] = "
        f"{json.dumps(families, ensure_ascii=False)};\n\n"
        "export const FONT_CATEGORIES: Record<string, string> = "
        f"{json.dumps(categories, ensure_ascii=False)};\n\n"
        "export type FontFace = { weight: number; dataUri: string };\n"
        "export const FONT_FACES: Record<string, FontFace[]> = "
        f"{json.dumps(ts_faces, ensure_ascii=False)};\n"
    )
    ts_manifest.write_text(ts)
    (fonts_dir / "LICENSE_MANIFEST.json").write_text(
        json.dumps({"fonts": license_manifest}, indent=2, ensure_ascii=False) + "\n"
    )

    notice_lines = [
        "# Bundled Font Licenses",
        "",
        "Generated from the installed Fontsource package metadata.",
        "The corresponding license texts are stored under `licenses/<package>/`.",
        "",
        "| Family | Package | Version | License |",
        "| --- | --- | --- | --- |",
    ]
    for notice in sorted(notices, key=lambda item: item["family"]):
        notice_lines.append(
            f"| {notice['family']} | {notice['package']} | {notice['version']} | {notice['license']} |"
        )
    notice_lines.extend(["", "## Attributions", ""])
    for notice in sorted(notices, key=lambda item: item["family"]):
        source = f" — {notice['repository']}" if notice["repository"] else ""
        notice_lines.append(
            f"- **{notice['family']}**: {notice['author']}{source}"
        )
    (fonts_dir / "THIRD_PARTY_NOTICES.md").write_text(
        "\n".join(notice_lines) + "\n"
    )
    print(f"bundled {sum(len(v) for v in py.values())} woff2 for {len(py)} families")


def main():
    bundle_fonts(NODE, FONTS_DIR, PY_MANIFEST, TS_MANIFEST)

if __name__ == "__main__":
    main()
