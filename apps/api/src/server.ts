import { buildApp } from './app.js'; import { loadEnv } from './config/env.js'; import { prisma } from './plugins/prisma.js';
const env=loadEnv();const app=await buildApp({env});
async function shutdown(signal:string){app.log.info({signal},'Shutting down');await app.close();await prisma.$disconnect();process.exit(0)}
process.on('SIGINT',()=>void shutdown('SIGINT'));process.on('SIGTERM',()=>void shutdown('SIGTERM'));
try{await prisma.$connect();await app.listen({port:env.API_PORT,host:'0.0.0.0'});}catch(error){app.log.error(error);await prisma.$disconnect();process.exit(1)}
