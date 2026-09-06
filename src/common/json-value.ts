import type {
  ContentJsonObject,
  ContentJsonValue,
} from "@src/schemas/item_schema";
import { z } from "zod";

export type JsonObject = ContentJsonObject;
export type JsonValue = ContentJsonValue;

const jsonValueSchema: z.ZodType<JsonValue> = z.json();
const jsonObjectSchema = z.custom<JsonObject>(
  (value) =>
    value !== null &&
    value !== undefined &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype,
);
const jsonStringSchema = z.string();
const jsonFiniteNumberSchema = z.number().finite();
const jsonBooleanSchema = z.boolean();

/** Parse a library/browser value before it enters JSON-oriented domain code. */
export function parseJsonValue(value: any): JsonValue {
  return jsonValueSchema.parse(value);
}

/** Decode an HTTP response once, at the connector boundary. */
export async function readJsonResponse(response: Response): Promise<JsonValue> {
  return jsonValueSchema.parse(await response.json());
}

/** Decode a best-effort endpoint without leaking an unparsed value downstream. */
export async function tryReadJsonResponse(
  response: Response,
): Promise<JsonValue | undefined> {
  try {
    return await readJsonResponse(response);
  } catch {
    return undefined;
  }
}

export function jsonObject(value: JsonValue | undefined): JsonObject | undefined {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Parse a framework/library value at an I/O boundary into JSON object data. */
export function parseJsonObject(value: any): JsonObject {
  return jsonObjectSchema.parse(value);
}

export function copyJsonObject(value: JsonObject): JsonObject {
  return { ...value };
}

export function jsonString(value: JsonValue | undefined): string | undefined {
  const parsed = jsonStringSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function jsonFiniteNumber(value: JsonValue | undefined): number | undefined {
  const parsed = jsonFiniteNumberSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function jsonBoolean(value: JsonValue | undefined): boolean | undefined {
  const parsed = jsonBooleanSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
