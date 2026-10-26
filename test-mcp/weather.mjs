// Server MCP di prova per SandBot: espone un tool meteo statico via stdio.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'weather', version: '1.0.0' })

server.tool(
  'get_weather',
  'Restituisce il meteo (simulato) di una città italiana',
  { city: z.string().describe('Nome della città') },
  async ({ city }) => ({
    content: [{ type: 'text', text: `Meteo per ${city}: 22°C, cielo sereno, vento 8 km/h (dati simulati del server MCP di prova).` }]
  })
)

await server.connect(new StdioServerTransport())
