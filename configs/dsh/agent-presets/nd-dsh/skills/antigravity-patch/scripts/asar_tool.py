"""Read/verify ASARs and build candidates. Never installs or overwrites a file."""
import argparse
import copy
import hashlib
import json
from pathlib import Path, PurePosixPath
import struct


def sha(data):
    return hashlib.sha256(data).hexdigest()


class Archive:
    def __init__(self, data):
        self.raw = data
        if len(data) < 16:
            raise ValueError('Truncated ASAR')
        size_payload, header_size, payload_size, json_size = struct.unpack('<4I', data[:16])
        if size_payload != 4 or header_size != payload_size + 4 or json_size > payload_size - 4:
            raise ValueError('Unsupported ASAR header')
        if 8 + header_size > len(data):
            raise ValueError('Truncated ASAR header')
        self.header = json.loads(data[16:16 + json_size])
        self.body = data[8 + header_size:]

    def entries(self, tree=None, prefix=''):
        for name, entry in (self.header if tree is None else tree)['files'].items():
            path = prefix + name
            if 'files' in entry:
                yield from self.entries(entry, path + '/')
            else:
                yield path, entry

    def content(self, name):
        parts = PurePosixPath(name)
        if parts.is_absolute() or '..' in parts.parts or '\\' in name:
            raise ValueError('Expected an archive-relative POSIX entry name')
        entry = dict(self.entries()).get(name)
        if entry is None:
            raise ValueError(f'Entry not found: {name}')
        if entry.get('unpacked') or 'link' in entry or 'offset' not in entry:
            raise ValueError(f'Only ordinary packed entries are supported: {name}')
        offset, size = int(entry['offset']), entry['size']
        if offset < 0 or size < 0 or offset + size > len(self.body):
            raise ValueError(f'Invalid bounds: {name}')
        return self.body[offset:offset + size]

    def verify(self):
        count, ranges = 0, []
        for name, entry in self.entries():
            if entry.get('unpacked') or 'link' in entry:
                continue
            data = self.content(name)
            integrity = entry.get('integrity')
            if integrity:
                if integrity['algorithm'] != 'SHA256' or sha(data) != integrity['hash']:
                    raise ValueError(f'Integrity mismatch: {name}')
                block_size = integrity['blockSize']
                if not isinstance(block_size, int) or block_size <= 0:
                    raise ValueError(f'Invalid block size: {name}')
                blocks = [sha(data[i:i + block_size]) for i in range(0, len(data), block_size)]
                if blocks != integrity['blocks']:
                    raise ValueError(f'Block integrity mismatch: {name}')
            if data:
                ranges.append((int(entry['offset']), int(entry['offset']) + len(data), name))
            count += 1
        ranges.sort()
        for a, b in zip(ranges, ranges[1:]):
            if a[1] > b[0]:
                raise ValueError(f'Overlapping entries: {a[2]}, {b[2]}')
        return count

    def version(self):
        return json.loads(self.content('package.json'))['version']


def encode(header, body):
    encoded = json.dumps(header, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    string_payload = struct.pack('<I', len(encoded)) + encoded
    string_payload += b'\0' * (-len(string_payload) % 4)
    header_pickle = struct.pack('<I', len(string_payload)) + string_payload
    return struct.pack('<II', 4, len(header_pickle)) + header_pickle + body


def build(archive, replacements, expected_sha256, expected_version):
    if sha(archive.raw) != expected_sha256:
        raise ValueError('Source hash changed; inspect before rebuilding')
    archive.verify()
    if archive.version() != expected_version:
        raise ValueError('Source version differs from the inspected version')
    if not replacements:
        raise ValueError('No replacements supplied')
    for name in replacements:
        archive.content(name)  # Reject new, unpacked, link and absent entries.
    header = copy.deepcopy(archive.header)
    candidate = Archive(encode(header, archive.body))
    chunks, cursor = [], 0
    entries = [(name, entry) for name, entry in candidate.entries()
               if not entry.get('unpacked') and 'link' not in entry]
    for name, entry in sorted(entries, key=lambda pair: int(pair[1]['offset'])):
        data = replacements.get(name, archive.content(name))
        if not isinstance(data, bytes):
            raise ValueError(f'Replacement must be bytes: {name}')
        if name in replacements:
            block_size = entry.get('integrity', {}).get('blockSize', 4194304)
            entry['integrity'] = {
                'algorithm': 'SHA256', 'hash': sha(data), 'blockSize': block_size,
                'blocks': [sha(data[i:i + block_size]) for i in range(0, len(data), block_size)]}
        entry['offset'], entry['size'] = str(cursor), len(data)
        chunks.append(data)
        cursor += len(data)
    result = encode(candidate.header, b''.join(chunks))
    checked = Archive(result)
    checked.verify()
    for name, entry in archive.entries():
        if name not in replacements and not entry.get('unpacked') and 'link' not in entry:
            if archive.content(name) != checked.content(name):
                raise ValueError(f'Unrelated content changed: {name}')
    return result


def write_new(path, data):
    with Path(path).open('xb') as output:
        output.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    for action in ('inspect', 'verify', 'extract', 'build'):
        command = sub.add_parser(action)
        command.add_argument('archive', type=Path)
        if action == 'extract':
            command.add_argument('entry')
            command.add_argument('--out', required=True, type=Path)
        if action == 'build':
            command.add_argument('--replacements', required=True, type=Path,
                                 help='JSON map of ASAR entry to file; relative files resolve beside this JSON')
            command.add_argument('--expected-sha256', required=True)
            command.add_argument('--expected-version', required=True)
            command.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    try:
        archive = Archive(args.archive.read_bytes())
        if args.action in ('inspect', 'verify'):
            count = archive.verify()
            result = {'sha256': sha(archive.raw), 'version': archive.version(),
                      'verified_packed_entries': count, 'unpacked_files_verified': False}
            if args.action == 'inspect':
                result['entries'] = [{'path': name, 'size': entry.get('size'),
                                      'unpacked': bool(entry.get('unpacked')), 'link': entry.get('link')}
                                     for name, entry in archive.entries() if not name.startswith('node_modules/')]
            print(json.dumps(result, indent=2))
        elif args.action == 'extract':
            archive.verify()
            write_new(args.out, archive.content(args.entry))
            print(f'Extracted {args.entry} to {args.out}')
        else:
            mapping = json.loads(args.replacements.read_text(encoding='utf-8-sig'))
            replacements = {name: (args.replacements.parent / file).read_bytes() for name, file in mapping.items()}
            result = build(archive, replacements, args.expected_sha256, args.expected_version)
            write_new(args.out, result)
            print(json.dumps({'output': str(args.out), 'sha256': sha(result),
                              'changed_entries': [name for name in replacements if replacements[name] != archive.content(name)]}, indent=2))
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.exit(1, f'Error: {error}\n')


if __name__ == '__main__':
    main()
