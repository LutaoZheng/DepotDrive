import { buildApp } from './app.js'; import { loadEnv } from './config/env.js'; import { prisma } from './plugins/prisma.js';
import { cleanupExpiredUploads } from './modules/uploads/service.js';
const env=loadEnv();const app=await buildApp({env});
let cleanupTimer:NodeJS.Timeout|undefined;async function shutdown(signal:string){app.log.info({signal},'Shutting down');if(cleanupTimer)clearInterval(cleanupTimer);await app.close();await prisma.$disconnect();process.exit(0)}
process.on('SIGINT',()=>void shutdown('SIGINT'));process.on('SIGTERM',()=>void shutdown('SIGTERM'));
try{await prisma.$connect();await cleanupExpiredUploads(app.storage,app.log);cleanupTimer=setInterval(()=>void cleanupExpiredUploads(app.storage,app.log),60*60*1000);cleanupTimer.unref();await app.listen({port:env.API_PORT,host:'0.0.0.0'});}catch(error){app.log.error(error);await prisma.$disconnect();process.exit(1)}
