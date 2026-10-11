const { join } = require('node:path')
const { access } = require('node:fs/promises')

module.exports = async function checkReleasePayload({ appOutDir, electronPlatformName }) {
  const { assertNoOfficeEngines, assertTranslateManifest } = await import('./release-runtime-policy.mjs')
  const resources = electronPlatformName === 'darwin'
    ? join(appOutDir, 'ND-DSH.app', 'Contents', 'Resources')
    : join(appOutDir, 'resources')
  if (electronPlatformName === 'win32') {
    await access(join(resources, 'scripts', 'nd-agent-browser-cli.mjs'))
    await access(join(resources, 'scripts', 'nd-background-process.cjs'))
  }
  await assertTranslateManifest(join(resources, 'nd-extensions', 'translate', 'nd-extension.json'))
  await assertNoOfficeEngines(join(resources, 'vendor', 'deepseek-harness'))
}
