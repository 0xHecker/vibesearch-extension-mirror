import { getDb } from "@src/services/DatabaseService";
import type {
  SpaceDatabase,
  SpacesControllerOptions,
} from "@src/services/spaces/types";
import { z } from "zod";

const storedStringSchema = z.string().min(1);
const storedNumberSchema = z.number().finite();

export function getSpaceDatabase(options: SpacesControllerOptions): Promise<SpaceDatabase> {
  return (options.getDb ?? getDb)();
}

export function getSpaceClock(options: SpacesControllerOptions): number {
  return options.now?.() ?? Date.now();
}

export async function readStoredString(
  options: SpacesControllerOptions,
  key: string,
): Promise<string | undefined> {
  const db = await getSpaceDatabase(options);
  const parsed = storedStringSchema.safeParse((await db.getLocal(key))?.get("value"));
  return parsed.success ? parsed.data : undefined;
}

export async function readStoredNumber(
  options: SpacesControllerOptions,
  key: string,
): Promise<number | undefined> {
  const db = await getSpaceDatabase(options);
  const parsed = storedNumberSchema.safeParse((await db.getLocal(key))?.get("value"));
  return parsed.success ? parsed.data : undefined;
}

export async function writeStoredValue(
  options: SpacesControllerOptions,
  key: string,
  value: string | number,
): Promise<void> {
  const db = await getSpaceDatabase(options);
  await db.upsertLocal(key, { value });
}
