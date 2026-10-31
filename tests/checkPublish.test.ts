import { describe, expect, test } from 'vitest'
// @ts-expect-error: Skript ohne Typdeklaration, liegt ausserhalb von src/
import { checkPublish } from '../scripts/release/check-publish.mjs'

const release = 'Mail MCP Helper.app'

describe('checkPublish', () => {
  test('refuses outside CI', () => {
    expect(checkPublish({}, [release])).toContain('only from the release workflow')
  })

  test('accepts the release bundle in CI', () => {
    expect(checkPublish({ CI: 'true' }, [release])).toBeNull()
  })

  test.each(['Mail MCP Helper (Dev).app', 'Mail MCP Helper (Ad hoc).app'])('refuses %s next to the release bundle', (other) => {
    expect(checkPublish({ CI: 'true' }, [release, other])).toContain(other)
  })

  test('refuses without the release bundle', () => {
    expect(checkPublish({ CI: 'true' }, [])).toContain('Mail MCP Helper.app is missing')
  })
})
