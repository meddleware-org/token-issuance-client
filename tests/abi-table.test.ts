/**
 * Tests for the ABI table (`tests/abi-table.ts`): it covers every exported transaction builder, and the framework calls the builders make are exactly the two the live drift check
 * (`tests/integration/`) compares with the real framework. A new builder with no table entry fails here before it can escape that check.
 */
import { describe, it, expect } from 'vitest'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import { BUILDERS, allMoveCalls, exportedBuilders } from './abi-table.js'

describe('ABI table (feeds the live drift check)', () => {
  // A new `build…Transaction` export with no table entry would be unchecked against the chain.
  it('covers every exported transaction builder', () => {
    expect(Object.keys(BUILDERS).sort()).toEqual(exportedBuilders)
  })

  // The package's own code is published by the person, so the only calls to existing packages are these two framework functions.
  it('lists every framework call the builders can make', () => {
    const calls = allMoveCalls()
    for (const c of calls) expect(c.package).toBe(normalizeSuiAddress('0x2'))
    expect(calls.map((c) => `${c.module}::${c.function}`).sort()).toEqual([
      'coin_registry::finalize_registration',
      'package::make_immutable',
    ])
  })
})
