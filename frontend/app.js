(() => {
  "use strict";

  const GRID_SIZE = 50;
  const CELL_PX = 12;
  const CANVAS_PX = GRID_SIZE * CELL_PX;
  const SELECT_RADIUS_PX = 10;
  const MAX_PARTICLES = 60;
  const ACTIVE_FIRE = 2;

  const canvas = document.getElementById("canvas");
  canvas.width = CANVAS_PX;
  canvas.height = CANVAS_PX;
  const ctx = canvas.getContext("2d", { alpha: false });

  const state = {
    tick: 0,
    gridState: new Uint8Array(GRID_SIZE * GRID_SIZE),
    gridIntensity: new Uint8Array(GRID_SIZE * GRID_SIZE),
    gridFuel: new Uint8Array(GRID_SIZE * GRID_SIZE),
    drones: [],
    base: { x: 0, y: 0 },
    wind: { dx: 0, dy: 0 },
    counts: { fires: 0, ignited: 0, ash: 0 },
    selection: new Set(),
    groups: { 1: [], 2: [], 3: [], 4: [], 5: [] },
    connected: false,
    lastFrameAt: 0,
    fps: 0,
    paused: false,
    credits: 0,
  };

  // drag-box selection state
  const drag = { active: false, x0: 0, y0: 0, x1: 0, y1: 0 };
  let dragStartPx = null;

  // smoke particles
  const particles = [];
  let lastRenderTime = 0;

  // ── WebSocket ──────────────────────────────────────────────────────────────

  let ws = null;
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/simulation`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      state.connected = true;
      document.getElementById("status-conn").textContent = "connected";
    };
    ws.onclose = () => {
      state.connected = false;
      document.getElementById("status-conn").textContent =
        "disconnected — reconnecting…";
      setTimeout(connect, 1000);
    };
    ws.onerror = () => {};
    ws.onmessage = (ev) => decodeFrame(ev.data);
  }

  // Frame layout: [tick u32][size u16][metaLen u16][state NxN][intensity NxN][fuel NxN][meta JSON]
  function decodeFrame(buffer) {
    if (!(buffer instanceof ArrayBuffer)) return;
    const view = new DataView(buffer);
    const tick = view.getUint32(0, true);
    const size = view.getUint16(4, true);
    const metaLen = view.getUint16(6, true);
    const headerLen = 8;
    const cells = size * size;
    if (size !== GRID_SIZE) return;

    state.gridState.set(new Uint8Array(buffer, headerLen, cells));
    state.gridIntensity.set(new Uint8Array(buffer, headerLen + cells, cells));
    state.gridFuel.set(new Uint8Array(buffer, headerLen + cells * 2, cells));
    const meta = JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(buffer, headerLen + cells * 3, metaLen)
      )
    );
    state.tick = tick;
    state.drones = meta.drones;
    state.base = meta.base;
    state.wind = meta.wind;
    state.counts.fires = meta.active_fires;
    state.counts.ignited = meta.ignited;
    state.counts.ash = meta.ash;
    state.paused = meta.paused;
    state.credits = meta.credits;

    const now = performance.now();
    if (state.lastFrameAt) {
      const dt = now - state.lastFrameAt;
      if (dt > 0) state.fps = state.fps * 0.9 + (1000 / dt) * 0.1;
    }
    state.lastFrameAt = now;
  }

  function sendCommand(cmd) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(cmd));
    }
  }

  // ── Color ──────────────────────────────────────────────────────────────────

  // 5-stop fire gradient + fuel-density green shading for UNBURNED cells
  function colorForCell(s, intensity, fuel) {
    if (s === 0) {
      const l = 12 + (fuel / 255) * 16;
      return `hsl(135,52%,${l.toFixed(1)}%)`;
    }
    if (s === 3) return "#0a0a0a";
    const t = Math.min(1, intensity / 220);
    let h, l;
    if (t < 0.25) {
      const u = t / 0.25; h = 55 - u * 20; l = 65 - u * 10;
    } else if (t < 0.5) {
      const u = (t - 0.25) / 0.25; h = 35 - u * 15; l = 55 - u * 8;
    } else if (t < 0.75) {
      const u = (t - 0.5) / 0.25; h = 20 - u * 15; l = 47 - u * 7;
    } else {
      const u = (t - 0.75) / 0.25; h = 5 - u * 5; l = 40 - u * 14;
    }
    return `hsl(${h.toFixed(0)},100%,${l.toFixed(1)}%)`;
  }

  // ── Particle system ────────────────────────────────────────────────────────

  function spawnSmoke() {
    if (particles.length >= MAX_PARTICLES) return;
    const fireIdxs = [];
    for (let i = 0; i < GRID_SIZE * GRID_SIZE; i++) {
      if (state.gridState[i] === ACTIVE_FIRE) fireIdxs.push(i);
    }
    if (fireIdxs.length === 0) return;
    const idx = fireIdxs[(Math.random() * fireIdxs.length) | 0];
    const cx = (idx % GRID_SIZE) * CELL_PX + CELL_PX * 0.5;
    const cy = ((idx / GRID_SIZE) | 0) * CELL_PX + CELL_PX * 0.5;
    const life = 0.8 + Math.random() * 0.9;
    particles.push({
      x: cx + (Math.random() - 0.5) * CELL_PX,
      y: cy + (Math.random() - 0.5) * CELL_PX,
      vx: (Math.random() - 0.5) * 7,
      vy: -(9 + Math.random() * 12),
      r: 2 + Math.random() * 3,
      life,
      maxLife: life,
    });
  }

  function updateParticles(dtSec) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dtSec;
      p.y += p.vy * dtSec;
      p.vy -= 5 * dtSec;
      p.life -= dtSec;
      if (p.life <= 0) particles.splice(i, 1);
    }
  }

  function drawParticles() {
    for (const p of particles) {
      const alpha = (p.life / p.maxLife) * 0.55;
      ctx.fillStyle = `rgba(150,150,150,${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // ── Draw helpers ───────────────────────────────────────────────────────────

  function drawBase() {
    const bx = state.base.x * CELL_PX;
    const by = state.base.y * CELL_PX;
    ctx.fillStyle = "rgba(56,189,248,0.18)";
    ctx.beginPath();
    ctx.arc(bx, by, CELL_PX * 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#38bdf8";
    ctx.font = "10px ui-monospace,monospace";
    ctx.fillText("BASE", bx + 6, by + 22);
  }

  function drawDrone(d) {
    const px = d.x * CELL_PX;
    const py = d.y * CELL_PX;
    const selected = state.selection.has(d.id);
    const lowBat = d.battery < 25;

    // red glow when battery critical
    if (lowBat) {
      const grd = ctx.createRadialGradient(px, py, 3, px, py, 18);
      grd.addColorStop(0, "rgba(248,113,113,0.45)");
      grd.addColorStop(1, "rgba(248,113,113,0)");
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(px, py, 18, 0, Math.PI * 2);
      ctx.fill();
    }

    if (selected) {
      ctx.strokeStyle = "#4ade80";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 11, 0, Math.PI * 2);
      ctx.stroke();
    }

    // water spray arc when actively dousing; waypoint line otherwise
    if (d.tx !== null && d.tx !== undefined) {
      const distGrid = Math.hypot(d.x - d.tx, d.y - d.ty);
      if (distGrid < 1.0 && d.water > 0) {
        const angle = Math.atan2(d.ty - d.y, d.tx - d.x);
        ctx.strokeStyle = "rgba(56,189,248,0.7)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px, py, 14, angle - 0.45, angle + 0.45);
        ctx.stroke();
      } else {
        ctx.strokeStyle =
          d.state === 2 ? "rgba(248,113,113,0.45)" : "rgba(255,178,74,0.35)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(d.tx * CELL_PX, d.ty * CELL_PX);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    let angle = 0;
    if (d.vx !== 0 || d.vy !== 0) {
      angle = Math.atan2(d.vy, d.vx);
    } else if (d.tx !== null && d.tx !== undefined) {
      angle = Math.atan2(d.ty - d.y, d.tx - d.x);
    }
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(angle);
    ctx.fillStyle =
      d.state === 2 ? "#f87171" : d.state === 1 ? "#ffb24a" : "#e2e8f0";
    ctx.strokeStyle = "#0a0d11";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(7, 0);
    ctx.lineTo(-5, 4);
    ctx.lineTo(-5, -4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    const barW = 16, barH = 2;
    const bx = px - barW / 2;
    const by = py - 14;
    ctx.fillStyle = "#1c232c";
    ctx.fillRect(bx, by, barW, barH);
    ctx.fillStyle = lowBat ? "#f87171" : "#4ade80";
    ctx.fillRect(bx, by, barW * Math.max(0, d.battery / 100), barH);
    ctx.fillStyle = "#1c232c";
    ctx.fillRect(bx, by + 3, barW, barH);
    ctx.fillStyle = "#38bdf8";
    ctx.fillRect(bx, by + 3, barW * Math.max(0, d.water / 100), barH);
  }

  const STATE_NAME = { 0: "AUTO", 1: "MANUAL", 2: "RETREAT" };

  function updateHud() {
    document.getElementById("status-tick").textContent = `tick ${state.tick}`;
    document.getElementById("status-fps").textContent =
      `${state.fps.toFixed(0)} fps`;
    document.getElementById("hud-wind").textContent =
      `(${state.wind.dx.toFixed(1)}, ${state.wind.dy.toFixed(1)})`;
    document.getElementById("hud-fires").textContent = state.counts.fires;
    document.getElementById("hud-ignited").textContent = state.counts.ignited;
    document.getElementById("hud-ash").textContent = state.counts.ash;

    let a = 0, m = 0, r = 0;
    for (const d of state.drones) {
      if (d.state === 0) a++;
      else if (d.state === 1) m++;
      else r++;
    }
    document.getElementById("hud-auto").textContent = a;
    document.getElementById("hud-manual").textContent = m;
    document.getElementById("hud-retreat").textContent = r;
    document.getElementById("hud-drone-count").textContent = state.drones.length;
    document.getElementById("hud-credits").textContent = state.credits;

    const sel = [...state.selection].sort((x, y) => x - y);
    document.getElementById("hud-selection").textContent = sel.length
      ? sel.map((i) => `#${i}`).join(" ")
      : "none";

    for (const el of document.querySelectorAll("#hud-groups span")) {
      const g = el.dataset.g;
      const ids = state.groups[g];
      el.textContent = `${g}:${ids.length ? ids.length + "u" : "—"}`;
      el.classList.toggle("bound", ids.length > 0);
    }

    const detail = document.getElementById("selection-detail");
    const empty = document.getElementById("selection-empty");
    if (sel.length === 0) {
      detail.hidden = true;
      empty.hidden = false;
    } else {
      empty.hidden = true;
      detail.hidden = false;
      const rows = [
        '<div class="drone-row header"><span>ID</span><span>State</span><span>Battery</span><span>Water</span><span>Target</span></div>',
      ];
      for (const id of sel) {
        const d = state.drones[id];
        if (!d) continue;
        const tgt =
          d.tx === null || d.tx === undefined
            ? "—"
            : `${d.tx.toFixed(1)},${d.ty.toFixed(1)}`;
        rows.push(
          `<div class="drone-row">
            <span>#${d.id}</span>
            <span class="state-tag state-${d.state}">${STATE_NAME[d.state]}</span>
            <div class="bar bat"><span style="width:${d.battery}%"></span></div>
            <div class="bar wat"><span style="width:${d.water}%"></span></div>
            <span>${tgt}</span>
          </div>`
        );
      }
      detail.innerHTML = rows.join("");
    }
  }

  // ── Main render loop ───────────────────────────────────────────────────────

  function render(timestamp) {
    requestAnimationFrame(render);
    const dtSec = Math.min(
      (lastRenderTime ? timestamp - lastRenderTime : 16) / 1000,
      0.05
    );
    lastRenderTime = timestamp;

    ctx.fillStyle = "#050709";
    ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);

    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const idx = y * GRID_SIZE + x;
        ctx.fillStyle = colorForCell(
          state.gridState[idx],
          state.gridIntensity[idx],
          state.gridFuel[idx]
        );
        ctx.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);
      }
    }

    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= GRID_SIZE; i += 10) {
      ctx.beginPath();
      ctx.moveTo(i * CELL_PX + 0.5, 0);
      ctx.lineTo(i * CELL_PX + 0.5, CANVAS_PX);
      ctx.moveTo(0, i * CELL_PX + 0.5);
      ctx.lineTo(CANVAS_PX, i * CELL_PX + 0.5);
      ctx.stroke();
    }

    if (!state.paused) {
      spawnSmoke();
      updateParticles(dtSec);
    }
    drawParticles();

    drawBase();
    for (const d of state.drones) drawDrone(d);

    // drag-box overlay
    if (drag.active) {
      const x0 = Math.min(drag.x0, drag.x1);
      const y0 = Math.min(drag.y0, drag.y1);
      ctx.strokeStyle = "rgba(74,222,128,0.7)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(
        x0, y0,
        Math.abs(drag.x1 - drag.x0),
        Math.abs(drag.y1 - drag.y0)
      );
      ctx.setLineDash([]);
    }

    // pause overlay
    if (state.paused) {
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);
      ctx.fillStyle = "#f8fafc";
      ctx.font = "bold 28px ui-monospace,monospace";
      ctx.textAlign = "center";
      ctx.fillText("PAUSED", CANVAS_PX / 2, CANVAS_PX / 2);
      ctx.font = "13px ui-monospace,monospace";
      ctx.fillText("Space to resume", CANVAS_PX / 2, CANVAS_PX / 2 + 34);
      ctx.textAlign = "left";
    }

    updateHud();
  }

  // ── Input ──────────────────────────────────────────────────────────────────

  function eventToCanvas(ev) {
    const rect = canvas.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const py = (ev.clientY - rect.top) * (canvas.height / rect.height);
    return { px, py, gx: px / CELL_PX, gy: py / CELL_PX };
  }

  canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

  canvas.addEventListener("mousedown", (ev) => {
    if (ev.button === 0) {
      const { px, py } = eventToCanvas(ev);
      dragStartPx = { px, py };
      drag.x0 = px; drag.y0 = py;
      drag.x1 = px; drag.y1 = py;
      drag.active = false;
    } else if (ev.button === 2) {
      ev.preventDefault();
      const { gx, gy } = eventToCanvas(ev);
      if (ev.shiftKey) {
        sendCommand({ cmd: "spawn_fire", x: Math.floor(gx), y: Math.floor(gy) });
      } else if (state.selection.size > 0) {
        const cx = Math.max(0, Math.min(GRID_SIZE - 0.001, gx));
        const cy = Math.max(0, Math.min(GRID_SIZE - 0.001, gy));
        sendCommand({ cmd: "target", drone_ids: [...state.selection], x: cx, y: cy });
      }
    }
  });

  canvas.addEventListener("mousemove", (ev) => {
    if (!dragStartPx || !(ev.buttons & 1)) return;
    const { px, py } = eventToCanvas(ev);
    if (Math.hypot(px - dragStartPx.px, py - dragStartPx.py) > 4) {
      drag.active = true;
      drag.x1 = px;
      drag.y1 = py;
    }
  });

  canvas.addEventListener("mouseup", (ev) => {
    if (ev.button !== 0) return;
    const { px, py } = eventToCanvas(ev);
    if (drag.active) {
      const x0 = Math.min(drag.x0, drag.x1), x1 = Math.max(drag.x0, drag.x1);
      const y0 = Math.min(drag.y0, drag.y1), y1 = Math.max(drag.y0, drag.y1);
      state.selection.clear();
      for (const d of state.drones) {
        const dpx = d.x * CELL_PX, dpy = d.y * CELL_PX;
        if (dpx >= x0 && dpx <= x1 && dpy >= y0 && dpy <= y1) {
          state.selection.add(d.id);
        }
      }
      drag.active = false;
    } else if (dragStartPx) {
      let best = null, bestDist = SELECT_RADIUS_PX;
      for (const d of state.drones) {
        const dist = Math.hypot(d.x * CELL_PX - px, d.y * CELL_PX - py);
        if (dist <= bestDist) { bestDist = dist; best = d.id; }
      }
      state.selection.clear();
      if (best !== null) state.selection.add(best);
    }
    dragStartPx = null;
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;

    if (ev.key === " ") {
      ev.preventDefault();
      sendCommand({ cmd: "pause_toggle" });
      return;
    }

    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "r") {
      ev.preventDefault();
      sendCommand({ cmd: "restart" });
      return;
    }

    if (ev.key === "F2") {
      ev.preventDefault();
      state.selection.clear();
      for (const d of state.drones) state.selection.add(d.id);
      return;
    }

    if (/^[1-5]$/.test(ev.key)) {
      const g = ev.key;
      if (ev.ctrlKey || ev.metaKey) {
        ev.preventDefault();
        state.groups[g] = [...state.selection];
      } else {
        state.selection.clear();
        for (const id of state.groups[g]) state.selection.add(id);
      }
      return;
    }

    const k = ev.key.toLowerCase();
    if (k === "a") {
      if (state.selection.size === 0) return;
      sendCommand({ cmd: "autonomous", drone_ids: [...state.selection] });
    } else if (k === "r") {
      if (state.selection.size === 0) return;
      sendCommand({ cmd: "recall", drone_ids: [...state.selection] });
    } else if (k === "b") {
      sendCommand({ cmd: "buy_drone" });
    }
  });

  connect();
  requestAnimationFrame(render);
})();
