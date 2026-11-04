import { code128Bars, encodable } from "@/modules/wms/barcode";

/** A Code 128 barcode as SVG, for printed labels (ADR-104). */
export function BarcodeSvg({ value, height = 60 }: { value: string; height?: number }) {
  if (!encodable(value)) return <span className="ltr-value font-mono">{value}</span>;
  const { bars, width } = code128Bars(value);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-16 w-full max-w-xs"
      preserveAspectRatio="none"
      role="img"
      aria-label={value}
    >
      <rect x="0" y="0" width={width} height={height} fill="#ffffff" />
      {bars.map(([x, w]) => (
        <rect key={x} x={x} y="0" width={w} height={height} fill="#000000" />
      ))}
    </svg>
  );
}
