"""Build the bundled 2.28.2 annotation candidate. No installation or app control."""
import argparse
import json
from pathlib import Path

from asar_tool import Archive, build, sha, write_new


def candidate(raw, resource_root):
    asset = resource_root / 'assets/browser-annotate'
    recipe = json.loads((asset / 'recipe.json').read_text(encoding='utf-8'))
    implementation = (asset / 'annotate.js').read_bytes()
    if sha(implementation) != recipe['implementation_sha256']:
        raise ValueError('Bundled implementation changed; review and update its recipe hash')
    archive = Archive(raw)
    if archive.version() != recipe['app_version']:
        raise ValueError('Recipe supports only Antigravity ' + recipe['app_version'])
    preload = archive.content(recipe['entry'])
    marker = recipe['marker'].encode('utf-8')
    if marker in preload:
        raise ValueError('Annotation patch already exists; inspect and revise its block instead of appending')
    for anchor in (b'const electron_1 = require("electron");',
                   b"electron_1.contextBridge.exposeInMainWorld('electronNative', electronNativeAPI);"):
        if preload.count(anchor) != 1:
            raise ValueError('Preload integration differs from the inspected build')
    appended = b'\n' + marker + b'\n' + implementation + recipe['startup_hook'].encode('utf-8')
    return build(archive, {recipe['entry']: preload + appended}, sha(raw), recipe['app_version'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path, help='Verified current installed archive or its copy')
    parser.add_argument('--expected-sha256', required=True, help='Hash from inspection; refuses changed input')
    parser.add_argument('--out', required=True, type=Path, help='New candidate archive; must not exist')
    args = parser.parse_args()
    try:
        raw = args.archive.read_bytes()
        if sha(raw) != args.expected_sha256:
            raise ValueError('Source hash changed; inspect before rebuilding')
        result = candidate(raw, Path(__file__).resolve().parents[1])
        write_new(args.out, result)
        print(json.dumps({'candidate': str(args.out), 'sha256': sha(result),
                          'installed': False, 'changed_entries': ['dist/preload.js']}, indent=2))
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f'Error: {error}\n')


if __name__ == '__main__':
    main()
