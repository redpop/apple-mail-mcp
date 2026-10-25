import { describe, expect, it } from 'vitest'
import { ADHOC_BUNDLE_ID, checkBundle, DEV_BUNDLE_ID, readBundleId, RELEASE_BUNDLE_ID, RELEASE_REQUIREMENT, TEAM_ID, type ExecFn } from '../src/signing.js'

function fakeExec(o: { plutil: string; codesignExit?: number }): ExecFn & { calls: [string, string[]][] } {
  const calls: [string, string[]][] = []
  const f = ((file: string, args: string[]) => {
    calls.push([file, args])
    if (file === '/usr/bin/plutil') return o.plutil + '\n'
    if (file === '/usr/bin/codesign') {
      if ((o.codesignExit ?? 0) !== 0) throw new Error('codesign failed')
      return ''
    }
    throw new Error('unexpected ' + file)
  }) as ExecFn & { calls: [string, string[]][] }
  f.calls = calls
  return f
}
const exists = () => true

describe('signing', () => {
  it('constants', () => {
    expect(TEAM_ID).toBe('4KTGF63CD2')
    expect(DEV_BUNDLE_ID).toBe(RELEASE_BUNDLE_ID + '.dev')
    expect(ADHOC_BUNDLE_ID).toBe(RELEASE_BUNDLE_ID + '.adhoc')
    expect(RELEASE_REQUIREMENT).toContain(`certificate leaf[subject.OU] = "${TEAM_ID}"`)
    expect(RELEASE_REQUIREMENT).toContain(`identifier "${RELEASE_BUNDLE_ID}"`)
  })

  it('reads the bundle id with plutil', () => {
    const exec = fakeExec({ plutil: 'a.b' })
    expect(readBundleId('/b', exec)).toBe('a.b')
    expect(exec.calls[0]).toEqual(['/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', '/b/Contents/Info.plist']])
  })

  it('release id with bad signature is refused', () => {
    expect(() => checkBundle('/b', { override: false, exec: fakeExec({ plutil: RELEASE_BUNDLE_ID, codesignExit: 1 }), exists })).toThrow(/signature/)
    try {
      checkBundle('/b', { override: false, exec: fakeExec({ plutil: RELEASE_BUNDLE_ID, codesignExit: 1 }), exists })
    } catch (e) {
      expect((e as { code: string }).code).toBe('HELPER_SIGNATURE_INVALID')
    }
  })

  it('release id with good signature passes and uses the requirement', () => {
    const exec = fakeExec({ plutil: RELEASE_BUNDLE_ID })
    checkBundle('/b', { override: false, exec, exists })
    expect(exec.calls[1]).toEqual(['/usr/bin/codesign', ['--verify', '--strict', '--deep', `-R=${RELEASE_REQUIREMENT}`, '/b']])
  })

  it('override with release id is refused', () => {
    const exec = fakeExec({ plutil: RELEASE_BUNDLE_ID })
    expect(() => checkBundle('/b', { override: true, exec, exists })).toThrowError(expect.objectContaining({ code: 'HELPER_SIGNATURE_INVALID' }))
  })

  it('dev bundle via override passes without codesign', () => {
    for (const id of [DEV_BUNDLE_ID, ADHOC_BUNDLE_ID]) {
      const exec = fakeExec({ plutil: id })
      checkBundle('/b', { override: true, exec, exists })
      expect(exec.calls.some(([f]) => f === '/usr/bin/codesign')).toBe(false)
    }
  })

  it('non-release id without override is refused', () => {
    expect(() => checkBundle('/b', { override: false, exec: fakeExec({ plutil: DEV_BUNDLE_ID }), exists })).toThrowError(expect.objectContaining({ code: 'HELPER_SIGNATURE_INVALID' }))
  })

  it('missing bundle is HELPER_MISSING', () => {
    expect(() => checkBundle('/b', { override: false, exec: fakeExec({ plutil: '' }), exists: () => false })).toThrowError(expect.objectContaining({ code: 'HELPER_MISSING' }))
  })

  it('unreadable Info.plist is refused', () => {
    const exec = (() => { throw new Error('boom') }) as ExecFn
    expect(() => checkBundle('/b', { override: true, exec, exists })).toThrowError(expect.objectContaining({ code: 'HELPER_SIGNATURE_INVALID' }))
  })
})
