/**
 * Tests for the Move.lock renderer (`src/package.ts`): if the template's lock stops having exactly one root-package pin, or still names the template elsewhere, rendering fails loudly
 * instead of producing a lock that pins the wrong package. The template text is replaced with a broken lock through a module mock.
 */
import { describe, it, expect, vi } from 'vitest'
import type { TokenConfig } from '../src/types.js'

// A valid configuration, the same for every case.
const config: TokenConfig = {
  packageName: 'my_token',
  moduleName: 'mytoken',
  structName: 'MYTOKEN',
  symbol: 'MTK',
  name: 'My Token',
  description: 'A friendly token',
  iconUrl: 'https://example.com/icon.png',
  decimals: 8,
  initialSupply: 0n,
  supplyPolicy: 'mintable',
  metadataPolicy: 'updatable',
  packagePolicy: 'immutable',
  recipient: '0x' + 'ab'.repeat(32),
  license: 'MIT',
  licenseName: 'MIT License',
  packageDescription: 'Official MYTOKEN token.',
  projectName: 'My Project',
}

// Template drift in Move.lock must fail loudly rather than render a lock that pins the wrong package.
/** Render the package with a replaced template `Move.lock` (the template module is re-imported with the fake lock) and return the render call, so a test can expect it to throw. */
async function renderWithLock(lock: string) {
  vi.resetModules()
  vi.doMock('../src/template/files.js', async (original) => {
    const real = await original<typeof import('../src/template/files.js')>()
    return { ...real, TEMPLATE_FILES: { ...real.TEMPLATE_FILES, 'Move.lock': lock } }
  })
  const { buildPackageFiles } = await import('../src/package.js')
  return () => buildPackageFiles({ config })
}

describe('Move.lock template drift', () => {
  const root = '[pinned.testnet.token_issuance_template]'

  // Each case breaks the one fact the renderer relies on: exactly one root pin, and the template's name nowhere else.
  it('refuses a lock without the root package pin', async () => {
    expect(await renderWithLock('[move]\nversion = 4\n')).toThrow(/exactly one line/)
  })

  it('refuses a lock with two root package pins', async () => {
    expect(await renderWithLock(`${root}\nuse_environment = "testnet"\n${root}\n`)).toThrow(/exactly one line/)
  })

  it('refuses a lock that still names the template elsewhere', async () => {
    expect(await renderWithLock(`${root}\ndeps = { x = "token_issuance_template" }\n`)).toThrow(/still in Move.lock/)
  })

  // The positive control: the same mock path with a good lock renders, so the refusals above are about the lock and not about the mock.
  it('renders a well-formed lock', async () => {
    const files = (await renderWithLock(`${root}\nuse_environment = "testnet"\n`))()
    expect(files['Move.lock']).toBe('[pinned.testnet.my_token]\nuse_environment = "testnet"\n')
  })
})
