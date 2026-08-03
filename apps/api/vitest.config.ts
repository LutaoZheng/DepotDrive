import { defineConfig } from 'vitest/config';

// Prisma reads DATABASE_URL while modules are loaded, before test hooks execute.
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

export default defineConfig({ test: { environment: 'node' } });
