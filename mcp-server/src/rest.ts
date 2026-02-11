import "dotenv/config"
import express from "express"
import cors from "cors"
import { randomUUID } from "node:crypto"
import {
    Appointment,
    AppointmentStatus,
    createAppointment,
    appointmentConflicts,
    findProduct,
    listAppointments,
    listProducts,
    suggestNextAvailableSlots,
    updateAppointment,
    cancelAppointment
} from "./db.js"

export function registerRestRoutes(app: express.Express) {
    app.use(express.json({ limit: "1mb" }))
    app.use(
        cors({
            origin: "*",
            exposedHeaders: ["Mcp-Session-Id"],
            allowedHeaders: ["Content-Type", "mcp-session-id"]
        })
    )

    app.get("/api/products", (_req, res) => {
        res.json({ items: listProducts() })
    })

    app.get("/api/appointments", (req, res) => {
        const status = req.query.status as AppointmentStatus | undefined
        res.json({ items: listAppointments(status) })
    })

    app.post("/api/appointments", (req, res) => {
        const { customer_name, service_id, start_time, notes } = req.body || {}
        if (!customer_name || !service_id || !start_time) {
            res.status(400).json({ error: "customer_name, service_id, start_time are required" })
            return
        }
        const product = findProduct(service_id)
        if (!product) {
            res.status(404).json({ error: "Unknown service_id" })
            return
        }
        const conflicts = appointmentConflicts(start_time, product.duration_minutes)
        if (conflicts.length > 0) {
            const suggestions = suggestNextAvailableSlots(start_time, product.duration_minutes)
            res.status(409).json({ error: "Time slot unavailable", suggestions, conflicts })
            return
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
        res.status(201).json(createAppointment(appt))
    })

    app.patch("/api/appointments/:id", (req, res) => {
        const { start_time, notes, status, service_id, customer_name } = req.body || {}
        if (service_id && !findProduct(service_id)) {
            res.status(404).json({ error: "Unknown service_id" })
            return
        }
        const updated = updateAppointment(req.params.id, {
            start_time,
            notes,
            status,
            service_id,
            customer_name
        })
        if (!updated) {
            res.status(404).json({ error: "Appointment not found" })
            return
        }
        res.json(updated)
    })

    app.delete("/api/appointments/:id", (req, res) => {
        const updated = cancelAppointment(req.params.id)
        if (!updated) {
            res.status(404).json({ error: "Appointment not found" })
            return
        }
        res.json(updated)
    })
}
