"""Behavioral checks on synthetic archives; never changes the installed app."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from asar_tool import Archive, build, encode, sha
import patch as cli


def fixture(version='2.29.0', preload=b'const vendor = 1;\n'):
    body = b''
    header = {'files': {'dist': {'files': {}}}}
    for name, data in [('package.json', json.dumps({'version': version}).encode()),
                       ('dist/preload.js', preload), ('other.js', b'const other = 1;')]:
        entry = {'offset': str(len(body)), 'size': len(data)}
        if name.startswith('dist/'):
            header['files']['dist']['files'][name.split('/')[1]] = entry
        else:
            header['files'][name] = entry
        body += data
    return encode(header, body)


class CliTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.live = self.root / 'resources/app.asar'
        self.live.parent.mkdir()
        self.before = fixture()
        self.live.write_bytes(self.before)
        self.state = self.root / 'state'
        self.assets = self.root / 'assets'
        self.assets.mkdir()
        self.block = b'\n// AGY_TEMP_ANNOTATOR_V1\nconst annotation = 1;\n'
        (self.assets / 'block.js').write_bytes(self.block)
        self.catalog = self.assets / 'recipes.json'
        self.recipe = {'id': 'browser-annotate', 'revision': 2, 'app_version': '2.29.0',
                       'entry': 'dist/preload.js', 'entry_sha256': sha(Archive(self.before).content('dist/preload.js')),
                       'marker': '// AGY_TEMP_ANNOTATOR_V1', 'block': 'block.js', 'block_sha256': sha(self.block)}
        self.catalog.write_text(json.dumps({'recipes': [self.recipe]}))
        self.manager = cli.Manager(self.live, self.state, self.catalog)
        closed = patch.object(cli, 'ensure_closed')
        self.closed = closed.start()
        self.addCleanup(closed.stop)

    def apply_confirm(self):
        self.manager.apply('browser-annotate')
        self.manager.confirm('Synthetic test only: installed bytes checked, no live UI claim.')

    def test_dry_run_writes_nothing_and_real_apply_reset_round_trip(self):
        plan = self.manager.apply('browser-annotate', True)
        self.assertEqual(plan['status'], 'dry_run')
        self.assertFalse(self.state.exists())
        self.assertEqual(self.live.read_bytes(), self.before)
        self.apply_confirm()
        self.assertTrue(self.manager.status()['registry_matches'])
        self.assertEqual(len(cli.read_json(self.state/'registry.json')['patches']), 1)
        patched = self.live.read_bytes()
        self.assertNotEqual(patched, self.before)
        self.assertEqual(self.manager.apply('browser-annotate')['status'], 'already_applied')
        self.manager.reset('browser-annotate', True)
        self.assertEqual(self.live.read_bytes(), patched)
        self.manager.reset('browser-annotate')
        self.assertEqual(self.live.read_bytes(), self.before)
        self.manager.confirm('Synthetic reset byte comparison only.')
        self.assertEqual(cli.read_json(self.state/'registry.json')['patches'], [])
        self.assertEqual(self.manager.reset('browser-annotate')['status'], 'already_reset')

    def test_unknown_version_and_recipe_tampering_refused(self):
        self.live.write_bytes(fixture('2.30.0'))
        with self.assertRaisesRegex(ValueError, 'No inspected recipe'):
            self.manager.apply('browser-annotate')
        self.live.write_bytes(self.before)
        (self.assets/'block.js').write_bytes(self.block+b'// tamper')
        with self.assertRaisesRegex(ValueError, 'source hash mismatch'):
            self.manager.apply('browser-annotate')
        self.assertEqual(self.live.read_bytes(), self.before)

    def test_other_preload_patch_refused_but_unrelated_registered_entry_preserved(self):
        self.live.write_bytes(fixture(preload=b'const otherPatch = 2;'))
        with self.assertRaisesRegex(ValueError, 'Preload differs'):
            self.manager.apply('browser-annotate')
        a = Archive(self.before)
        raw = build(a, {'other.js': b'const extraFeature = 2;'}, sha(self.before), '2.29.0')
        self.live.write_bytes(raw)
        self.state.mkdir()
        prior = {'id': 'other-feature', 'after_sha256': sha(raw), 'extra_field': 'preserve'}
        reg = {'schema_version':1, 'app_version':'2.29.0', 'archive':str(self.live),
               'active_sha256':sha(raw), 'patches':[prior], 'unknown_field':{'keep':True}}
        cli.atomic_json(self.state/'registry.json', reg)
        self.apply_confirm()
        self.assertEqual(Archive(self.live.read_bytes()).content('other.js'), b'const extraFeature = 2;')
        updated_reg = cli.read_json(self.state/'registry.json')
        updated_reg['added_after_apply'] = {'keep': 'this new metadata'}
        cli.atomic_json(self.state/'registry.json', updated_reg)
        self.manager.reset('browser-annotate')
        self.manager.confirm('Synthetic reset with surviving patch bytes checked.')
        restored = cli.read_json(self.state/'registry.json')
        self.assertEqual(restored['patches'], [prior])
        self.assertEqual(restored['unknown_field'], {'keep':True})
        self.assertEqual(restored['added_after_apply'], {'keep':'this new metadata'})
        self.assertEqual(self.live.read_bytes(), raw)

    def test_update_or_unknown_modification_blocks_reset(self):
        self.apply_confirm()
        updated = fixture('2.30.0')
        self.live.write_bytes(updated)
        with self.assertRaisesRegex(ValueError, 'differs from registry'):
            self.manager.reset('browser-annotate')
        self.assertEqual(self.live.read_bytes(), updated)

    def test_reset_cannot_erase_later_patch(self):
        self.apply_confirm()
        path = self.state/'registry.json'
        reg = cli.read_json(path)
        reg['patches'].append({'id':'later-feature'})
        cli.atomic_json(path, reg)
        before = self.live.read_bytes()
        with self.assertRaisesRegex(ValueError, 'later patches'):
            self.manager.reset('browser-annotate')
        self.assertEqual(self.live.read_bytes(), before)

    def test_tampered_backup_refused(self):
        self.apply_confirm()
        reg = cli.read_json(self.state/'registry.json')
        Path(reg['patches'][-1]['backup']).write_bytes(fixture(preload=b'const changed = 1;'))
        before = self.live.read_bytes()
        with self.assertRaisesRegex(ValueError, 'Backup hash'):
            self.manager.reset('browser-annotate')
        self.assertEqual(self.live.read_bytes(), before)

    def test_running_app_refuses_before_replacement(self):
        self.closed.side_effect = ValueError('Antigravity is running')
        with self.assertRaisesRegex(ValueError, 'running'):
            self.manager.apply('browser-annotate')
        self.assertEqual(self.live.read_bytes(), self.before)
        self.assertFalse(self.state.exists())

    def test_unconfirmed_apply_can_be_reset_then_confirmed(self):
        self.manager.apply('browser-annotate')
        self.assertFalse((self.state/'registry.json').exists())
        self.assertEqual(self.manager.status()['pending_live_state'], 'after')
        with self.assertRaisesRegex(ValueError, 'pending transaction'):
            self.manager.apply('browser-annotate')
        self.manager.reset('browser-annotate')
        self.assertEqual(self.live.read_bytes(), self.before)
        self.manager.confirm('Synthetic recovery byte comparison only.')
        self.assertEqual(cli.read_json(self.state/'registry.json')['patches'], [])

    def test_unconfirmed_reset_can_itself_be_undone(self):
        self.apply_confirm()
        patched = self.live.read_bytes()
        self.manager.reset('browser-annotate')
        self.manager.reset('browser-annotate')
        self.assertEqual(self.live.read_bytes(), patched)
        self.manager.confirm('Synthetic recovery preserves original patch.')
        self.assertEqual(len(cli.read_json(self.state/'registry.json')['patches']), 1)

    def test_file_lock_interruption_can_cancel_without_changing_archive(self):
        replace = cli.os.replace
        def locked(source, destination):
            if Path(destination) == self.live:
                raise PermissionError('File locked')
            return replace(source, destination)
        with patch.object(cli.os, 'replace', side_effect=locked):
            with self.assertRaises(PermissionError):
                self.manager.apply('browser-annotate')
        self.assertEqual(self.manager.status()['pending_live_state'], 'before')
        self.manager.reset('browser-annotate')
        self.assertEqual(self.live.read_bytes(), self.before)
        self.assertIsNone(self.manager.pending())
        self.assertEqual(list(self.live.parent.glob('app.asar.stage-*')), [])

    def test_external_registry_change_refuses_confirmation(self):
        self.apply_confirm()
        self.manager.reset('browser-annotate')
        reg = cli.read_json(self.state/'registry.json')
        reg['external_change'] = 'must not erase'
        cli.atomic_json(self.state/'registry.json', reg)
        with self.assertRaisesRegex(ValueError, 'Registry changed'):
            self.manager.confirm('Test')
        self.assertEqual(cli.read_json(self.state/'registry.json'), reg)

    def test_confirm_is_idempotent_after_registry_write_interruption(self):
        self.manager.apply('browser-annotate')
        unlink = Path.unlink
        def interrupted(path, *args, **kwargs):
            if path == self.state/'pending.json':
                raise PermissionError('Simulated interruption after commit')
            return unlink(path, *args, **kwargs)
        with patch.object(Path, 'unlink', interrupted):
            with self.assertRaises(PermissionError):
                self.manager.confirm('Synthetic test')
        self.manager.confirm('Synthetic test')
        reg = cli.read_json(self.state/'registry.json')
        self.assertEqual(len(reg['patches']), 1)
        self.assertEqual(len(reg['cli_history']), 1)

    def test_invalid_javascript_rejected_before_mutation(self):
        block = b'\n// AGY_TEMP_ANNOTATOR_V1\nconst = invalid;'
        (self.assets/'block.js').write_bytes(block)
        self.recipe['block_sha256'] = sha(block)
        self.catalog.write_text(json.dumps({'recipes':[self.recipe]}))
        with self.assertRaisesRegex(ValueError, 'syntax check failed'):
            self.manager.apply('browser-annotate')
        self.assertEqual(self.live.read_bytes(), self.before)

    def test_interrupted_reset_restores_original_pending_pointer_on_cancel(self):
        self.manager.apply('browser-annotate')
        original = self.manager.pending()
        patched = self.live.read_bytes()
        self.closed.side_effect = [None, ValueError('app reopened')]
        with self.assertRaisesRegex(ValueError, 'reopened'):
            self.manager.reset('browser-annotate')
        self.closed.side_effect = None
        self.manager.reset('browser-annotate')
        self.assertEqual(self.manager.pending(), original)
        self.assertEqual(self.live.read_bytes(), patched)
        self.manager.reset('browser-annotate')
        self.manager.confirm('Synthetic recovery after interrupted reset.')
        self.assertEqual(self.live.read_bytes(), self.before)
        self.assertEqual(self.manager.status()['unresolved_transactions'], [])
        self.assertEqual(self.manager.apply('browser-annotate', True)['status'], 'dry_run')

    def test_adopts_existing_known_patch_without_external_state_or_app_writes(self):
        archive = Archive(self.before)
        patched = build(archive, {'dist/preload.js': archive.content('dist/preload.js') + self.block}, sha(self.before), '2.29.0')
        self.live.write_bytes(patched)
        self.assertEqual(self.manager.adopt('browser-annotate', True)['status'], 'dry_run')
        self.assertFalse(self.state.exists())
        self.manager.adopt('browser-annotate')
        self.assertEqual(self.live.read_bytes(), patched)
        self.closed.assert_not_called()
        self.manager.confirm('Synthetic adoption; archive content checked, no UI claim.')
        self.manager.reset('browser-annotate')
        self.manager.confirm('Synthetic reset after adoption.')
        self.assertEqual(Archive(self.live.read_bytes()).content('dist/preload.js'), archive.content('dist/preload.js'))
        self.assertEqual(Archive(self.live.read_bytes()).content('other.js'), archive.content('other.js'))

    def test_adoption_refuses_unknown_preload_even_with_known_block(self):
        self.live.write_bytes(fixture(preload=b'const unknown = 1;' + self.block))
        with self.assertRaisesRegex(ValueError, 'Underlying preload differs'):
            self.manager.adopt('browser-annotate')
        self.assertFalse(self.state.exists())


if __name__ == '__main__':
    unittest.main()
