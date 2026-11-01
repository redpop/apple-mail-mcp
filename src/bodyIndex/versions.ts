import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

// Quelltext eines Moduls neben diesem: .js in dist/, .ts unter vitest.
function moduleSource(name: string): string {
  for (const ext of ['.js', '.ts']) {
    try {
      return readFileSync(join(srcRoot, `${name}${ext}`), 'utf8')
    } catch {
      // naechste Endung
    }
  }
  return `missing:${name}`
}

function packageVersion(name: string): string {
  try {
    return (require(`${name}/package.json`) as { version: string }).version
  } catch {
    return 'unknown'
  }
}

const hash = (parts: string[]): string => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 16)

let classifier: string | null = null
let parser: string | null = null

/** Hash ueber Woerterlisten und Klassifikationslogik (Spec 5.6). */
export function classifierVersion(): string {
  classifier ??= hash(['securityMail.data', 'securityMail', 'fold'].map(moduleSource))
  return classifier
}

/** Hash ueber MIME-Parser und Versionen von postal-mime und html-to-text (Spec 5.5). */
export function parserVersion(): string {
  parser ??= hash([...['mime', 'mimeTrim', 'quickHtml'].map(moduleSource), packageVersion('postal-mime'), packageVersion('html-to-text')])
  return parser
}
