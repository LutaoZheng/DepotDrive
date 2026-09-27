import { buildApp } from './app.js'; import { loadEnv } from './config/env.js'; import { prisma } from './plugins/prisma.js';
import { cleanupExpiredUploads } from './modules/uploads/service.js';
import { HeartbeatService } from './modules/storage/heartbeat-service.js';
import bcrypt from 'bcrypt';
const env=loadEnv();const app=await buildApp({env});
const heartbeat=new HeartbeatService(app.storageNodes,app.storageMetadata,env.HEARTBEAT_INTERVAL_MS,app.log);
const timers:NodeJS.Timeout[]=[];let repairRunning=false,scrubRunning=false;
function every(milliseconds:number,task:()=>Promise<unknown>){const timer=setInterval(()=>void task(),milliseconds);timer.unref();timers.push(timer)}
async function repairTick(){if(repairRunning)return;repairRunning=true;try{await app.storageOperations.reconcileRepairs(env.REPAIR_UNAVAILABLE_GRACE_MS,env.REPAIR_BATCH_SIZE)}catch(error){app.log.error({error},'Repair worker failed')}finally{repairRunning=false}}
async function scrubTick(){if(scrubRunning)return;scrubRunning=true;try{await app.scrubber.tick(env.SCRUB_BATCH_SIZE)}catch(error){app.log.error({error},'Scrub worker failed')}finally{scrubRunning=false}}
async function shutdown(signal:string){app.log.info({signal},'Shutting down');for(const timer of timers)clearInterval(timer);heartbeat.stop();await app.close();await prisma.$disconnect();process.exit(0)}
process.on('SIGINT',()=>void shutdown('SIGINT'));process.on('SIGTERM',()=>void shutdown('SIGTERM'));
async function ensureDemoAdmin(){if(!env.DEMO_MODE)return;if(!env.DEMO_ADMIN_EMAIL||env.DEMO_ADMIN_PASSWORD.length<8)throw new Error('DEMO_MODE requires DEMO_ADMIN_EMAIL and an 8+ character DEMO_ADMIN_PASSWORD');const email=env.DEMO_ADMIN_EMAIL.trim().toLowerCase();const passwordHash=await bcrypt.hash(env.DEMO_ADMIN_PASSWORD,12);await prisma.user.upsert({where:{email},create:{email,passwordHash,role:'ADMIN'},update:{passwordHash,role:'ADMIN'}})}
try{await prisma.$connect();await ensureDemoAdmin();await heartbeat.tick();await app.storageOperations.reconcileIncomplete();await repairTick();heartbeat.start();await cleanupExpiredUploads(app.storage,app.log);every(60*60*1000,()=>cleanupExpiredUploads(app.storage,app.log));every(env.REPAIR_INTERVAL_MS,repairTick);every(env.SCRUB_INTERVAL_MS,scrubTick);await app.listen({port:env.API_PORT,host:'0.0.0.0'});}catch(error){app.log.error(error);await prisma.$disconnect();process.exit(1)}
