import json
import tempfile
import unittest
from pathlib import Path

from scripts import build_fonts


OFL_TEXT = "SIL OPEN FONT LICENSE Version 1.1\n"
APACHE_TEXT = "Apache License Version 2.0\n"


class BuildFontsLicenseTests(unittest.TestCase):
    def make_package(self, node_root, slug, license_id, license_text):
        package = node_root / slug
        files = package / "files"
        files.mkdir(parents=True)
        (package / "package.json").write_text(
            json.dumps(
                {
                    "name": f"@fontsource/{slug}",
                    "version": "5.2.8",
                    "license": license_id,
                    "author": "Font Test Author",
                    "repository": "https://example.test/fonts",
                }
            )
        )
        (package / "LICENSE").write_text(license_text)
        for weight in (400, 700):
            (files / f"{slug}-latin-{weight}-normal.woff2").write_bytes(
                f"{slug}-{weight}".encode()
            )

    def test_bundles_package_license_files_and_aggregate_notice(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            node_root = root / "node_modules" / "@fontsource"
            self.make_package(node_root, "inter", "OFL-1.1", OFL_TEXT)
            self.make_package(
                node_root,
                "roboto-slab",
                "Apache-2.0",
                APACHE_TEXT,
            )
            fonts = root / "fonts"
            py_manifest = root / "fonts_manifest.py"
            ts_manifest = root / "fontsManifest.ts"
            curated = {
                "Inter": ("inter", [400, 700], "sans"),
                "Roboto Slab": ("roboto-slab", [400, 700], "slab"),
            }

            self.assertTrue(
                hasattr(build_fonts, "bundle_fonts"),
                "build_fonts.bundle_fonts must exist",
            )
            build_fonts.bundle_fonts(
                node_root,
                fonts,
                py_manifest,
                ts_manifest,
                curated=curated,
            )

            self.assertEqual(
                (fonts / "licenses" / "inter" / "LICENSE").read_text(),
                OFL_TEXT,
            )
            self.assertEqual(
                (fonts / "licenses" / "roboto-slab" / "LICENSE").read_text(),
                APACHE_TEXT,
            )
            notice = (fonts / "THIRD_PARTY_NOTICES.md").read_text()
            self.assertIn("| Inter | @fontsource/inter | 5.2.8 | OFL-1.1 |", notice)
            self.assertIn(
                "| Roboto Slab | @fontsource/roboto-slab | 5.2.8 | Apache-2.0 |",
                notice,
            )
            self.assertIn("Font Test Author", notice)
            self.assertTrue((fonts / "inter-400.woff2").is_file())
            self.assertTrue((fonts / "roboto-slab-700.woff2").is_file())
            self.assertIn('"Roboto Slab": {', py_manifest.read_text())
            self.assertIn(
                'export const FONT_FAMILIES: string[] = ["Inter", "Roboto Slab"];',
                ts_manifest.read_text(),
            )
            manifest = json.loads((fonts / "LICENSE_MANIFEST.json").read_text())
            self.assertEqual(
                manifest["fonts"],
                [
                    {
                        "family": "Inter",
                        "package": "@fontsource/inter",
                        "version": "5.2.8",
                        "license": "OFL-1.1",
                        "fontFiles": ["inter-400.woff2", "inter-700.woff2"],
                        "licenseFiles": ["licenses/inter/LICENSE"],
                    },
                    {
                        "family": "Roboto Slab",
                        "package": "@fontsource/roboto-slab",
                        "version": "5.2.8",
                        "license": "Apache-2.0",
                        "fontFiles": ["roboto-slab-400.woff2", "roboto-slab-700.woff2"],
                        "licenseFiles": ["licenses/roboto-slab/LICENSE"],
                    },
                ],
            )

    def test_module_description_does_not_claim_every_font_is_ofl(self):
        self.assertNotIn("latin woff2, OFL", build_fonts.__doc__)


if __name__ == "__main__":
    unittest.main()
