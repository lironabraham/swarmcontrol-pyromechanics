(() => {
  "use strict";

  const GRID_SIZE = 50;
  const CELL_PX = 12;
  const CANVAS_PX = GRID_SIZE * CELL_PX;
  const SELECT_RADIUS_PX = 10;

  const canvas = document.getElementById("canvas");
  canvas.width = CANVAS_PX;
  canvas.height = CANVAS_PX;
  const ctx = canvas.getContext("2d", { alpha: false });

  const state = {
    tick: 0,
    gridState: new Uint8Array(GRID_SIZE * GRID_SIZE),
    gridIntensity: new Uint8Array(GRID_SIZE * GRID_SIZE),
    drones: [],
    base: { x: 0, y: 0 },
    wind: { dx: 0, dy: 0 },
    counts: { fires: 0, ignited: 0, ash: 0 },
    selection: new Set(),
    groups: { 1: [], 2: [], 3: [], 4: [], 5: [] },
    connected: false,
    lastFrameAt: 0,
    fps: 0,
  };

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
    const meta = JSON.parse(
      new TextDecoder().decode(
        new Uint8Array(buffer, headerLen + cells * 2, metaLen)
      )
    );
    state.tick = tick;
    state.drones = meta.drones;
    state.base = meta.base;
    state.wind = meta.wind;
    state.counts.fires = meta.active_fires;
    state.counts.ignited = meta.ignited;
    state.counts.ash = meta.ash;

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

  function colorForCell(s, intensity) {
    if (s === 0) return "#1f5535";
    if (s === 3) return "#0a0a0a";
    const t = Math.min(1, intensity / 200);
    const h = Math.max(0, 50 - t * 50);
    const l = 55 - t * 22;
    return `hsl(${h}, 100%, ${l}%)`;
  }

  function render() {
    requestAnimationFrame(render);
    ctx.fillStyle = "#050709";
    ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);

    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const idx = y * GRID_SIZE + x;
        ctx.fillStyle = colorForCell(state.gridState[idx], state.gridIntensity[idx]);
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

    drawBase();
    for (const d of state.drones) drawDrone(d);
    updateHud();
  }

  function drawBase() {
    const bx = state.base.x * CELL_PX;
    const by = state.base.y * CELL_PX;
    ctx.fillStyle = "rgba(56, 189, 248, 0.18)";
    ctx.beginPath();
    ctx.arc(bx, by, CELL_PX * 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#38bdf8";
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = "#38bdf8";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText("BASE", bx + 6, by + 22);
  }

  function drawDrone(d) {
    const px = d.x * CELL_PX;
    const py = d.y * CELL_PX;
    const selected = state.selection.has(d.id);

    if (selected) {
      ctx.strokeStyle = "#4ade80";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 11, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (d.tx !== null && d.tx !== undefined) {
      ctx.strokeStyle =
        d.state === 2
          ? "rgba(248,113,113,0.45)"
          : "rgba(255,178,74,0.35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(d.tx * CELL_PX, d.ty * CELL_PX);
      ctx.stroke();
      ctx.setLineDash([]);
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

    const barW = 16;
    const barH = 2;
    const bx = px - barW / 2;
    const by = py - 14;
    ctx.fillStyle = "#1c232c";
    ctx.fillRect(bx, by, barW, barH);
    ctx.fillStyle = "#4ade80";
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

  function eventToCanvas(ev) {
    const rect = canvas.getBoundingClientRect();
    const px = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const py = (ev.clientY - rect.top) * (canvas.height / rect.height);
    return { px, py, gx: px / CELL_PX, gy: py / CELL_PX };
  }

  canvas.addEventListener("contextmenu", (ev) => ev.preventDefault());

  canvas.addEventListener("click", (ev) => {
    const { px, py } = eventToCanvas(ev);
    let best = null;
    let bestDist = SELECT_RADIUS_PX;
    for (const d of state.drones) {
      const dx = d.x * CELL_PX - px;
      const dy = d.y * CELL_PX - py;
      const dist = Math.hypot(dx, dy);
      if (dist <= bestDist) {
        bestDist = dist;
        best = d.id;
      }
    }
    state.selection.clear();
    if (best !== null) state.selection.add(best);
  });

  canvas.addEventListener("mousedown", (ev) => {
    if (ev.button !== 2) return;
    ev.preventDefault();
    if (state.selection.size === 0) return;
    const { gx, gy } = eventToCanvas(ev);
    const cx = Math.max(0, Math.min(GRID_SIZE - 0.001, gx));
    const cy = Math.max(0, Math.min(GRID_SIZE - 0.001, gy));
    sendCommand({
      cmd: "target",
      drone_ids: [...state.selection],
      x: cx,
      y: cy,
    });
  });

  window.addEventListener("keydown", (ev) => {
    if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;

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
    }
  });

  connect();
  requestAnimationFrame(render);
})();
