import { Prisma } from '@prisma/client';
import { prisma } from '../../plugins/prisma.js';

export interface StorageEventInput {
  type: string;
  result: 'SUCCESS' | 'FAILURE' | 'INFO';
  message: string;
  fileId?: string;
  replicaId?: string;
  nodeId?: string;
  metadata?: Prisma.InputJsonValue;
}

export async function recordStorageEvent(input: StorageEventInput) {
  return prisma.systemEvent.create({ data: input });
}
