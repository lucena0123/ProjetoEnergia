import { PrismaClient } from '@prisma/client'
import { Pool } from 'pg'
import dotenv from 'dotenv'

dotenv.config()

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
})

export const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
})

pgPool.on('error', (err) => {
  console.error('[PG Pool] Unexpected error:', err)
})
