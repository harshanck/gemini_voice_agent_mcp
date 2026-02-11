# Gemini Live Voice Agent + MCP

A demo project showcasing a realtime salon voice assistant with a React frontend, a Python FastAPI relay, and a Node.js MCP server.  
It demonstrates Gemini Live API voice interaction with MCP tool calling for salon workflows like product lookup and appointment management.

## Tech stack

- Frontend: React + TypeScript + Vite
- Backend: Python + FastAPI + `google-genai`
- MCP Server: Node.js + TypeScript + Express + MCP SDK
- Database: SQLite
- AI: Gemini Live API

## Required versions

- Python: `3.12+`
- Node.js: `20+`

## Clone and setup

```bash
git clone <repo-url>
cd gemini_voice_agent
```

## MCP server setup

```bash
cd mcp-server
npm install
```

Create `mcp-server/.env` from example:

```bash
cp .env.example .env
```

Run MCP server:

```bash
npm run dev
```

MCP endpoint:

```text
http://localhost:8090/mcp
```

## Python backend setup

```bash
cd backend
```

Create `backend/.env` from example and set your Gemini key:

```bash
cp .env.example .env
```

Required key in `backend/.env`:

```env
GEMINI_API_KEY=your_gemini_api_key_here
```

Install dependencies and run backend:

```bash
pip install -e .
python main.py
```

Backend endpoints:

```text
http://localhost:8000/health
ws://localhost:8000/ws
```

## Frontend setup

```bash
cd frontend
npm install
```

Create `frontend/.env` from example:

```bash
cp .env.example .env
```

Run frontend:

```bash
npm run dev
```

Default frontend URL:

```text
http://localhost:5173
```

## Quick run order

1. Start `mcp-server` (`npm run dev`)
2. Start `backend` (`python main.py`)
3. Start `frontend` (`npm run dev`)

## Env examples kept in repo

- `backend/.env.example`
- `frontend/.env.example`
- `mcp-server/.env.example`
