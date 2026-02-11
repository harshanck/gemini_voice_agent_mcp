import Database from "better-sqlite3"
import fs from "node:fs"
import path from "node:path"

export type Product = {
    id: string
    name: string
    category: string
    price: number
    duration_minutes: number
}

export type AppointmentStatus = "scheduled" | "completed" | "cancelled"

export type Appointment = {
    id: string
    customer_name: string
    service_id: string
    start_time: string
    notes?: string | null
    status: AppointmentStatus
    created_at: string
}

const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "salon.db")
fs.mkdirSync(path.dirname(dbPath), { recursive: true })

export const db = new Database(dbPath)

db.pragma("journal_mode = WAL")

db.exec(`
CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    price REAL NOT NULL,
    duration_minutes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    service_id TEXT NOT NULL,
    start_time TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL CHECK(status IN ('scheduled','completed','cancelled')),
    created_at TEXT NOT NULL,
    FOREIGN KEY(service_id) REFERENCES products(id)
);
`) 

export function listProducts(): Product[] {
    return db.prepare("SELECT * FROM products ORDER BY name").all() as Product[]
}

export function findProduct(id: string): Product | undefined {
    return db.prepare("SELECT * FROM products WHERE id = ?").get(id) as Product | undefined
}

export function getProduct(id: string): Product | undefined {
    return findProduct(id)
}

export function createProduct(product: Product): Product {
    db.prepare(
        `INSERT INTO products (id, name, category, price, duration_minutes)
         VALUES (@id, @name, @category, @price, @duration_minutes)`
    ).run(product)
    return product
}

export function updateProduct(id: string, patch: Partial<Product>): Product | undefined {
    const current = findProduct(id)
    if (!current) return undefined
    const updated: Product = {
        ...current,
        ...patch,
        id: current.id
    }
    db.prepare(
        `UPDATE products SET name=@name, category=@category, price=@price, duration_minutes=@duration_minutes
         WHERE id=@id`
    ).run(updated)
    return updated
}

export function deleteProduct(id: string): Product | undefined {
    const current = findProduct(id)
    if (!current) return undefined
    db.prepare("DELETE FROM products WHERE id = ?").run(id)
    return current
}

export function searchProducts(query: string, limit = 20): Product[] {
    const q = `%${query}%`
    return db
        .prepare(
            "SELECT * FROM products WHERE name LIKE ? OR category LIKE ? ORDER BY name LIMIT ?"
        )
        .all(q, q, limit) as Product[]
}

export function listAppointmentsForDate(date: string): Appointment[] {
    return db
        .prepare(
            "SELECT * FROM appointments WHERE start_time LIKE ? ORDER BY start_time"
        )
        .all(`${date}%`) as Appointment[]
}

export function listAppointments(status?: AppointmentStatus): Appointment[] {
    if (status) {
        return db
            .prepare("SELECT * FROM appointments WHERE status = ? ORDER BY start_time")
            .all(status) as Appointment[]
    }
    return db.prepare("SELECT * FROM appointments ORDER BY start_time").all() as Appointment[]
}

function getDatePrefix(startTime: string): string | null {
    if (startTime.length >= 10) {
        return startTime.slice(0, 10)
    }
    return null
}

function parseStartTime(startTime: string): number | null {
    const ms = Date.parse(startTime)
    return Number.isNaN(ms) ? null : ms
}

function appointmentWindowMs(appt: Appointment): { start: number; end: number } | null {
    const start = parseStartTime(appt.start_time)
    if (start === null) return null
    const product = findProduct(appt.service_id)
    const duration = product?.duration_minutes ?? 0
    const end = start + duration * 60_000
    return { start, end }
}

export function appointmentConflicts(startTime: string, durationMinutes: number): Appointment[] {
    const datePrefix = getDatePrefix(startTime)
    const start = parseStartTime(startTime)
    if (!datePrefix || start === null) return []
    const end = start + Math.max(durationMinutes, 0) * 60_000
    const dayAppointments = listAppointmentsForDate(datePrefix)
    const conflicts: Appointment[] = []
    for (const appt of dayAppointments) {
        const win = appointmentWindowMs(appt)
        if (!win) continue
        if (start < win.end && end > win.start) {
            conflicts.push(appt)
        }
    }
    return conflicts
}

function roundUpTo30Min(ms: number): number {
    const date = new Date(ms)
    const minutes = date.getMinutes()
    const remainder = minutes % 30
    if (remainder !== 0 || date.getSeconds() !== 0 || date.getMilliseconds() !== 0) {
        const add = 30 - remainder
        date.setMinutes(minutes + add, 0, 0)
        return date.getTime()
    }
    return date.getTime()
}

export function suggestNextAvailableSlots(
    startTime: string,
    durationMinutes: number,
    maxSuggestions = 5
): string[] {
    const datePrefix = getDatePrefix(startTime)
    const start = parseStartTime(startTime)
    if (!datePrefix || start === null) return []
    const duration = Math.max(durationMinutes, 0)
    const startMs = roundUpTo30Min(start)
    const dayEnd = Date.parse(`${datePrefix}T23:59:59.999`)
    const suggestions: string[] = []
    for (let t = startMs; t <= dayEnd; t += 30 * 60_000) {
        const end = t + duration * 60_000
        if (end > dayEnd + 1) break
        const conflicts = appointmentConflicts(new Date(t).toISOString(), duration)
        if (conflicts.length === 0) {
            suggestions.push(new Date(t).toISOString())
            if (suggestions.length >= maxSuggestions) break
        }
    }
    return suggestions
}

export function createAppointment(appt: Appointment): Appointment {
    db.prepare(
        `INSERT INTO appointments (id, customer_name, service_id, start_time, notes, status, created_at)
         VALUES (@id, @customer_name, @service_id, @start_time, @notes, @status, @created_at)`
    ).run(appt)
    return appt
}

export function updateAppointment(id: string, patch: Partial<Appointment>): Appointment | undefined {
    const current = db.prepare("SELECT * FROM appointments WHERE id = ?").get(id) as Appointment | undefined
    if (!current) return undefined
    const updated: Appointment = {
        ...current,
        ...patch
    }
    db.prepare(
        `UPDATE appointments SET customer_name=@customer_name, service_id=@service_id, start_time=@start_time,
         notes=@notes, status=@status WHERE id=@id`
    ).run(updated)
    return updated
}

export function cancelAppointment(id: string): Appointment | undefined {
    return updateAppointment(id, { status: "cancelled" })
}
