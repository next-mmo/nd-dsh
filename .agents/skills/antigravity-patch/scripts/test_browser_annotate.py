"""Tests of the portable annotation recipe. No installed app or registry needed."""
import json
from pathlib import Path
import shutil
import tempfile
import unittest

from asar_tool import Archive, build, encode, sha
from build_browser_annotate import candidate
from test_asar_tool import fixture

RESOURCES = Path(__file__).resolve().parents[1]


def base_archive():
    raw = fixture()
    preload = (b'const electron_1 = require("electron");\n'
               b"electron_1.contextBridge.exposeInMainWorld('electronNative', electronNativeAPI);\n"
               b'// unrelated existing patch\nfeatureA();\n')
    archive = Archive(build(Archive(raw), {'preload.js': preload}, sha(raw), '2.28.2'))
    archive.header['files']['dist'] = {'files': {'preload.js': archive.header['files'].pop('preload.js')}}
    return encode(archive.header, archive.body)


class RecipeTests(unittest.TestCase):
    def test_relocated_bundle_preserves_other_patch(self):
        raw = base_archive()
        with tempfile.TemporaryDirectory() as directory:
            resource_root = Path(directory) / 'relocated-skill'
            shutil.copytree(RESOURCES / 'assets', resource_root / 'assets')
            result = Archive(candidate(raw, resource_root))
        preload = result.content('dist/preload.js')
        self.assertIn(b'featureA();', preload)
        self.assertIn(b'installAntigravityAnnotator', preload)
        self.assertEqual(preload.count(b'// AGY_TEMP_ANNOTATOR_V1'), 1)
        self.assertEqual(result.content('unchanged.js'), Archive(raw).content('unchanged.js'))
        result.verify()

    def test_refuses_duplicate_installation(self):
        once = candidate(base_archive(), RESOURCES)
        with self.assertRaisesRegex(ValueError, 'already exists'):
            candidate(once, RESOURCES)

    def test_refuses_other_version(self):
        raw = base_archive()
        changed = build(Archive(raw), {'package.json': b'{"version":"2.29.0"}'}, sha(raw), '2.28.2')
        with self.assertRaisesRegex(ValueError, 'supports only'):
            candidate(changed, RESOURCES)

    def test_refuses_changed_asset(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            shutil.copytree(RESOURCES / 'assets', root / 'assets')
            (root / 'assets/browser-annotate/annotate.js').write_text('changed', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'implementation changed'):
                candidate(base_archive(), root)


if __name__ == '__main__':
    unittest.main()
