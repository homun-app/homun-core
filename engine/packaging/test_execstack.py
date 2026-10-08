"""Synthetic ELF execstack hardening; no builds or user paths."""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('builder', Path(__file__).resolve().parents[2] / 'tools/build_engine_bundle.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

PT_GNU_STACK = 0x6474E551


def elf64_image(stack_flags):
    """ELF64 LE with one PT_LOAD and one PT_GNU_STACK carrying stack_flags."""
    header = struct.pack('<16sHHIQQQIHHHHHH',
                         b'\x7fELF\x02\x01\x01\x00' + b'\x00' * 8, 3, 0x3E, 1, 0, 64, 0, 0,
                         64, 56, 2, 0, 0, 0)
    load = struct.pack('<IIQQQQQQ', 1, 6, 0, 0, 0, 0, 0, 0x1000)
    stack = struct.pack('<IIQQQQQQ', PT_GNU_STACK, stack_flags, 0, 0, 0, 0, 0, 0x10)
    return header + load + stack


def elf32_image(stack_flags):
    header = struct.pack('<16sHHIIIIIHHHHHH',
                         b'\x7fELF\x01\x01\x01\x00' + b'\x00' * 8, 3, 3, 1, 0, 52, 0, 0,
                         52, 32, 2, 0, 0, 0)
    load = struct.pack('<IIIIIIII', 1, 0, 0, 0, 0, 0, 6, 0x1000)
    stack = struct.pack('<IIIIIIII', PT_GNU_STACK, 0, 0, 0, 0, 0, stack_flags, 0x10)
    return header + load + stack


class ClearExecstackTests(unittest.TestCase):
    def test_elf64_rwx_stack_keeps_everything_but_the_exec_bit(self):
        image = elf64_image(7)
        patched = builder.clear_execstack(image)
        self.assertIsNotNone(patched)
        self.assertEqual(patched, elf64_image(6))

    def test_clean_and_non_elf_images_are_untouched(self):
        self.assertIsNone(builder.clear_execstack(elf64_image(6)))
        self.assertIsNone(builder.clear_execstack(b'synthetic'))

    def test_elf32_rwx_stack_is_downgraded(self):
        self.assertEqual(builder.clear_execstack(elf32_image(7)), elf32_image(6))

    def test_unlocatable_program_headers_are_rejected(self):
        with self.assertRaises(ValueError):
            builder.clear_execstack(b'\x7fELF\x03\x01\x01\x00' + b'\x00' * 60)


class BundleHardeningTests(unittest.TestCase):
    def test_bundle_patches_only_the_files_that_need_it(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'bundle'
            internal = root / '_internal'
            internal.mkdir(parents=True)
            dirty = internal / 'libpython3.13.so.1.0'
            dirty.write_bytes(elf64_image(7))
            clean = internal / 'other.so'
            clean.write_bytes(elf64_image(6))
            (root / 'data.txt').write_bytes(b'synthetic')
            (root / 'alias.so').symlink_to('_internal/libpython3.13.so.1.0')
            self.assertEqual(builder.clear_bundle_execstack(root),
                             ['_internal/libpython3.13.so.1.0'])
            self.assertEqual(dirty.read_bytes(), elf64_image(6))
            self.assertEqual(clean.read_bytes(), elf64_image(6))
            self.assertEqual(builder.clear_bundle_execstack(root), [])


if __name__ == '__main__':
    unittest.main()
