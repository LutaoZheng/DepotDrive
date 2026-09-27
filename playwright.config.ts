import { defineConfig } from '@playwright/test';
export default defineConfig({testDir:'./e2e',timeout:180_000,expect:{timeout:30_000},fullyParallel:false,workers:1,reporter:[['list'],['html',{outputFolder:'playwright-report',open:'never'}]],use:{baseURL:'http://localhost:5173',channel:'chrome',headless:true,trace:'retain-on-failure',screenshot:'only-on-failure'}});
