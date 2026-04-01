import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'GridRisk — Dashboard de Risco',
  description: 'Plataforma de monitoramento e análise de risco da rede elétrica brasileira',
  keywords: ['energia elétrica', 'risco', 'DEC', 'FEC', 'distribuidoras', 'Brasil'],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="pt-BR">
      <body className="bg-gray-950 text-white min-h-screen antialiased">
        {children}
      </body>
    </html>
  )
}
