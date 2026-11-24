"""Exercise installer retry primitives without downloading models."""
import ast
import shutil
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

source = Path(__file__).resolve().parents[1] / "local_jev/install.py"
tree = ast.parse(source.read_text())
namespace = {"shutil":shutil,"os":os,"subprocess":subprocess}
exec(compile(ast.Module(body=[node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in ("replace_engine","prepare_environment")], type_ignores=[]), str(source), "exec"), namespace)
replace_engine = namespace["replace_engine"]
prepare_environment = namespace["prepare_environment"]

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

    def test_repairs_interrupted_environment_and_keeps_completed_one(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory=Path(temporary)/"venv"
            directory.mkdir();(directory/"partial").write_text("partial")
            python=prepare_environment(sys.executable,directory,managed=True)
            self.assertFalse((directory/"partial").exists())
            keep=directory/"keep";keep.write_text("dependency")
            prepare_environment(sys.executable,directory,managed=True)
            self.assertTrue(keep.exists())
            self.assertEqual(subprocess.run([str(python),"-m","pip","--version"],stdout=subprocess.DEVNULL).returncode,0)

    @unittest.skipUnless(os.environ.get("PAPERLENS_TEST_BASE_PYTHON"),"requires a distinct managed interpreter")
    def test_migrates_existing_system_venv_without_touching_models(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);directory=root/"venv"
            subprocess.run([sys.executable,"-m","venv",str(directory)],check=True)
            old=directory/"old-package";old.write_text("old")
            model=root/"model.gguf";model.write_bytes(b"preserved")
            python=prepare_environment(os.environ["PAPERLENS_TEST_BASE_PYTHON"],directory,managed=True)
            self.assertFalse(old.exists());self.assertEqual(model.read_bytes(),b"preserved")
            base=subprocess.check_output([str(python),"-I","-c","import os,sys; print(os.path.realpath(sys._base_executable))"],text=True).strip()
            self.assertEqual(os.path.normcase(base),os.path.normcase(os.path.realpath(os.environ["PAPERLENS_TEST_BASE_PYTHON"])))

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
