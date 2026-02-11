import "dotenv/config"
import express from "express"
import { randomUUID } from "node:crypto"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import {
    Appointment,
    createAppointment,
    findProduct,
    searchProducts,
    listProducts,
    listAppointmentsForDate,
    updateAppointment,
    appointmentConflicts,
    suggestNextAvailableSlots
} from "./db.js"

const LOG_PREFIX = "[MCP]"
const MAX_LOG_PREVIEW_CHARS = 4000

function toIsoNow() {
    return new Date().toISOString()
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value)
    } catch (error) {
        return JSON.stringify({
            unserializable: true,
            error: error instanceof Error ? error.message : String(error)
        })
    }
}

function preview(value: unknown, maxChars = MAX_LOG_PREVIEW_CHARS): string {
    const raw = typeof value === "string" ? value : safeStringify(value)
    if (raw.length <= maxChars) return raw
    return `${raw.slice(0, maxChars)}...<truncated ${raw.length - maxChars} chars>`
}

function errorDetails(error: unknown) {
    if (error instanceof Error) {
        return {
            name: error.name,
            message: error.message,
            stack: error.stack
        }
    }
    return { message: String(error) }
}

function logEvent(event: string, details: Record<string, unknown> = {}) {
    console.log(`${LOG_PREFIX}[${toIsoNow()}] ${event} ${preview(details)}`)
}

function logError(event: string, error: unknown, details: Record<string, unknown> = {}) {
    logEvent(event, {
        ...details,
        error: errorDetails(error)
    })
}

function withToolLogging<TResult>(name: string, handler: () => Promise<TResult>) {
    return async () => {
        const startedAt = Date.now()
        logEvent("tool.request", { tool: name, args: {} })
        try {
            const result = await handler()
            logEvent("tool.response", {
                tool: name,
                duration_ms: Date.now() - startedAt,
                result: preview(result)
            })
            return result
        } catch (error) {
            logError("tool.error", error, {
                tool: name,
                duration_ms: Date.now() - startedAt,
                args: {}
            })
            throw error
        }
    }
}

function withToolLoggingArgs<TArgs extends Record<string, unknown>, TResult>(
    name: string,
    handler: (args: TArgs) => Promise<TResult>
) {
    return async (args: TArgs) => {
        const startedAt = Date.now()
        logEvent("tool.request", { tool: name, args })
        try {
            const result = await handler(args)
            logEvent("tool.response", {
                tool: name,
                duration_ms: Date.now() - startedAt,
                result: preview(result)
            })
            return result
        } catch (error) {
            logError("tool.error", error, {
                tool: name,
                duration_ms: Date.now() - startedAt,
                args
            })
            throw error
        }
    }
}

function buildMcpServer() {
    const server = new McpServer({
        name: "salon-mcp",
        version: "1.0.0"
    })

    server.tool(
        "list_products",
        {},
        withToolLogging("list_products", async () => ({
            content: [{ type: "text", text: JSON.stringify({ items: listProducts() }) }]
        }))
    )

    server.tool(
        "search_products",
        { query: z.string(), limit: z.number().int().min(1).max(100).optional() },
        withToolLoggingArgs("search_products", async ({ query, limit }) => {
            const items = searchProducts(query, limit ?? 20)
            return { content: [{ type: "text", text: JSON.stringify({ items }) }] }
        })
    )

    server.tool(
        "list_appointments_for_date",
        { date: z.string() },
        withToolLoggingArgs("list_appointments_for_date", async ({ date }) => {
            return {
                content: [{ type: "text", text: JSON.stringify({ items: listAppointmentsForDate(date) }) }]
            }
        })
    )

    server.tool(
        "create_appointment",
        {
            customer_name: z.string(),
            service_id: z.string(),
            start_time: z.string(),
            notes: z.string().optional()
        },
        withToolLoggingArgs("create_appointment", async ({ customer_name, service_id, start_time, notes }) => {
            if (!customer_name || !customer_name.trim()) {
                return {
                    content: [{ type: "text", text: JSON.stringify({ error: "customer_name is required" }) }]
                }
            }
            const product = findProduct(service_id)
            if (!product) {
                return {
                    content: [{ type: "text", text: JSON.stringify({ error: "Unknown service_id" }) }]
                }
            }
            const conflicts = appointmentConflicts(start_time, product.duration_minutes)
            if (conflicts.length > 0) {
                const suggestions = suggestNextAvailableSlots(start_time, product.duration_minutes)
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify({
                                error: "Time slot unavailable",
                                suggestions,
                                conflicts
                            })
                        }
                    ]
                }
            }
            const appt: Appointment = {
                id: randomUUID(),
                customer_name,
                service_id,
                start_time,
                notes,
                status: "scheduled",
                created_at: new Date().toISOString()
            }
            return { content: [{ type: "text", text: JSON.stringify(createAppointment(appt)) }] }
        })
    )

    server.tool(
        "update_appointment",
        {
            id: z.string(),
            start_time: z.string().optional(),
            notes: z.string().optional(),
            status: z.enum(["scheduled", "completed", "cancelled"]).optional(),
            service_id: z.string().optional(),
            customer_name: z.string().optional()
        },
        withToolLoggingArgs("update_appointment", async ({ id, start_time, notes, status, service_id, customer_name }) => {
            if (service_id && !findProduct(service_id)) {
                throw new Error("Unknown service_id")
            }
            const updated = updateAppointment(id, {
                start_time,
                notes,
                status,
                service_id,
                customer_name
            })
            if (!updated) {
                throw new Error("Appointment not found")
            }
            return { content: [{ type: "text", text: JSON.stringify(updated) }] }
        })
    )

    return server
}

