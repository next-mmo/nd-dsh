import type { CoreClient } from './core-client.js'
import type { PackageSnapshot } from '../extensions/package-store.js'

/** Heavy traversal/copying happens in Rust; main retains manifest/activation semantics. */
export function createCorePackageSnapshot(core: Pick<CoreClient, 'request'>): PackageSnapshot {
  return async (source, destination, expectedManifest) => {
    await core.request('extensions.snapshot', { source, destination, expectedManifest }, 60_000)
  }
}
