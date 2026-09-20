"""Synthetic bundle-inventory verification; no builds or user paths."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('builder', Path(__file__).resolve().parents[2] / 'tools/build_engine_bundle.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class InventoryTests(unittest.TestCase):
    def test_inventory_records_files_links_and_rejects_escape(self):
        self.assertTrue(callable(getattr(builder, 'artifact_inventory', None)), 'Artifact inventory is missing')
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'bundle'
            root.mkdir()
            (root / 'binary').write_bytes(b'synthetic')
            (root / 'alias').symlink_to('binary')
            (root / 'build-receipt.json').write_text('{}')
            inventory = builder.artifact_inventory(root)
            self.assertEqual({item['name'] for item in inventory}, {'binary', 'alias'})
            self.assertEqual(next(item for item in inventory if item['name'] == 'alias')['symlink'], 'binary')
            self.assertEqual(len(next(item for item in inventory if item['name'] == 'binary')['sha256']), 64)
            (root / 'escape').symlink_to(Path(folder))
            with self.assertRaises(ValueError):
                builder.artifact_inventory(root)


if __name__ == '__main__':
    unittest.main()
