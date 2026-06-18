import { useEffect, useRef } from 'react'

/* ── Spec constants ──────────────────────────────────────────────── */
// Exact hex values from CLAUDE.md spec
const STATUS_COLOR = {
  off_duty:      '#4A7FC1',
  sleeper_berth: '#9B8FD4',
  driving:       '#E8A020',
  on_duty_nd:    '#4CAF50',
}

const STATUS_LABEL = ['Off Duty', 'Slpr Berth', 'Driving', 'On Duty ND']
const STATUS_KEYS  = ['off_duty', 'sleeper_berth', 'driving', 'on_duty_nd']

/* Canvas layout — logical pixels */
const CW        = 920
const HEADER_H  = 68
const LABEL_W   = 96
const TOTALS_W  = 48
const GRID_W    = CW - LABEL_W - TOTALS_W  // 776
const ROW_H     = 40
const GRID_H    = ROW_H * 4                 // 160
const TICKS_H   = 26
const CANVAS_H  = HEADER_H + GRID_H + TICKS_H  // 254

function xOf(min) {
  return LABEL_W + (min / 1440) * GRID_W
}

/* Polyfill-safe rounded rect */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00')
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  })
}

function drawSheet(canvas, day) {
  const dpr = window.devicePixelRatio || 1
  canvas.width  = CW * dpr
  canvas.height = CANVAS_H * dpr
  canvas.style.width  = `${CW}px`
  canvas.style.height = `${CANVAS_H}px`

  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, CW, CANVAS_H)

  /* ── 1. Header ───────────────────────────────────────────────── */
  ctx.fillStyle = '#1a2744'
  ctx.fillRect(0, 0, CW, HEADER_H)

  // Amber left stripe
  ctx.fillStyle = '#E8A020'
  ctx.fillRect(0, 0, 4, HEADER_H)

  // Day badge
  roundRect(ctx, 12, 12, 36, 20, 4)
  ctx.fillStyle = '#E8A020'
  ctx.fill()
  ctx.fillStyle = '#fff'
  ctx.font = `700 10px 'Nunito Sans', system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText(`DAY ${day.day}`, 30, 26)
  ctx.textAlign = 'left'

  // Date
  ctx.fillStyle = '#ffffff'
  ctx.font = `600 13px 'Playfair Display', Georgia, serif`
  ctx.fillText(formatDate(day.date), 56, 28)

  // Sub-line
  ctx.fillStyle = 'rgba(255,255,255,0.55)'
  ctx.font = `400 11px 'Nunito Sans', system-ui, sans-serif`
  ctx.fillText(`${day.miles_driven} mi driven`, 56, 44)

  // Compliance badge
  const compliant = day.hos_check?.compliant !== false
  const badgeW = 84
  const badgeX = CW - badgeW - 12
  roundRect(ctx, badgeX, 14, badgeW, 22, 5)
  ctx.fillStyle = compliant ? '#4CAF50' : '#ef4444'
  ctx.fill()
  ctx.fillStyle = '#ffffff'
  ctx.font = `600 10px 'Nunito Sans', system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText(compliant ? '✓  Compliant' : '⚠  Exceeded', badgeX + badgeW / 2, 29)
  ctx.textAlign = 'left'

  // HOS stats line
  const hc = day.hos_check
  if (hc) {
    ctx.fillStyle = 'rgba(255,255,255,0.45)'
    ctx.font = `400 10px 'Nunito Sans', system-ui, sans-serif`
    ctx.fillText(
      `Drive ${hc.driving_hrs}/${hc.driving_limit}h  ·  Window ${hc.window_hrs}/${hc.window_limit}h  ·  Cycle ${hc.cycle_used_after_day}/${hc.cycle_limit}h`,
      CW - 370, 54,
    )
  }

  // Driver / Carrier line
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.font = `400 10px 'Nunito Sans', system-ui, sans-serif`
  ctx.fillText('Driver: _______________________   Carrier: _______________________   Vehicle: _______________', 12, 58)

  /* ── 2. Grid background ──────────────────────────────────────── */
  const gridTop = HEADER_H

  STATUS_KEYS.forEach((key, i) => {
    const y = gridTop + i * ROW_H
    ctx.fillStyle = i % 2 === 0 ? '#f9fafb' : '#ffffff'
    ctx.fillRect(0, y, CW, ROW_H)
  })

  // Row separator lines
  ctx.strokeStyle = '#e5e7eb'
  ctx.lineWidth = 0.5
  for (let i = 1; i < 4; i++) {
    const y = gridTop + i * ROW_H
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(CW, y)
    ctx.stroke()
  }

  // Grid border
  ctx.strokeStyle = '#d1d5db'
  ctx.lineWidth = 1
  ctx.strokeRect(LABEL_W, gridTop, GRID_W, GRID_H)

  /* ── 3. Hour grid lines ──────────────────────────────────────── */
  for (let h = 0; h <= 24; h++) {
    const x = xOf(h * 60)
    const isMajor   = h % 6 === 0
    const isMidHour = h % 3 === 0
    ctx.strokeStyle = isMajor ? '#9ca3af' : isMidHour ? '#d1d5db' : '#f0f0f0'
    ctx.lineWidth   = isMajor ? 1 : 0.5
    ctx.beginPath()
    ctx.moveTo(x, gridTop)
    ctx.lineTo(x, gridTop + GRID_H)
    ctx.stroke()
  }

  // 15-min minor ticks
  ctx.strokeStyle = '#f3f4f6'
  ctx.lineWidth   = 0.5
  for (let m = 0; m < 1440; m += 15) {
    if (m % 60 === 0) continue
    const x = xOf(m)
    ctx.beginPath()
    ctx.moveTo(x, gridTop)
    ctx.lineTo(x, gridTop + GRID_H)
    ctx.stroke()
  }

  /* ── 4. Status labels (left column) ─────────────────────────── */
  STATUS_KEYS.forEach((key, i) => {
    const y = gridTop + i * ROW_H

    // Color strip
    ctx.fillStyle = STATUS_COLOR[key]
    ctx.fillRect(0, y, 3, ROW_H)

    // Label text
    ctx.fillStyle = '#374151'
    ctx.font = `500 10px 'Nunito Sans', system-ui, sans-serif`
    ctx.textAlign = 'left'
    ctx.fillText(STATUS_LABEL[i], 8, y + ROW_H / 2 + 3.5)

    // Row number (small)
    ctx.fillStyle = '#9ca3af'
    ctx.font = `400 9px 'Nunito Sans', system-ui, sans-serif`
    ctx.fillText(`${i + 1}`, LABEL_W - 12, y + ROW_H / 2 + 3.5)
  })

  /* ── 5. Status bars ──────────────────────────────────────────── */
  day.events.forEach(ev => {
    const rowIdx = STATUS_KEYS.indexOf(ev.status)
    if (rowIdx < 0) return

    const x1 = xOf(ev.startMin)
    const x2 = xOf(ev.endMin)
    const y   = gridTop + rowIdx * ROW_H
    const bY  = y + ROW_H * 0.22
    const bH  = ROW_H * 0.56

    // Subtle glow behind bar
    ctx.fillStyle = STATUS_COLOR[ev.status] + '22'
    ctx.fillRect(x1, y, x2 - x1, ROW_H)

    // Main bar
    ctx.fillStyle = STATUS_COLOR[ev.status]
    ctx.fillRect(x1, bY, Math.max(x2 - x1, 1), bH)
  })

  /* ── 6. Transition connector lines ───────────────────────────── */
  let prevStatus = null
  ctx.setLineDash([2, 3])
  ctx.lineWidth = 1

  day.events.forEach(ev => {
    const rowIdx = STATUS_KEYS.indexOf(ev.status)
    if (rowIdx < 0) return
    const x = xOf(ev.startMin)

    if (prevStatus !== null && prevStatus !== ev.status) {
      const prevRow = STATUS_KEYS.indexOf(prevStatus)
      const y1 = gridTop + prevRow * ROW_H + ROW_H * 0.5
      const y2 = gridTop + rowIdx * ROW_H + ROW_H * 0.5
      ctx.strokeStyle = '#6b7280'
      ctx.beginPath()
      ctx.moveTo(x, y1)
      ctx.lineTo(x, y2)
      ctx.stroke()
    }
    prevStatus = ev.status
  })
  ctx.setLineDash([])

  /* ── 7. Diagonal remark text ─────────────────────────────────── */
  day.remarks?.forEach(rem => {
    if (rem.min <= 0) return
    const x = xOf(rem.min)
    if (x < LABEL_W + 4 || x > LABEL_W + GRID_W - 4) return

    const text = rem.text.length > 22 ? rem.text.slice(0, 22) + '…' : rem.text
    ctx.save()
    ctx.translate(x + 3, gridTop + GRID_H - 6)
    ctx.rotate(-Math.PI / 5)
    ctx.fillStyle = '#9ca3af'
    ctx.font = `400 8px 'Nunito Sans', system-ui, sans-serif`
    ctx.fillText(text, 0, 0)
    ctx.restore()
  })

  /* ── 8. Totals column ────────────────────────────────────────── */
  // Column header
  ctx.fillStyle = '#f9fafb'
  ctx.fillRect(LABEL_W + GRID_W, gridTop, TOTALS_W, GRID_H)
  ctx.strokeStyle = '#d1d5db'
  ctx.lineWidth = 1
  ctx.strokeRect(LABEL_W + GRID_W, gridTop, TOTALS_W, GRID_H)

  STATUS_KEYS.forEach((key, i) => {
    const y   = gridTop + i * ROW_H
    const hrs = day.totals?.[key] ?? 0

    ctx.fillStyle = STATUS_COLOR[key]
    ctx.font = `700 11px 'Nunito Sans', system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.fillText(hrs.toFixed(1), LABEL_W + GRID_W + TOTALS_W / 2, y + ROW_H / 2 + 4)
  })
  ctx.textAlign = 'left'

  // "HRS" label at top of totals
  ctx.fillStyle = '#9ca3af'
  ctx.font = `500 8px 'Nunito Sans', system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.fillText('HRS', LABEL_W + GRID_W + TOTALS_W / 2, gridTop - 4)
  ctx.textAlign = 'left'

  /* ── 9. Hour labels (bottom) ─────────────────────────────────── */
  const tickTop = gridTop + GRID_H
  const LABELS  = ['M','1','2','3','4','5','6','7','8','9','10','11','N','1','2','3','4','5','6','7','8','9','10','11','M']

  ctx.fillStyle  = '#6b7280'
  ctx.font       = `400 9px 'Nunito Sans', system-ui, sans-serif`
  ctx.textAlign  = 'center'
  ctx.strokeStyle = '#9ca3af'
  ctx.lineWidth   = 1

  LABELS.forEach((lbl, h) => {
    const x = xOf(h * 60)
    // Tick
    ctx.beginPath()
    ctx.moveTo(x, tickTop)
    ctx.lineTo(x, tickTop + 5)
    ctx.stroke()
    // Label
    const isMidnight = h === 0 || h === 24
    const isNoon     = h === 12
    ctx.fillStyle    = isMidnight ? '#1a2744' : isNoon ? '#374151' : '#6b7280'
    ctx.font         = isMidnight || isNoon
      ? `600 9px 'Nunito Sans', system-ui, sans-serif`
      : `400 9px 'Nunito Sans', system-ui, sans-serif`
    ctx.fillText(lbl, x, tickTop + 17)
  })

  // Bottom border
  ctx.strokeStyle = '#d1d5db'
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(0, tickTop)
  ctx.lineTo(CW, tickTop)
  ctx.stroke()

  ctx.textAlign = 'left'
}

/* ── Component ───────────────────────────────────────────────────── */
export default function ELDLogSheet({ day }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    if (canvasRef.current && day?.events?.length) {
      document.fonts.ready.then(() => drawSheet(canvasRef.current, day))
    }
  }, [day])

  const totals  = day.totals ?? {}
  const hc      = day.hos_check ?? {}
  const ok      = hc.compliant !== false

  return (
    <div className="eld-sheet">
      <div className="eld-sheet__bar">
        <span className="eld-sheet__day">Day {day.day}</span>
        <span className="eld-sheet__date">{day.date}</span>
        <span className="eld-sheet__mi">{day.miles_driven} mi</span>
        <div className="eld-sheet__pills">
          {STATUS_KEYS.map(k => {
            const h = totals[k] ?? 0
            if (h <= 0) return null
            return (
              <span key={k} className="spill" style={{ color: STATUS_COLOR[k], background: STATUS_COLOR[k] + '18' }}>
                {h.toFixed(1)}h {k === 'off_duty' ? 'Off' : k === 'driving' ? 'Drive' : k === 'on_duty_nd' ? 'On Duty' : 'Slpr'}
              </span>
            )
          })}
          <span className={`spill ${ok ? 'spill--ok' : 'spill--fail'}`}>
            {ok ? '✓ Compliant' : '⚠ Exceeded'}
          </span>
        </div>
      </div>

      <div className="eld-sheet__canvas-wrap">
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}
