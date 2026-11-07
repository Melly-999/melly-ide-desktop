import { queryGeneric, mutationGeneric, internalMutationGeneric } from 'convex/server';
import type { DataModelFromSchemaDefinition, QueryBuilder, MutationBuilder, GenericQueryCtx, GenericMutationCtx } from 'convex/server';
import schema from './schema.ts';
export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export type QueryCtx = GenericQueryCtx<DataModel>;
export type MutationCtx = GenericMutationCtx<DataModel>;
export const query = queryGeneric as QueryBuilder<DataModel, 'public'>;
export const mutation = mutationGeneric as MutationBuilder<DataModel, 'public'>;
export const internalMutation = internalMutationGeneric as MutationBuilder<DataModel, 'internal'>;
