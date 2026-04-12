import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'GridRisk — Dashboard de Risco',
  description: 'Plataforma de monitoramento e análise de risco da rede elétrica brasileira',
  keywords: ['energia elétrica', 'risco', 'DEC', 'FEC', 'distribuidoras', 'Brasil'],
  viewport: 'width=device-width, initial-scale=1',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="pt-BR">
      <body className="min-h-screen antialiased bg-[#030712] text-[#f1f5f9]">
        {children}
      </body>
    </html>
  )
}
