import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { arch as osArch, homedir } from 'node:os'
import type { Writable } from 'node:stream'
import type { ConfigResult } from '../config.js'
import { describeError, HelperError } from '../errors.js'
import type { HelperRunner } from '../helper.js'
import { parseMailbox, type MailboxRole } from '../mailboxes.js'
import { computePolicy } from '../policy.js'
import { helloResult, listMailboxesResult, probeResult, searchResult, type ProbeResult } from '../schemas.js'
import { RELEASE_BUNDLE_ID, readBundleId, readBundleName } from '../signing.js'
import { readState } from '../state.js'
import { PROTOCOL_VERSION } from '../stdioRunner.js'

export type DoctorExec = (file: string, args: string[]) => { stdout: string; stderr: string; status: number }

/** Systemtool mit absolutem Pfad, nie ueber eine Shell; wirft nie. */
export const defaultDoctorExec: DoctorExec = (file, args) => {
  const r = spawnSync(file, args, { encoding: 'utf8' })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 }
}

export interface DoctorDeps {
  runner: HelperRunner
  bundlePath: string
  configResult: ConfigResult
  exec: DoctorExec
  out: Writable
  verbose: boolean
  json: boolean
  stateDir?: string
  /** `--schema`: nur Fingerabdruck, fehlende Spalten und CREATE-Zeilen. */
  schema?: boolean
  packageVersion?: string
  /** Nur fuer Tests: Home-Verzeichnis, das in der Standardausgabe zu ~ wird. */
  home?: string
}

/** Ersetzt das Home-Verzeichnis durch ~ (Standardausgabe enthaelt keinen Benutzernamen). */
export function tildePath(path: string, home: string = homedir()): string {
  return home !== '' && home !== '/' && (path === home || path.startsWith(home + '/')) ? '~' + path.slice(home.length) : path
}

type Status = 'ok' | 'warn' | 'fail'
interface Check {
  id: string
  status: Status
  message: string
}

