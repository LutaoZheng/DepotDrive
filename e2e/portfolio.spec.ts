import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { expect, test } from '@playwright/test';

const project=process.env.E2E_COMPOSE_PROJECT??'depot-drive-e2e';
const root=process.cwd();
const screenshots=path.join(root,'docs/portfolio/screenshots');
const prisma=new PrismaClient({datasources:{db:{url:'postgresql://depot:depot@127.0.0.1:5432/depot_drive'}}});
const compose=(...args:string[])=>execFileSync('docker',['compose','-p',project,'-f','docker-compose.yml','-f','docker-compose.demo.yml',...args],{cwd:root,stdio:'pipe'}).toString().trim();
const container=(service:string)=>compose('ps','-q',service);
const digest=(value:Buffer)=>createHash('sha256').update(value).digest('hex');
async function waitApi(){await expect.poll(async()=>{try{return(await fetch('http://127.0.0.1:3000/health')).status}catch{return 0}},{timeout:60_000}).toBe(200)}

test.beforeAll(()=>mkdirSync(screenshots,{recursive:true}));
test.afterAll(async()=>prisma.$disconnect());

test('real authentication, file details, download, and delete',async({page})=>{
  const email=`browser-${Date.now()}@example.com`;
  await page.goto('/drive');await expect(page).toHaveURL(/\/login/);
  await page.getByRole('link',{name:'Create account'}).click();
  await page.getByLabel('Email address').fill(email);await page.getByLabel('Password').fill('password123');await page.getByRole('button',{name:'Create account'}).click();
  await expect(page.getByRole('heading',{name:'My Drive'})).toBeVisible();await expect(page.getByRole('link',{name:'System Monitor'})).toHaveCount(0);
  const content=Buffer.from('browser verified DepotDrive content');
  await page.getByTestId('file-input').setInputFiles({name:'browser-proof.txt',mimeType:'text/plain',buffer:content});
  await expect(page.getByTestId('file-browser-proof.txt')).toBeVisible();
  await page.getByTestId('file-browser-proof.txt').getByRole('button').first().click();
  await expect(page.getByText(digest(content))).toBeVisible();
  const downloadPromise=page.waitForEvent('download');await page.getByRole('link',{name:'Download'}).last().click();const download=await downloadPromise;const saved=await download.createReadStream();const chunks:Buffer[]=[];for await(const chunk of saved!)chunks.push(Buffer.from(chunk));expect(digest(Buffer.concat(chunks))).toBe(digest(content));
  await page.screenshot({path:path.join(screenshots,'drive-file-details.png'),fullPage:true});
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'Delete'}).last().click();await expect(page.getByTestId('file-browser-proof.txt')).toHaveCount(0);
  await page.getByRole('button',{name:'Sign out'}).click();await page.getByLabel('Email address').fill(email);await page.getByLabel('Password').fill('password123');await page.getByRole('button',{name:'Sign in'}).click();await expect(page).toHaveURL(/\/drive/);
});

