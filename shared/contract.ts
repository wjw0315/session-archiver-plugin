import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const archiverConfigSchema = z.object({
  idleDays: z.number(),
  intervalMin: z.number(),
  dryRun: z.boolean(),
  enabled: z.boolean(),
  maxPerSweep: z.number(),
  protectedLabels: z.array(z.string()),
});

const statusSchema = z.object({
  config: archiverConfigSchema,
  lastSweepAt: z.string().nullable(),
  lastMode: z.string().nullable(),
  scanned: z.number(),
  candidates: z.number(),
  totalArchived: z.number(),
  rows: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      days: z.number(),
    }),
  ),
  history: z.array(
    z.object({
      at: z.string(),
      mode: z.string(),
      candidates: z.number(),
      archived: z.number(),
      ok: z.number(),
    }),
  ),
});

export const archiverStatus = defineRpc({
  name: "archiver.status",
  input: z.object({}),
  output: statusSchema,
});

export const archiverScanNow = defineRpc({
  name: "archiver.scan-now",
  input: z.object({}),
  output: statusSchema,
});

export const archiverSetConfig = defineRpc({
  name: "archiver.set-config",
  input: archiverConfigSchema.partial(),
  output: statusSchema,
});

export type ArchiverStatus = z.infer<typeof statusSchema>;