function packageVersion(): string {
  try {
    const url = new URL('../../package.json', import.meta.url)
    return (JSON.parse(readFileSync(url, 'utf8')) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

// Helper-Details (Pfade, Datenbanktext) nur mit --verbose; sonst nur der feste Text zum Code.
function errText(e: unknown, verbose = false): string {
  return e instanceof HelperError ? describeError(e.code, verbose ? e.message : undefined) : 'The helper could not be started.'
}

interface Signature {
  identifier: string | null
  authority: string | null
  team: string | null
  runtime: boolean
}

function parseCodesign(text: string): Signature {
  const pick = (re: RegExp): string | null => re.exec(text)?.[1]?.trim() ?? null
  return {
    identifier: pick(/^Identifier=(.+)$/m),
    authority: pick(/^Authority=(.+)$/m),
    team: pick(/^TeamIdentifier=(.+)$/m),
    runtime: /^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b/m.test(text),
  }
}

const VERBOSE_WARNING = 'Warning: verbose output contains mailbox names and account identifiers. Do not paste it publicly.'

export async function runDoctor(deps: DoctorDeps): Promise<number> {
  const { out, runner } = deps
  const checks: Check[] = []
  const add = (id: string, status: Status, message: string): void => void checks.push({ id, status, message })
  const verboseLines: string[] = []

  // --schema ohne --json: eigener, minimaler Pfad.
  if (deps.schema && !deps.json) return runSchema(deps)

  const override = deps.configResult.ok && deps.configResult.config.helperPath !== null
  const channel = override ? 'override' : deps.bundlePath.includes('/Claude Extensions/') ? 'mcpb' : 'npm'

  let helperVersion = 'unknown'
  let protocol = 'unknown'
  try {
    const h = helloResult.parse(await runner.run('hello', {}))
    helperVersion = h.helperVersion
    protocol = String(h.protocolVersion)
  } catch {
    // Der probe-Schritt meldet das Problem mit Klartext.
  }
  add(
    'versions',
    protocol === 'unknown' || Number(protocol) === PROTOCOL_VERSION ? 'ok' : 'fail',
    `Package ${deps.packageVersion ?? packageVersion()}, helper ${helperVersion}, protocol ${protocol}, install channel ${channel}.`,
  )

  let probe: ProbeResult | null = null
  let probeError: string | null = null
  try {
    probe = probeResult.parse(await runner.run('probe', {}))
  } catch (e) {
    probeError = errText(e, deps.verbose)
  }
  add('system', 'ok', `macOS ${probe?.osVersion ?? 'unknown'}, ${osArch()}, Node ${process.versions.node}.`)

  // Helper-Bundle, Signatur, Stapling
  const shownBundle = deps.verbose ? deps.bundlePath : tildePath(deps.bundlePath, deps.home)
  let bundleId: string | null = null
  const execOne = (f: string, a: string[]): string => {
    const r = deps.exec(f, a)
    if (r.status !== 0) throw new Error('exec failed')
    return r.stdout
  }
  const helperName = readBundleName(deps.bundlePath, execOne)
  try {
    bundleId = readBundleId(deps.bundlePath, execOne)
  } catch {
    bundleId = null
  }
  const isRelease = bundleId === RELEASE_BUNDLE_ID
  add('helper-bundle', bundleId ? 'ok' : 'fail', bundleId ? `Bundle ${shownBundle}, identifier ${bundleId}.` : `Bundle ${shownBundle} has no readable identifier.`)

  const cs = deps.exec('/usr/bin/codesign', ['-dv', '--verbose=2', deps.bundlePath])
  if (cs.status !== 0) {
    add('signature', 'fail', 'The helper bundle signature could not be read.')
  } else {
    const sig = parseCodesign(cs.stderr + '\n' + cs.stdout)
    const authority = sig.authority ?? 'none (ad-hoc)'
    const detail = `Authority ${authority}, team ${sig.team ?? 'none'}, hardened runtime ${sig.runtime ? 'on' : 'off'}.`
    add('signature', isRelease && (!sig.runtime || sig.team === null) ? 'fail' : sig.runtime || isRelease ? 'ok' : 'warn', detail)
  }
  const st = deps.exec('/usr/bin/xcrun', ['stapler', 'validate', deps.bundlePath])
  add('stapling', st.status === 0 ? 'ok' : isRelease ? 'fail' : 'warn', st.status === 0 ? 'Notarization ticket is stapled.' : 'Not stapled.')

  // probe
  if (probe === null) {
    add('probe', 'fail', probeError ?? 'The helper did not answer.')
  } else if (probe.access !== 'granted') {
    const msg =
      probe.access === 'denied'
        ? `Access: denied. Full Disk Access is not granted to ${helperName}. Run \`npx -y @redpop/apple-mail-mcp setup\`.`
        : probe.access === 'no_mail_data'
          ? 'Access: no_mail_data. Apple Mail does not appear to be set up on this Mac.'
          : 'Access: untrusted_signature. The helper refused to read mail because its signature is not trusted.'
    add('probe', 'fail', msg)
  } else if (!probe.schema) {
    add('probe', 'fail', 'Mail database could not be read (busy or damaged); try again.')
  } else {
    const s = probe.schema
    const c = probe.counts
    add('probe', s && !s.compatible ? 'fail' : 'ok', `Access granted, Mail directory ${probe.mailDir ?? 'unknown'}.`)
    if (s) {
      add('schema', s.compatible ? 'ok' : 'fail', s.compatible ? `Schema compatible, fingerprint ${s.fingerprint}.` : `Schema not supported, missing columns: ${s.missing.join(', ')}; fingerprint ${s.fingerprint}.`)
    }
    if (c) add('counts', 'ok', `${c.mailboxes} mailboxes, ${c.messages} messages, ${c.uniqueMessages} unique.`)
  }

  if (probe) {
    const an = probe.accountNames
    add(
      'account-names',
      an.status === 'available' && an.unmatchedAccounts === 0 ? 'ok' : 'warn',
      an.status === 'available'
        ? `Account names available; ${an.unmatchedAccounts} mail accounts without a match.`
        : `Account names unavailable${deps.verbose && an.reason ? ` (${an.reason})` : ''}; ${an.unmatchedAccounts} mail accounts without a match.`,
    )
  }

  // Verwaister FDA-Eintrag (Schluss aus der Zustandsdatei, keine Messung; Spec 12.4, E3)
  if (probe?.access === 'denied') {
    const state = readState(deps.stateDir)
    if (state) {
      add(
        'stale-fda',
        'fail',
        `Access worked on ${state.lastAccessOk.slice(0, 10)}. Since then macOS denies it. If ${helperName} is listed and switched on, remove the entry and add it again.`,
      )
    }
  }

  // Mailbox-Rollen, Abdeckung, Konfiguration
  if (probe?.access === 'granted' && probe.schema) {
    try {
      const list = listMailboxesResult.parse(await runner.run('list-mailboxes', {}))
      const parsed = list.mailboxes.map(parseMailbox)
      const roles = new Map<MailboxRole, number>()
      for (const m of parsed) roles.set(m.role, (roles.get(m.role) ?? 0) + 1)
      const summary = [...roles].map(([r, n]) => `${r} ${n}`).join(', ')
      const missing = (['junk', 'trash'] as const).filter((r) => !roles.has(r))
      add(
        'mailbox-roles',
        missing.length > 0 && parsed.length > 0 ? 'warn' : 'ok',
        missing.length > 0 && parsed.length > 0
          ? `Roles: ${summary || 'none'}. No ${missing.join(' or ')} mailbox recognised although accounts exist.`
          : `Roles: ${summary}.`,
      )
      if (deps.verbose) {
        for (const m of parsed) verboseLines.push(`mailbox ${m.id}: ${m.name} (${m.role})`)
        for (const a of new Set(parsed.map((m) => m.accountId))) verboseLines.push(`account ${a}`)
      }

      if (deps.configResult.ok) {
        const policy = computePolicy(deps.configResult.config, list)
        add('config', policy.unmatchedAllowlistEntries > 0 ? 'warn' : 'ok', `Effective policy ${policy.fingerprint}: ${policy.allowedMailboxIds.length} of ${parsed.length} mailboxes visible, ${policy.unmatchedAllowlistEntries} account allowlist entries without a match.`)
        try {
          const res = searchResult.parse(
            await runner.run('search', { allowedMailboxIds: policy.allowedMailboxIds, limit: 500, countTotal: false, maxRecipients: 0 }),
          )
          const n = { full: 0, partial: 0, none: 0 }
          for (const m of res.messages) n[m.file]++
          add('local-files', 'ok', `Of the ${res.messages.length} newest messages: full ${n.full}, partial ${n.partial}, none ${n.none}.`)
        } catch (e) {
          add('local-files', 'warn', `Local file coverage could not be measured. ${errText(e, deps.verbose)}`)
        }
      }
    } catch (e) {
      add('mailbox-roles', 'fail', `Mailboxes could not be listed. ${errText(e, deps.verbose)}`)
    }
  }
  if (!deps.configResult.ok) add('config', 'fail', `Configuration error in ${deps.configResult.key}: ${deps.configResult.error}`)

  const exit = checks.some((c) => c.status === 'fail') ? 1 : 0
  if (deps.json) {
    const body: Record<string, unknown> = { checks, exitCode: exit }
    if (deps.verbose) body.verbose = { warning: VERBOSE_WARNING, lines: verboseLines }
    if (deps.schema) body.schema = (await schemaLines(deps)).lines
    out.write(JSON.stringify(body) + '\n')
  } else {
    if (deps.verbose) out.write(VERBOSE_WARNING + '\n')
    for (const c of checks) out.write(`[${c.status}] ${c.id}: ${c.message}\n`)
    for (const l of verboseLines) out.write(l + '\n')
  }
  return exit
}

async function schemaLines(deps: DoctorDeps): Promise<{ lines: string[]; ok: boolean }> {
  let raw: unknown
  try {
    raw = await deps.runner.run('probe', {})
  } catch (e) {
    return { lines: [errText(e, deps.verbose)], ok: false }
  }
  const p = probeResult.safeParse(raw)
  if (!p.success || !p.data.schema) return { lines: ['No schema information available.'], ok: false }
  const lines = [p.data.schema.fingerprint, ...p.data.schema.missing]
  // Nur Anweisungen, die mit CREATE beginnen, je eine Zeile (mehrzeiliges DDL zusammengezogen).
  for (const statement of p.data.schema.ddl ?? []) {
    if (statement.startsWith('CREATE ')) lines.push(statement.replace(/\s+/g, ' ').trim())
  }
  return { lines, ok: true }
}

/** `doctor --schema`: nur Fingerabdruck, fehlende Spalten und ggf. CREATE-Zeilen, sonst nichts. */
async function runSchema(deps: DoctorDeps): Promise<number> {
  const r = await schemaLines(deps)
  deps.out.write(r.lines.join('\n') + '\n')
  return r.ok ? 0 : 1
}