const transports = new Map<string, StreamableHTTPServerTransport>()

export function registerMcpRoutes(app: express.Express) {
    app.post("/mcp", async (req, res) => {
        const sessionId = req.headers["mcp-session-id"] as string | undefined
        const reqType = (req.body && typeof req.body === "object" && "type" in req.body) ? req.body.type : "unknown"
        const context = {
            transport: "mcp",
            method: "POST",
            path: "/mcp",
            session_id: sessionId ?? "none",
            request_type: reqType
        }

        try {
            let transport = sessionId ? transports.get(sessionId) : undefined

            if (!transport) {
                if (!isInitializeRequest(req.body)) {
                    logEvent("http.init_rejected", {
                        session_id: sessionId ?? "none",
                        reason: "expected_initialize"
                    })
                    res.status(400).json({ error: "Expected initialize request" })
                    return
                }

                transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: (id) => {
                        transports.set(id, transport!)
                        logEvent("session.initialized", { session_id: id })
                    }
                })

                transport.onclose = () => {
                    if (transport?.sessionId) {
                        logEvent("session.closed", { session_id: transport.sessionId })
                        transports.delete(transport.sessionId)
                    }
                }

                const server = buildMcpServer()
                logEvent("server.connect", { session_id: "pending" })
                await server.connect(transport)
            }

            await transport.handleRequest(req, res, req.body)
        } catch (error) {
            logError("connection.error", error, context)
            if (!res.headersSent) {
                res.status(500).json({ error: "MCP server internal error" })
            }
        }
    })

    app.get("/mcp", async (req, res) => {
        const sessionId = req.headers["mcp-session-id"] as string | undefined
        const context = {
            transport: "mcp",
            method: "GET",
            path: "/mcp",
            session_id: sessionId ?? "none"
        }
        try {
            const transport = sessionId ? transports.get(sessionId) : undefined
            if (!transport) {
                logEvent("http.missing_transport", context)
                res.status(400).end()
                return
            }
            await transport.handleRequest(req, res)
        } catch (error) {
            logError("connection.error", error, context)
            if (!res.headersSent) {
                res.status(500).json({ error: "MCP server internal error" })
            }
        }
    })

    app.delete("/mcp", async (req, res) => {
        const sessionId = req.headers["mcp-session-id"] as string | undefined
        const context = {
            transport: "mcp",
            method: "DELETE",
            path: "/mcp",
            session_id: sessionId ?? "none"
        }
        try {
            const transport = sessionId ? transports.get(sessionId) : undefined
            if (!transport) {
                logEvent("http.missing_transport", context)
                res.status(400).end()
                return
            }
            await transport.handleRequest(req, res)
        } catch (error) {
            logError("connection.error", error, context)
            if (!res.headersSent) {
                res.status(500).json({ error: "MCP server internal error" })
            }
        }
    })
}
