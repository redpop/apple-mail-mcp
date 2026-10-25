/** message://-Link zur Message-ID (mit spitzen Klammern, percent-kodiert); null ohne Header. */
export function messageLink(header: string | null): string | null {
  const t = header?.trim() ?? ''
  if (t === '') return null
  const id = t.startsWith('<') && t.endsWith('>') ? t : `<${t}>`
  return `message://${encodeURIComponent(id)}`
}
