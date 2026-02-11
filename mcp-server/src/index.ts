import "dotenv/config"
import express from "express"
import { registerRestRoutes } from "./rest.js"
import { registerMcpRoutes } from "./mcp.js"

const app = express()

process.on("unhandledRejection", (reason) => {
    const ts = new Date().toISOString()
    console.error(`[MCP][${ts}] process.unhandled_rejection`, reason)
})

process.on("uncaughtException", (error) => {
    const ts = new Date().toISOString()
    console.error(`[MCP][${ts}] process.uncaught_exception`, error)
})

registerRestRoutes(app)
registerMcpRoutes(app)

const port = Number(process.env.PORT ?? 8090)
app.listen(port, () => {
    console.log(`Salon MCP server listening on :${port}`)
})
