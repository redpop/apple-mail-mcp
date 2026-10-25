import { globSync, readFileSync, statSync } from 'node:fs'
import { expect, test } from 'vitest'

test('fixtures use reserved domains only', () => {
  const files = globSync(['fixtures/**/*', 'tests/fixtures/**/*']).filter((f) => statSync(f).isFile())
  expect(files.length).toBeGreaterThan(0)
  const bad = files.flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/[\w.+-]+@([\w-]+\.)+[\w-]+/g)]
      .map((m) => m[0])
      .filter((a) => !/@([\w-]+\.)*(example\.(com|org|net)|[\w-]+\.test)$/.test(a)),
  )
  expect(bad).toEqual([])
})
