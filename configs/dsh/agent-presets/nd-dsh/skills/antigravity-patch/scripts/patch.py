"""Manage inspected Antigravity recipes. Never kills processes or ports unknown versions."""
import argparse
import contextlib
import datetime as dt
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

from asar_tool import Archive, build, sha, write_new

SKILL = Path(__file__).resolve().parents[1]


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def atomic_json(path, value):
    path = Path(path)
    staged = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    write_new(staged, (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode())
    os.replace(staged, path)


def ensure_closed():
    if os.name != 'nt':
        raise ValueError('Live replacement is supported on Windows only.')
    result = subprocess.run(['tasklist', '/FI', 'IMAGENAME eq Antigravity.exe', '/FO', 'CSV', '/NH'],
                            capture_output=True, text=True, check=True)
    if 'antigravity.exe' in result.stdout.lower():
        raise ValueError('Antigravity is running. Save your work and quit it normally, then retry. No process was stopped.')


def check_js(data):
    node = shutil.which('node')
    if not node:
        raise ValueError('Node.js is required for JavaScript syntax validation; no files were installed.')
    with tempfile.TemporaryDirectory(prefix='agy-syntax-') as directory:
        file = Path(directory) / 'preload.js'
        file.write_bytes(data)
        result = subprocess.run([node, '--check', str(file)], capture_output=True, text=True)
        if result.returncode:
            raise ValueError('JavaScript syntax check failed:\n' + result.stderr)


@contextlib.contextmanager
def state_lock(state):
    state.mkdir(parents=True, exist_ok=True)
    lock = state / 'cli.lock'
    try:
        with lock.open('x', encoding='utf-8') as file:
            file.write(str(os.getpid()))
    except FileExistsError:
        raise ValueError(f'Another operation or interrupted lock exists: {lock}. Inspect it before removing it.')
    try:
        yield
    finally:
        lock.unlink()


class Manager:
    def __init__(self, archive, state, catalog=None):
        self.path = Path(archive).resolve()
        self.state = Path(state).resolve()
        self.catalog = Path(catalog or SKILL / 'assets/browser-annotate/recipes.json')

    def current(self):
        archive = Archive(self.path.read_bytes())
        archive.verify()
        return archive

    def registry(self, archive):
        path = self.state / 'registry.json'
        if path.exists():
            reg = read_json(path)
            if Path(reg['archive']).resolve() != self.path:
                raise ValueError('Registry belongs to a different archive; use the matching state directory.')
            if reg['active_sha256'] != sha(archive.raw) or reg['app_version'] != archive.version():
                raise ValueError('Installed version/hash differs from registry. Inspect the update or interrupted transaction; no force override is available.')
            return reg
        # An unregistered custom preload cannot be adopted silently.
        if b'AGY_TEMP_ANNOTATOR' in archive.content('dist/preload.js'):
            raise ValueError('Existing annotation patch has no matching registry. Inspect and adopt it before using this CLI.')
        return {'schema_version': 1, 'app_version': archive.version(), 'archive': str(self.path),
                'active_sha256': sha(archive.raw), 'patches': [],
                'baseline_provenance': 'Inspected recipe entry matched; other entries are not claimed to be pristine vendor bytes.'}

    def pending(self):
        path = self.state / 'pending.json'
        return read_json(path) if path.exists() else None

    def disk_registry(self):
        path = self.state / 'registry.json'
        return read_json(path) if path.exists() else None

    def check_pending_registry(self, record):
        current = self.disk_registry()
        if current not in (record['registry_disk_before'], record['registry_after']):
            raise ValueError('Registry changed during the pending transaction. Inspect it before confirming or recovering.')

    def no_pending(self):
        if self.pending():
            raise ValueError('A pending transaction needs attention. Use status, then confirm after UI checks, or reset to recover.')
        # Detect legacy prepared/pending records created before this CLI.
        for path in (self.state / 'transactions').glob('*/transaction.json'):
            record = read_json(path)
            if record.get('status', '').startswith(('pending', 'prepared', 'awaiting_ui')):
                raise ValueError(f'Unresolved transaction: {path}. Inspect it before starting another operation.')

    def superseded(self, record):
        result, seen = [], set()
        while record.get('supersedes'):
            path = Path(record['supersedes']).resolve()
            if not path.is_relative_to(self.state / 'transactions') or path in seen:
                raise ValueError('Invalid superseded transaction chain; inspect recovery records.')
            seen.add(path)
            record = read_json(path)
            result.append((path, record))
        return result

    def status(self):
        archive = self.current()
        reg = read_json(self.state / 'registry.json') if (self.state / 'registry.json').exists() else None
        pending = self.pending()
        record = read_json(pending['transaction']) if pending else None
        digest = sha(archive.raw)
        unresolved = []
        for path in (self.state / 'transactions').glob('*/transaction.json'):
            item = read_json(path)
            if item.get('status', '').startswith(('pending', 'prepared', 'awaiting_ui')):
                unresolved.append({'transaction': str(path), 'status': item['status'],
                                   'live_state': 'after' if digest == item['after_sha256'] else
                                   'before' if digest == item['before_sha256'] else 'unknown'})
        return {'archive': str(self.path), 'version': archive.version(), 'sha256': digest,
                'verified_packed_entries': archive.verify(),
                'registry_matches': bool(reg and reg.get('active_sha256') == digest and
                                         reg.get('app_version') == archive.version() and
                                         Path(reg['archive']).resolve() == self.path),
                'patches': [{'id': p['id'], 'revision': p.get('revision')} for p in (reg or {}).get('patches', [])],
                'pending': record,
                'unresolved_transactions': unresolved,
                'pending_live_state': ('after' if digest == record['after_sha256'] else
                                       'before' if digest == record['before_sha256'] else 'unknown') if record else None}

    def install(self, archive, result, reg_before, reg_after, action, patch_id, entries, extra=None):
        ensure_closed()
        if sha(self.path.read_bytes()) != sha(archive.raw):
            raise ValueError('Live archive changed after inspection.')
        directory = self.state / 'transactions' / (dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex)
        directory.mkdir(parents=True)
        write_new(directory / 'before.asar', archive.raw)
        write_new(directory / 'after.asar', result)
        record = {'action': action, 'id': patch_id, 'app_version': archive.version(),
                  'archive': str(self.path), 'before_sha256': sha(archive.raw), 'after_sha256': sha(result),
                  'backup': str(directory / 'before.asar'), 'snapshot': str(directory / 'after.asar'),
                  'entries': entries, 'registry_before': reg_before, 'registry_after': reg_after,
                  'registry_disk_before': self.disk_registry(),
                  'status': 'pending-replacement', **(extra or {})}
        transaction = directory / 'transaction.json'
        if action == 'apply':
            item = {k: record[k] for k in ('id', 'revision', 'before_sha256', 'after_sha256', 'backup', 'snapshot', 'entries', 'source')}
            item.update({'registry_before': reg_before, 'status': 'awaiting_ui', 'transaction': str(transaction)})
            reg_after['patches'].append(item)
        stage = self.path.with_name('app.asar.stage-' + uuid.uuid4().hex)
        record['staged'] = str(stage)
        atomic_json(transaction, record)
        # Persist recovery information BEFORE writing/replacing live resources.
        atomic_json(self.state / 'pending.json', {'transaction': str(transaction)})
        write_new(stage, result)
        ensure_closed()
        if sha(self.path.read_bytes()) != record['before_sha256']:
            raise ValueError('Live archive changed before replacement; pending transaction retained for inspection.')
        os.replace(stage, self.path)  # A lock error is surfaced, never bypassed.
        if sha(self.path.read_bytes()) != record['after_sha256']:
            raise ValueError('Post-replacement hash mismatch; pending transaction retained.')
        record['status'] = 'awaiting_ui'
        atomic_json(transaction, record)
        return {'status': 'awaiting_ui', 'transaction': str(transaction), 'backup': record['backup'],
                'next': 'Restart Antigravity, check the feature and cancel/failure path, then run confirm --validation "observed checks". Use reset to undo this pending change.'}

    def apply(self, patch_id, dry_run=False):
        self.no_pending()
        archive = self.current()
        reg = self.registry(archive)
        catalog = read_json(self.catalog)
        choices = [r for r in catalog['recipes'] if r['id'] == patch_id and r['app_version'] == archive.version()]
        if len(choices) != 1:
            raise ValueError(f'No inspected recipe for {patch_id} on {archive.version()}. Use the skill to inspect and port it; older archives will not be restored.')
        recipe = choices[0]
        entry = recipe['entry']
        original = archive.content(entry)
        block_path = (self.catalog.parent / recipe['block']).resolve()
        if not block_path.is_relative_to(self.catalog.parent.resolve()):
            raise ValueError('Recipe source must stay inside the recipe directory.')
        block = block_path.read_bytes()
        if sha(block) != recipe['block_sha256']:
            raise ValueError('Recipe source hash mismatch.')
        if any(p['id'] == patch_id for p in reg['patches']):
            if original.count(block) == 1:
                return {'status': 'already_applied', 'patch': patch_id, 'sha256': sha(archive.raw)}
            raise ValueError('Registered patch differs from this recipe; inspect before revising.')
        if recipe['marker'].encode() in original:
            raise ValueError('Unexpected patch marker; refusing duplicate or unknown patch.')
        if sha(original) != recipe['entry_sha256']:
            raise ValueError('Preload differs from the inspected recipe. Other patches may exist; adapt the recipe without overwriting them.')
        replacement = original + block
        check_js(replacement)
        result = build(archive, {entry: replacement}, sha(archive.raw), archive.version())
        if dry_run:
            return {'status': 'dry_run', 'action': 'apply', 'version': archive.version(),
                    'before_sha256': sha(archive.raw), 'after_sha256': sha(result), 'entries': [entry]}
        reg_after = json.loads(json.dumps(reg))
        reg_after['active_sha256'] = sha(result)
        return self.install(archive, result, reg, reg_after, 'apply', patch_id, [entry],
                            {'revision': recipe['revision'], 'source': str(block_path)})

    def adopt(self, patch_id, dry_run=False):
        """Record a recognized existing patch without reading another app's registry."""
        self.no_pending()
        archive = self.current()
        if self.disk_registry() is not None:
            self.registry(archive)
            return {'status': 'already_managed', 'patch': patch_id}
        choices = [r for r in read_json(self.catalog)['recipes']
                   if r['id'] == patch_id and r['app_version'] == archive.version()]
        if len(choices) != 1:
            raise ValueError('No inspected recipe for this installed version; inspect before adopting.')
        recipe = choices[0]
        source = (self.catalog.parent / recipe['block']).resolve()
        if not source.is_relative_to(self.catalog.parent.resolve()):
            raise ValueError('Recipe source must stay inside the recipe directory.')
        block = source.read_bytes()
        entry = archive.content(recipe['entry'])
        if sha(block) != recipe['block_sha256'] or entry.count(block) != 1 or not entry.endswith(block):
            raise ValueError('Existing patch does not exactly match the inspected recipe.')
        original = entry[:-len(block)]
        if sha(original) != recipe['entry_sha256']:
            raise ValueError('Underlying preload differs; inspect other patches before adopting.')
        check_js(entry)
        baseline = build(archive, {recipe['entry']: original}, sha(archive.raw), archive.version())
        if dry_run:
            return {'status': 'dry_run', 'action': 'adopt', 'live_archive_unchanged': True,
                    'sha256': sha(archive.raw), 'reconstructed_baseline_sha256': sha(baseline)}
        directory = self.state / 'transactions' / ('adopt-' + uuid.uuid4().hex)
        directory.mkdir(parents=True)
        write_new(directory / 'before.asar', baseline)
        write_new(directory / 'after.asar', archive.raw)
        before_reg = {'schema_version': 1, 'archive': str(self.path), 'app_version': archive.version(),
                      'active_sha256': sha(baseline), 'patches': [],
                      'baseline_provenance': 'Reconstructed by removing the exact inspected annotation block; unrelated entries preserved, not independently established as pristine vendor bytes.'}
        after_reg = json.loads(json.dumps(before_reg))
        after_reg['active_sha256'] = sha(archive.raw)
        transaction = directory / 'transaction.json'
        item = {'id': patch_id, 'revision': recipe['revision'], 'before_sha256': sha(baseline),
                'after_sha256': sha(archive.raw), 'backup': str(directory / 'before.asar'),
                'snapshot': str(directory / 'after.asar'), 'entries': [recipe['entry']],
                'source': str(source), 'status': 'awaiting_ui', 'transaction': str(transaction),
                'registry_before': before_reg}
        after_reg['patches'].append(item)
        record = {**item, 'action': 'adopt', 'status': 'awaiting_ui', 'archive': str(self.path),
                  'app_version': archive.version(), 'registry_before': before_reg,
                  'registry_after': after_reg, 'registry_disk_before': None,
                  'staged': str(self.path.with_name('app.asar.stage-' + uuid.uuid4().hex))}
        if sha(self.path.read_bytes()) != item['after_sha256']:
            raise ValueError('Live archive changed during adoption; inspect the saved snapshots.')
        atomic_json(transaction, record)
        atomic_json(self.state / 'pending.json', {'transaction': str(transaction)})
        return {'status': 'awaiting_ui', 'action': 'adopt', 'live_archive_unchanged': True,
                'transaction': str(transaction), 'next': 'Observe the existing feature, then confirm --validation with actual checks. Reset removes this recognized patch using the reconstructed baseline.'}

    def reset(self, patch_id, dry_run=False):
        archive = self.current()
        pending = self.pending()
        if pending:
            transaction = Path(pending['transaction'])
            latest = read_json(transaction)
            if Path(latest['archive']).resolve() != self.path or latest['id'] != patch_id:
                raise ValueError('Pending transaction targets a different archive or patch.')
            self.check_pending_registry(latest)
            digest = sha(archive.raw)
            if digest == latest['before_sha256']:
                if self.disk_registry() != latest['registry_disk_before']:
                    raise ValueError('Live archive is at the input but registry commit already changed. Inspect this ambiguous recovery state.')
                if dry_run:
                    return {'status': 'dry_run', 'action': 'cancel_pending', 'live_archive_unchanged': True}
                staged = Path(latest['staged'])
                if staged.exists():
                    if staged.parent.resolve() != self.path.parent or not staged.name.startswith('app.asar.stage-') or sha(staged.read_bytes()) != latest['after_sha256']:
                        raise ValueError('Recorded staging file differs; inspect before canceling.')
                    staged.unlink()
                latest['status'] = 'canceled-before-replacement'
                atomic_json(transaction, latest)
                if latest.get('supersedes'):
                    self.superseded(latest)  # Validate the chain before restoring its pointer.
                    atomic_json(self.state / 'pending.json', {'transaction': latest['supersedes']})
                else:
                    (self.state / 'pending.json').unlink()
                return {'status': 'canceled', 'live_archive_unchanged': True}
            if digest != latest['after_sha256']:
                raise ValueError('Live hash matches neither side of the pending transaction. Inspect; no files were replaced.')
            reg = latest['registry_after']
            target_reg = latest['registry_before']
        else:
            self.no_pending()
            reg = self.registry(archive)
            patches = reg['patches']
            if not patches:
                return {'status': 'already_reset', 'patch': patch_id}
            latest = patches[-1]
            if latest['id'] != patch_id:
                raise ValueError('This patch has later patches above it. Use the skill to remove it precisely while preserving them.')
            if sha(archive.raw) != latest['after_sha256']:
                raise ValueError('Live hash differs from the latest patch output.')
            target_reg = latest.get('registry_before')
            if target_reg is None:
                target_reg = json.loads(json.dumps(reg))
                target_reg['active_sha256'] = latest['before_sha256']
                target_reg['patches'] = target_reg['patches'][:-1]
        # Undo archive/stack state, while retaining later metadata and history.
        previous_state = target_reg
        target_reg = json.loads(json.dumps({**previous_state, **reg}))
        for key in ('archive', 'app_version', 'active_sha256', 'patches'):
            target_reg[key] = json.loads(json.dumps(previous_state[key]))
        result = Path(latest['backup']).read_bytes()
        baseline = Archive(result)
        baseline.verify()
        if sha(result) != latest['before_sha256'] or baseline.version() != archive.version():
            raise ValueError('Backup hash or version mismatch; no files were replaced.')
        if target_reg['active_sha256'] != sha(result) or target_reg['app_version'] != archive.version():
            raise ValueError('Backup does not match its saved registry state.')
        if not target_reg.get('patches') and b'AGY_TEMP_ANNOTATOR' in baseline.content('dist/preload.js'):
            raise ValueError('Backup contains an earlier annotation revision. Use the skill to reconstruct its registry or remove it precisely.')
        changed = [n for n, e in archive.entries() if not e.get('unpacked') and 'link' not in e
                   and archive.content(n) != baseline.content(n)]
        if dry_run:
            return {'status': 'dry_run', 'action': 'reset', 'before_sha256': sha(archive.raw),
                    'after_sha256': sha(result), 'entries': changed, 'restores_registered_patches': [p['id'] for p in target_reg['patches']]}
        # Pending reset is an undo, too: its own verified input can be recovered.
        output = self.install(archive, result, reg, target_reg,
                              'reset', patch_id, changed,
                              {'supersedes': str(transaction)} if pending else None)
        return output

    def confirm(self, validation):
        pending = self.pending()
        if not pending:
            raise ValueError('No pending transaction to confirm.')
        path = Path(pending['transaction'])
        record = read_json(path)
        self.check_pending_registry(record)
        superseded = self.superseded(record)
        archive = self.current()
        if Path(record['archive']).resolve() != self.path or sha(archive.raw) != record['after_sha256']:
            raise ValueError('Live archive differs from the pending output; cannot confirm.')
        if not validation.strip():
            raise ValueError('Describe the actual observed UI checks in --validation.')
        reg = record['registry_after']
        for item in reg['patches']:
            if item.get('status') == 'awaiting_ui':
                item.update(status='installed', validation=validation)
        history = reg.setdefault('cli_history', [])
        if not any(h['transaction'] == str(path) for h in history):
            history.append({'transaction': str(path), 'action': record['action']})
        record.update(status='installed' if record['action'] in ('apply', 'adopt') else 'reset', validation=validation,
                      confirmed_at=dt.datetime.now(dt.timezone.utc).isoformat())
        # Save the commit intent first so confirming again after an interruption is idempotent.
        atomic_json(path, record)
        atomic_json(self.state / 'registry.json', reg)
        for previous_path, previous in superseded:
            previous['status'] = 'superseded-by-reset'
            previous['superseded_by'] = str(path)
            atomic_json(previous_path, previous)
        (self.state / 'pending.json').unlink()
        return {'status': record['status'], 'sha256': sha(archive.raw), 'transaction': str(path)}


def main():
    local = Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData/Local'))
    parser = argparse.ArgumentParser(description=__doc__, epilog='Close Antigravity before apply/reset. New versions require inspection; there is no force option. No automatic reapplication or process killing.')
    parser.add_argument('--archive', type=Path, default=local / 'Programs/Antigravity/resources/app.asar', help='Installed app.asar (default: standard Windows installation)')
    parser.add_argument('--state-dir', type=Path, default=local / 'ND/Patches/Antigravity', help='Persistent registry, transactions and backups')
    commands = parser.add_subparsers(dest='command', required=True)
    commands.add_parser('status', help='Read version, integrity, patch stack and pending recovery state')
    for name in ('apply', 'reset', 'adopt'):
        help_text = {'apply': 'Apply an inspected recipe', 'reset': 'Undo the latest patch transaction or pending change; preserve earlier patches', 'adopt': 'Recognize an existing exact recipe into ND-owned state without modifying the app'}
        command = commands.add_parser(name, help=help_text[name])
        command.add_argument('--patch', default='browser-annotate', help='Patch ID (default: browser-annotate)')
        command.add_argument('--dry-run', action='store_true', help='Validate and show the plan without writing files or closing the app')
    confirm = commands.add_parser('confirm', help='Commit a pending apply/reset only after actual UI verification')
    confirm.add_argument('--validation', required=True, help='Actual UI checks observed after restarting; never claim unperformed checks')
    args = parser.parse_args()
    manager = Manager(args.archive, args.state_dir)
    try:
        if args.command == 'status':
            result = manager.status()
        elif getattr(args, 'dry_run', False):
            result = getattr(manager, args.command)(args.patch, True)
        else:
            with state_lock(manager.state):
                result = manager.confirm(args.validation) if args.command == 'confirm' else getattr(manager, args.command)(args.patch)
        print(json.dumps(result, indent=2, ensure_ascii=False))
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        parser.exit(1, f'Error: {error}\n')


if __name__ == '__main__':
    main()