test('100 MiB browser resume, live monitoring, outages, corruption, and repair',async({page,context},testInfo)=>{
  const large=Buffer.alloc(100*1024*1024,0x5a),largePath=testInfo.outputPath('browser-100mb.bin');writeFileSync(largePath,large);const expected=digest(large);
  await page.goto('/login');await page.getByLabel('Email address').fill('demo@depotdrive.local');await page.getByLabel('Password').fill('DepotDemo123!');await page.getByRole('button',{name:'Sign in'}).click();
  await expect(page.getByRole('link',{name:'System Monitor'})).toBeVisible();
  await page.route('**/api/uploads/**/chunks/**',async route=>{await new Promise(resolve=>setTimeout(resolve,250));await route.continue()});
  await page.getByTestId('file-input').setInputFiles(largePath);const upload=page.getByTestId('upload-browser-100mb.bin');await expect(upload).toBeVisible();await expect(upload.getByText(/[1-9]\/13 chunks/)).toBeVisible();await upload.getByRole('button',{name:'Pause'}).click();await expect(upload.getByText('paused')).toBeVisible();
  const sessions=await page.evaluate(async()=>await(await fetch('http://localhost:3000/api/uploads',{credentials:'include'})).json()) as {uploads:Array<{id:string;totalChunks:number;completedChunks:Array<{chunkIndex:number}>}>};const session=sessions.uploads[0]!;expect(session.completedChunks.length).toBeGreaterThan(0);expect(session.completedChunks.length).toBeLessThan(session.totalChunks);
  await page.reload();await expect(page.getByTestId('resume-notice')).toBeVisible();compose('restart','api');await waitApi();
  const resumedSession=await page.evaluate(async id=>await(await fetch(`http://localhost:3000/api/uploads/${id}`,{credentials:'include'})).json(),session.id) as {upload:{totalChunks:number;completedChunks:Array<{chunkIndex:number}>}};
  const completed=new Set(resumedSession.upload.completedChunks.map(chunk=>chunk.chunkIndex));
  await page.unroute('**/api/uploads/**/chunks/**');const sent:number[]=[];page.on('request',request=>{const match=request.url().match(/\/chunks\/(\d+)$/);if(match)sent.push(Number(match[1]))});await page.getByTestId('file-input').setInputFiles(largePath);await expect(page.getByTestId('file-browser-100mb.bin')).toBeVisible({timeout:120_000});expect([...new Set(sent)].sort((a,b)=>a-b)).toEqual(Array.from({length:resumedSession.upload.totalChunks},(_,i)=>i).filter(i=>!completed.has(i)));
  const file=await prisma.file.findFirstOrThrow({where:{name:'browser-100mb.bin'},orderBy:{createdAt:'desc'},include:{replicas:true}});expect(file.checksum).toBe(expected);expect(file.replicas.filter(r=>r.status==='HEALTHY')).toHaveLength(2);
  await page.goto('/monitor');await expect(page.getByText('Storage Node A').first()).toBeVisible();await page.screenshot({path:path.join(screenshots,'system-monitor.png'),fullPage:true});
  compose('stop','storage-node-a');const nodeACard=page.getByText('Storage Node A').first().locator('xpath=ancestor::section');await expect(nodeACard.getByText('UNAVAILABLE')).toBeVisible({timeout:30_000});
  let response=await context.request.get(`http://localhost:3000/api/files/${file.id}/download`);expect(response.status()).toBe(200);expect(digest(Buffer.from(await response.body()))).toBe(expected);
  compose('stop','storage-node-b');await expect(page.getByText('Storage Node B').first().locator('xpath=ancestor::section').getByText('UNAVAILABLE')).toBeVisible({timeout:30_000});response=await context.request.get(`http://localhost:3000/api/files/${file.id}/download`);expect(response.status()).toBe(503);expect((await response.json()).error.code).toBe('FILE_UNAVAILABLE');
  compose('start','storage-node-a','storage-node-b');await expect(nodeACard.getByText('HEALTHY')).toBeVisible({timeout:30_000});
  compose('stop','api');await expect(page.getByText('Monitoring disconnected.')).toBeVisible({timeout:15_000});compose('start','api');await waitApi();await expect(page.getByText('Monitoring disconnected.')).toHaveCount(0,{timeout:30_000});
  const replica=file.replicas.find(r=>r.nodeId==='node-a')!;const objectPath=`/data/objects/${replica.storageKey.slice(0,2)}/${replica.storageKey.slice(2,4)}/${replica.storageKey}`;execFileSync('docker',['exec',container('storage-node-a'),'node','-e',"const fs=require('fs');const p=process.argv[1],f=fs.openSync(p,'r+'),b=Buffer.alloc(1);fs.readSync(f,b,0,1,0);b[0]^=255;fs.writeSync(f,b,0,1,0);fs.closeSync(f)",objectPath]);
  await page.goto('/reliability');await page.getByLabel('Selected demo file').selectOption(file.id);await page.getByRole('button',{name:'Run scrub'}).click();await expect(page.getByTestId('event-REPLICA_CORRUPT').first()).toBeVisible();await expect(page.getByTestId('event-REPLICA_RESTORED').first()).toBeVisible({timeout:30_000});response=await context.request.get(`http://localhost:3000/api/files/${file.id}/download`);expect(digest(Buffer.from(await response.body()))).toBe(expected);await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:path.join(screenshots,'reliability-demo.png'),fullPage:true});
});
