import Fastify from 'fastify'
import cors from '@fastify/cors'
import dotenv from 'dotenv'
import { riscoRoutes } from './routes/risco'
import { redeRoutes } from './routes/rede'
import { jobsRoutes } from './routes/jobs'
import { municipioRoutes } from './routes/municipio'
import { alimentadorRoutes } from './routes/alimentador'
import { bdgdRoutes } from './routes/bdgd'
import { subestacaoRoutes } from './routes/subestacao'

dotenv.config()

const server = Fastify({
  logger: true,
})

async function start() {
  await server.register(cors, {
    origin: true,
  })

  await server.register(riscoRoutes, { prefix: '/api' })
  await server.register(redeRoutes, { prefix: '/api' })
  await server.register(jobsRoutes, { prefix: '/api' })
  await server.register(municipioRoutes, { prefix: '/api' })
  await server.register(alimentadorRoutes, { prefix: '/api' })
  await server.register(subestacaoRoutes, { prefix: '/api' })
  await server.register(bdgdRoutes, { prefix: '/api' })

  server.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
  }))

  const port = Number(process.env.PORT) || 3001
  try {
    await server.listen({ port, host: '0.0.0.0' })
    console.log(`[GridRisk API] running on port ${port}`)
  } catch (err) {
    server.log.error(err)
    process.exit(1)
  }
}

start()
