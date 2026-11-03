"""Isolated regression checks; never accesses an installed app."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from asar_tool import Archive, build, encode, sha, write_new


def fixture():
    payloads = {'package.json': b'{"version":"2.28.2"}',
                'preload.js': b'vendor();\n// patch-a\nfeatureA();',
                'unchanged.js': b'keep this content', 'empty': b''}
    files, body = {}, b''
    for name, data in payloads.items():
        files[name] = {'offset': str(len(body)), 'size': len(data),
                       'integrity': {'algorithm': 'SHA256', 'hash': sha(data), 'blockSize': 8,
                                     'blocks': [sha(data[i:i+8]) for i in range(0, len(data), 8)]}}
        body += data
    files['native.node'] = {'unpacked': True, 'size': 42, 'executable': True}
    files['alias'] = {'link': 'unchanged.js'}
    return encode({'files': files}, body)


class AsarTests(unittest.TestCase):
    def test_stacking_keeps_prior_patch_and_other_entries(self):
        raw = fixture()
        first = Archive(raw)
        new_preload = first.content('preload.js') + b'\n// patch-b\nfeatureB();'
        result = Archive(build(first, {'preload.js': new_preload}, sha(raw), '2.28.2'))
        self.assertIn(b'featureA()', result.content('preload.js'))
        self.assertIn(b'featureB()', result.content('preload.js'))
        self.assertEqual(result.content('unchanged.js'), first.content('unchanged.js'))
        self.assertEqual(result.header['files']['native.node'], first.header['files']['native.node'])
        self.assertEqual(result.header['files']['alias'], first.header['files']['alias'])
        self.assertEqual(first.raw, raw)
        self.assertEqual(result.verify(), 4)

    def test_refuses_stale_source_and_wrong_version(self):
        raw = fixture()
        for expected_hash, version in [('0'*64, '2.28.2'), (sha(raw), '2.29.0')]:
            with self.assertRaises(ValueError):
                build(Archive(raw), {'preload.js': b'replacement'}, expected_hash, version)

    def test_refuses_unknown_unpacked_and_link_replacements(self):
        raw = fixture()
        for name in ['missing', 'native.node', 'alias', '../preload.js']:
            with self.assertRaises(ValueError):
                build(Archive(raw), {name: b'no'}, sha(raw), '2.28.2')

    def test_catches_corruption_and_block_mismatch(self):
        raw = fixture()
        with self.assertRaises(ValueError):
            Archive(raw[:-1] + bytes([raw[-1] ^ 1])).verify()
        archive = Archive(raw)
        header = copy.deepcopy(archive.header)
        header['files']['preload.js']['integrity']['blocks'][0] = '0'*64
        with self.assertRaises(ValueError):
            Archive(encode(header, archive.body)).verify()

    def test_no_output_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'archive.asar'
            write_new(output, b'original')
            with self.assertRaises(FileExistsError):
                write_new(output, b'replacement')
            self.assertEqual(output.read_bytes(), b'original')


if __name__ == '__main__':
    unittest.main()
