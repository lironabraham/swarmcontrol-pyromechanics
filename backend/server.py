import asyncio
import json
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from .simulation import Simulation

ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = ROOT / "frontend"
CONFIG_PATH = ROOT / "config.json"

sim = Simulation(CONFIG_PATH)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(sim.run())
    try:
        yield
    finally:
        sim.stop()
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, Exception):
            pass


app = FastAPI(title="SwarmControl: PyroMechanics", lifespan=lifespan)


@app.websocket("/ws/simulation")
async def ws_simulation(ws: WebSocket):
    await ws.accept()
    q: asyncio.Queue = asyncio.Queue(maxsize=4)
    sim.add_subscriber(q)

    async def sender():
        try:
            while True:
                payload = await q.get()
                await ws.send_bytes(payload)
        except WebSocketDisconnect:
            return
        except Exception:
            return

    async def receiver():
        try:
            while True:
                msg = await ws.receive_text()
                try:
                    cmd = json.loads(msg)
                except json.JSONDecodeError:
                    continue
                await sim.submit_command(cmd)
        except WebSocketDisconnect:
            return
        except Exception:
            return

    send_task = asyncio.create_task(sender())
    recv_task = asyncio.create_task(receiver())
    try:
        done, pending = await asyncio.wait(
            {send_task, recv_task}, return_when=asyncio.FIRST_COMPLETED
        )
        for t in pending:
            t.cancel()
    finally:
        sim.remove_subscriber(q)
        try:
            await ws.close()
        except Exception:
            pass


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
