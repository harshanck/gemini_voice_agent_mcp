import "dotenv/config"
import { randomUUID } from "node:crypto"
import { db } from "./src/db.js"

const products = [
    { id: "cut_basic", name: "Basic Haircut", category: "hair", price: 25, duration_minutes: 30 },
    { id: "cut_style", name: "Cut & Style", category: "hair", price: 55, duration_minutes: 60 },
    { id: "color_full", name: "Full Color", category: "color", price: 95, duration_minutes: 90 },
    { id: "beard_trim", name: "Beard Trim", category: "grooming", price: 15, duration_minutes: 15 }
]

db.exec("DELETE FROM appointments")
db.exec("DELETE FROM products")

const insertProduct = db.prepare(
    "INSERT INTO products (id, name, category, price, duration_minutes) VALUES (@id, @name, @category, @price, @duration_minutes)"
)

for (const p of products) insertProduct.run(p)

const insertAppt = db.prepare(
    "INSERT INTO appointments (id, customer_name, service_id, start_time, notes, status, created_at) VALUES (@id, @customer_name, @service_id, @start_time, @notes, @status, @created_at)"
)

const now = new Date()
insertAppt.run({
    id: randomUUID(),
    customer_name: "Alex Rivera",
    service_id: "cut_style",
    start_time: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    notes: "Prefers medium fade",
    status: "scheduled",
    created_at: now.toISOString()
})

console.log("Seeded salon database")
