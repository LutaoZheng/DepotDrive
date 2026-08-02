import bcrypt from 'bcrypt';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PASSWORD_MIN_LENGTH } from '@depot-drive/shared';
import { prisma } from '../../plugins/prisma.js';
import { authenticate } from '../../middleware/auth.js';
import { userDto } from '../../utils/dto.js';
import { fail } from '../../utils/errors.js';
import { clearSessionCookieOptions, sessionCookieOptions, sessionJwtOptions, SESSION_COOKIE_NAME } from './session.js';

const credentials=z.object({email:z.string().email().transform(v=>v.trim().toLowerCase()),password:z.string().min(PASSWORD_MIN_LENGTH).max(200)});
export async function authRoutes(app: FastifyInstance) {
  app.post('/register',async(req,reply)=>{ const p=credentials.safeParse(req.body); if(!p.success)return fail(reply,400,'VALIDATION_ERROR','Invalid email or password');
    if(await prisma.user.findUnique({where:{email:p.data.email}}))return fail(reply,409,'EMAIL_EXISTS','Email is already registered');
    const user=await prisma.user.create({data:{email:p.data.email,passwordHash:await bcrypt.hash(p.data.password,12)}}); const token=app.jwt.sign({sub:user.id,email:user.email},sessionJwtOptions(app.config)); reply.setCookie(SESSION_COOKIE_NAME,token,sessionCookieOptions(app.config)); return reply.code(201).send({user:userDto(user)}); });
  app.post('/login',async(req,reply)=>{ const p=credentials.safeParse(req.body); if(!p.success)return fail(reply,401,'INVALID_CREDENTIALS','Invalid email or password'); const user=await prisma.user.findUnique({where:{email:p.data.email}}); if(!user||!await bcrypt.compare(p.data.password,user.passwordHash))return fail(reply,401,'INVALID_CREDENTIALS','Invalid email or password'); reply.setCookie(SESSION_COOKIE_NAME,app.jwt.sign({sub:user.id,email:user.email},sessionJwtOptions(app.config)),sessionCookieOptions(app.config)); return {user:userDto(user)}; });
  app.get('/me',{preHandler:authenticate},async(req,reply)=>{ const user=await prisma.user.findUnique({where:{id:req.user.sub}}); if(!user)return fail(reply,401,'UNAUTHORIZED','Authentication required'); return {user:userDto(user)}; });
  app.post('/logout',async(_req,reply)=>{ reply.clearCookie(SESSION_COOKIE_NAME,clearSessionCookieOptions); return reply.code(204).send(); });
}
