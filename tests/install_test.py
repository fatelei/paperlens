"""Exercise installer retry primitives without downloading models."""
import ast
import shutil
import tempfile
import unittest
from pathlib import Path

source = Path(__file__).resolve().parents[1] / "local_jev/install.py"
tree = ast.parse(source.read_text())
namespace = {"shutil": shutil}
exec(compile(ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "replace_engine"], type_ignores=[]), str(source), "exec"), namespace)
replace_engine = namespace["replace_engine"]

class InstallerRetry(unittest.TestCase):
    def test_reinstall_replaces_symlinks_and_interrupted_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            unpacked, installed = root / "unpacked", root / "engine"
            unpacked.mkdir()
            (unpacked / "lib.1.dylib").write_bytes(b"library")
            (unpacked / "lib.dylib").symlink_to("lib.1.dylib")
            replace_engine(unpacked, installed)
            (installed / "partial").write_bytes(b"incomplete")
            replace_engine(unpacked, installed)
            self.assertEqual((installed / "lib.dylib").read_bytes(), b"library")
            self.assertTrue((installed / "lib.dylib").is_symlink())
            self.assertFalse((installed / "partial").exists())

    def test_refuses_redirected_destination(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            actual = root / "actual"
            actual.mkdir()
            (actual / "keep").write_text("keep")
            target = root / "engine"
            target.symlink_to(actual, target_is_directory=True)
            with self.assertRaises(RuntimeError):
                replace_engine(actual, target)
            self.assertEqual((actual / "keep").read_text(), "keep")

if __name__ == "__main__":
    unittest.main()
