import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { HelperError } from './errors.js'

// Team-ID und Bundle-IDs stehen auch in swift/build.sh (Spec 13.1); wer forkt, aendert beide Stellen.
export const TEAM_ID = '4KTGF63CD2'
export const RELEASE_BUNDLE_ID = 'io.github.redpop.apple-mail-mcp.mail-helper'
export const DEV_BUNDLE_ID = RELEASE_BUNDLE_ID + '.dev'
export const ADHOC_BUNDLE_ID = RELEASE_BUNDLE_ID + '.adhoc'

export const RELEASE_REQUIREMENT =
  `identifier "${RELEASE_BUNDLE_ID}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[subject.OU] = "${TEAM_ID}"`

/** Fuehrt ein System-Tool mit absolutem Pfad aus; wirft bei Exit-Code != 0. */
export type ExecFn = (file: string, args: string[]) => string

const defaultExec: ExecFn = (file, args) => execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export function readBundleId(bundle: string, exec: ExecFn = defaultExec): string {
  return exec('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', `${bundle}/Contents/Info.plist`]).trim()
}

const invalid = (why: string): HelperError => new HelperError('HELPER_SIGNATURE_INVALID', why)

/**
 * Signaturgatter vor dem ersten Start (Spec 13.1, 13.3). Wirft HelperError, sonst kehrt es zurueck.
 * Der Override erlaubt nur Dev- und Ad-hoc-Bundles; eine Release-ID per Override waere ein
 * fremder Build, der die Freigabe des Nutzers abschalten koennte.
 */
export function checkBundle(
  bundle: string,
  opts: { override: boolean; exec?: ExecFn; exists?: (path: string) => boolean },
): void {
  const exec = opts.exec ?? defaultExec
  if (!(opts.exists ?? existsSync)(bundle)) throw new HelperError('HELPER_MISSING', `Helper bundle not found: ${bundle}`)

  let id: string
  try {
    id = readBundleId(bundle, exec)
  } catch {
    throw invalid('The helper bundle has no readable bundle identifier, so its signature cannot be trusted.')
  }

  if (id === RELEASE_BUNDLE_ID) {
    if (opts.override) throw invalid('A helper path override must not point to a release-signed bundle; use a development or ad-hoc build.')
    try {
      exec('/usr/bin/codesign', ['--verify', '--strict', '--deep', `-R=${RELEASE_REQUIREMENT}`, bundle])
    } catch {
      throw invalid('The helper bundle signature does not satisfy the release requirement.')
    }
    return
  }
  if (opts.override && (id === DEV_BUNDLE_ID || id === ADHOC_BUNDLE_ID)) return
  throw invalid('The helper bundle has an unexpected bundle identifier, so its signature is not accepted.')
}
