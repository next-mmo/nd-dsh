import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

it('builds metadata from committed source and refuses dirty packages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nd-catalog-build-test-'))
  try {
    await mkdir(join(directory, 'scripts'))
    await mkdir(join(directory, 'src'))
    await mkdir(join(directory, 'extensions'))
    for (const file of ['build-extension-catalog.mjs', 'validate-nd-extension.mjs']) {
      await cp(resolve('scripts', file), join(directory, 'scripts', file))
    }
    await cp(resolve('src/shared'), join(directory, 'src/shared'), { recursive: true })
    await cp(resolve('extensions/translate'), join(directory, 'extensions/translate'), { recursive: true })
    await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'junction')
    await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }))
    const git = (args) => execFileSync('git', ['-c', 'user.name=ND Test', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, stdio: 'pipe' })
    git(['init', '--quiet'])
    git(['add', 'extensions'])
    git(['commit', '--quiet', '-m', 'Fixture package'])
    const build = () => execFileSync(process.execPath, ['scripts/build-extension-catalog.mjs'], { cwd: directory, stdio: 'pipe' })
    build()
    const catalog = JSON.parse(await readFile(join(directory, '.release/nd-extension-catalog.json'), 'utf8'))
    expect(catalog.packages).toHaveLength(1)
    expect(catalog.packages[0].revision).toMatch(/^[a-f0-9]{40}$/)
    expect(catalog.packages[0].files.some((file) => file.path === 'nd-extension.json' && /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true)
    await writeFile(join(directory, 'extensions/translate/README.md'), 'Changed package')
    expect(build).toThrow()
    const revision = git(['rev-parse', 'HEAD']).toString().trim()
    execFileSync(process.execPath, ['scripts/build-extension-catalog.mjs', '--revision', revision, '--packages', 'translate'], { cwd: directory, stdio: 'pipe' })
    const committed = JSON.parse(await readFile(join(directory, '.release/nd-extension-catalog.json'), 'utf8'))
    expect(committed.packages[0].revision).toBe(revision)
    expect(committed.packages[0].files.some((file) => file.path === 'README.md')).toBe(false)
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 15_000)
