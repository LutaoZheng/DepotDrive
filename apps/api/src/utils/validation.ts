import { NAME_MAX_LENGTH } from '@depot-drive/shared';
import { z } from 'zod';
export const safeName = z.string().trim().min(1).max(NAME_MAX_LENGTH).refine((v) => !/[\\/\0]/.test(v), 'Name cannot contain / or \\');
export const nullableId = z.string().uuid().nullable().optional();
