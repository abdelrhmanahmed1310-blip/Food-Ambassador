/**
 * Net sales per day as SVG bars (server-rendered: no script, no chart library).
 * Days run left to right in both languages, like the dates. A visually hidden
 * table gives screen readers the same numbers.
 */
export function SalesChart({
  series,
  label,
  dayLabel,
  netLabel,
  ordersLabel,
  formatMoney,
  formatDay,
}: {
  series: Array<{ day: string; orders: number; net: string }>;
  label: string;
  dayLabel: string;
  netLabel: string;
  ordersLabel: string;
  formatMoney: (v: string) => string;
  formatDay: (day: string) => string;
}) {
  const W = 700;
  const H = 220;
  const pad = { top: 12, bottom: 28, side: 8 };
  const max = Math.max(...series.map((d) => Number(d.net)), 0);
  const slot = (W - pad.side * 2) / series.length;
  const barW = Math.max(6, slot * 0.62);
  const usable = H - pad.top - pad.bottom;
  return (
    <figure dir="ltr">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={label}
        className="h-56 w-full"
        preserveAspectRatio="none"
      >
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line
            key={f}
            x1={pad.side}
            x2={W - pad.side}
            y1={pad.top + usable * (1 - f)}
            y2={pad.top + usable * (1 - f)}
            className="stroke-border"
            strokeDasharray="3 4"
          />
        ))}
        {series.map((d, i) => {
          const value = Number(d.net);
          const h = max > 0 ? (value / max) * usable : 0;
          const x = pad.side + i * slot + (slot - barW) / 2;
          const last = i === series.length - 1;
          return (
            <g key={d.day}>
              <rect
                x={x}
                y={pad.top + usable - h}
                width={barW}
                height={Math.max(h, value > 0 ? 2 : 0)}
                rx={3}
                className={last ? "fill-primary" : "fill-foreground/80"}
              >
                <title>{`${formatDay(d.day)}: ${formatMoney(d.net)} · ${d.orders} ${ordersLabel}`}</title>
              </rect>
              <text
                x={x + barW / 2}
                y={H - 8}
                textAnchor="middle"
                className="fill-muted text-[11px]"
              >
                {d.day.slice(8, 10)}
              </text>
            </g>
          );
        })}
        <line
          x1={pad.side}
          x2={W - pad.side}
          y1={pad.top + usable}
          y2={pad.top + usable}
          className="stroke-border"
        />
      </svg>
      <table className="sr-only">
        <caption>{label}</caption>
        <thead>
          <tr>
            <th>{dayLabel}</th>
            <th>{netLabel}</th>
            <th>{ordersLabel}</th>
          </tr>
        </thead>
        <tbody>
          {series.map((d) => (
            <tr key={d.day}>
              <td>{formatDay(d.day)}</td>
              <td>{formatMoney(d.net)}</td>
              <td>{d.orders}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
