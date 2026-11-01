import { z } from 'zod/v4'

// Antworten der Index-Befehle des Helpers (Spec AMM-12 5.3). Lokal, bis AMM-15 sie in src/schemas.ts fuehrt.

export const indexFeedResult = z.object({
  rows: z.array(z.object({ rowid: z.number().int(), gid: z.number().int(), date: z.number().int() })),
  maxRowid: z.number().int(),
  hasMore: z.boolean(),
})

export const indexGidsResult = z.object({
  gids: z.array(z.tuple([z.number().int(), z.boolean()])),
  hasMore: z.boolean(),
})

export type IndexFeedResult = z.infer<typeof indexFeedResult>
export type IndexGidsResult = z.infer<typeof indexGidsResult>
