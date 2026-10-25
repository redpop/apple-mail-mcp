import { beforeEach, describe, expect, it } from 'vitest'
import { FDA_SETTINGS_URL, openFdaOnce, resetFdaPromptForTests } from '../src/fdaPrompt.js'

describe('openFdaOnce', () => {
  beforeEach(() => resetFdaPromptForTests())

  it('oeffnet Einstellungen und Finder genau einmal pro Prozess', () => {
    const calls: Array<[string, string[]]> = []
    const open = (file: string, args: string[]) => void calls.push([file, args])
    expect(openFdaOnce('/x/Mail MCP Helper.app', open)).toBe(true)
    expect(openFdaOnce('/x/Mail MCP Helper.app', open)).toBe(false)
    expect(calls).toEqual([
      ['/usr/bin/open', [FDA_SETTINGS_URL]],
      ['/usr/bin/open', ['-R', '/x/Mail MCP Helper.app']],
    ])
  })

  it('wirft nie, auch wenn open wirft', () => {
    expect(() => openFdaOnce('/x', () => { throw new Error('boom') })).not.toThrow()
  })

  it('nutzt die bekannte URL', () => {
    expect(FDA_SETTINGS_URL).toBe('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles')
  })
})
