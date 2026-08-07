import type { RxJsonSchema, RxStorage, RxStorageInstanceCreationParams } from "rxdb";

const getFlatIndexFields = (schema: RxJsonSchema<any>): string[] => {
  const indexes = schema.indexes || [];
  return indexes
    .flatMap((index) => (Array.isArray(index) ? index : [index]))
    .filter((field): field is string => typeof field === "string" && !field.includes("."));
};

export const requireDexieIndexFields = <DocType>(schema: RxJsonSchema<DocType>): RxJsonSchema<DocType> => {
  const required = new Set<string>(Array.from(schema.required || []) as string[]);
  let changed = false;

  for (const field of getFlatIndexFields(schema)) {
    if (required.has(field)) continue;
    required.add(field);
    changed = true;
  }

  if (!changed) return schema;
  return {
    ...schema,
    required: Array.from(required) as string[],
  } as RxJsonSchema<DocType>;
};

export const withDexieRequiredIndexes = <Internals, InstanceCreationOptions>(
  storage: RxStorage<Internals, InstanceCreationOptions>
): RxStorage<Internals, InstanceCreationOptions> => {
  return {
    ...storage,
    createStorageInstance(params: RxStorageInstanceCreationParams<any, InstanceCreationOptions>) {
      return storage.createStorageInstance({
        ...params,
        schema: requireDexieIndexFields(params.schema),
      });
    },
  };
};
