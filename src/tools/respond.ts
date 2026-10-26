import type { ToolContext } from '../context.js'
import { HelperError, describeError, fdaMessage } from '../errors.js'

// Nur von Node selbst verfasste Meldungen gehen als Detail an das Modell; Helper-Texte koennen Pfade oder Mail-Daten enthalten.
const DETAIL_CODES: ReadonlySet<string> = new Set(['INVALID_INPUT', 'INVALID_CURSOR', 'CONFIG_INVALID'])

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

/**
 * Einzige Stelle, an der Fehler zu Antworten werden. Das Modell bekommt Klartext,
 * niemals einen Stacktrace.
 *
 * Bewusst ohne `: Promise<ToolResult>`-Rueckgabetyp-Annotation: `ToolResult` hat keine
 * Indexsignatur, das SDK-eigene `CallToolResult` aber schon; eine explizite Annotation
 * macht die Rueckgabe nominell inkompatibel und laesst `registerTool` auf die veraltete
 * Raw-Shape-Ueberladung zurueckfallen. `satisfies` prueft dieselbe Form ohne Festnageln.
 */
export async function respond(produce: () => Promise<{ structured: Record<string, unknown> }>, ctx: ToolContext) {
  try {
    const { structured } = await produce()
    return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured } satisfies ToolResult
  } catch (error) {
    const openedNow = ctx.onHelperError(error)
    let text: string
    if (error instanceof HelperError) {
      text = error.code === 'FULL_DISK_ACCESS_REQUIRED' ? fdaMessage(ctx.bundlePath, openedNow, ctx.helperName) : describeError(error.code, DETAIL_CODES.has(error.code) ? error.message : undefined)
    } else {
      // Keine Nutzerdaten und kein Stacktrace an das Modell.
      text = describeError('UNKNOWN')
    }
    return { content: [{ type: 'text', text }], isError: true } satisfies ToolResult
  }
}
