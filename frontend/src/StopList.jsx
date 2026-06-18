import {
  MapingIcon,
  DeliveryBox01Icon,
  DeliveryTruck01Icon,
  FuelStationIcon,
  BedIcon,
  Coffee01Icon,
} from 'hugeicons-react'

const CFG = {
  start:   { Icon: MapingIcon },
  pickup:  { Icon: DeliveryBox01Icon },
  dropoff: { Icon: DeliveryTruck01Icon },
  fuel:    { Icon: FuelStationIcon },
  rest:    { Icon: BedIcon },
  break:   { Icon: Coffee01Icon },
}

const DOT_STYLE  = { background: 'none', border: 'none' }
const ICON_COLOR = 'rgba(255,255,255,0.72)'
const LINE_BG    = 'rgba(255,255,255,0.08)'

function fmt(min) {
  const h = Math.floor(min / 60) % 24
  const m = min % 60
  const ap = h >= 12 ? 'PM' : 'AM'
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
  return `${h12}:${m.toString().padStart(2, '0')} ${ap}`
}

export default function StopList({ stops, totalMiles, totalDays, startLocation }) {
  const startStop = startLocation
    ? [{ type: 'start', label: 'Starting Point', location: startLocation, day: 1, time_of_day_min: 0, duration_min: 0, miles_mark: 0 }]
    : []
  const allStops = [...startStop, ...stops]

  return (
    <div className="stops">
      <div className="stops__head">
        <span className="stops__title">Trip Stops</span>
        <div className="stops__meta">
          <span>{totalMiles} mi</span>
          <span>·</span>
          <span>{totalDays}d</span>
        </div>
      </div>

      <div className="stops__list">
        {allStops.map((s, i) => {
          const c    = CFG[s.type] ?? CFG.break
          const { Icon } = c
          return (
            <div key={i} className="stop">
              <div className="stop__track">
                <div className="stop__dot" style={DOT_STYLE}>
                  <Icon size={14} color={ICON_COLOR} strokeWidth={1.5} />
                </div>
                {i < allStops.length - 1 && (
                  <div className="stop__line" style={{ background: LINE_BG }} />
                )}
              </div>
              <div className="stop__content">
                <div className="stop__top">
                  <span className="stop__name">{s.label}</span>
                  {s.time_of_day_min > 0 && (
                    <span className="stop__time">D{s.day} · {fmt(s.time_of_day_min)}</span>
                  )}
                </div>
                <div className="stop__loc">{s.location}</div>
                {s.duration_min > 0 && (
                  <div className="stop__meta">
                    <span>{s.duration_min} min</span>
                    <span>·</span>
                    <span>{s.miles_mark} mi</span>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
