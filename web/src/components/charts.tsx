import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { humanize } from '../lib/format';

/**
 * Chart palette: the validated reference categorical palette (light/dark steps are
 * selected per mode, not flipped). Charts here use ≤ 3 series, inside the palette's
 * all-pairs safe cap. Text uses ink tokens, never series colours.
 */
const LIGHT = ['#2a78d6', '#eb6834', '#1baf7a'];
const DARK = ['#3987e5', '#d95926', '#199e70'];
const INK = { light: { primary: '#0b0b0b', secondary: '#52514e', grid: '#e7e5e4', surface: '#ffffff' }, dark: { primary: '#f0efec', secondary: '#c3c2b7', grid: '#2a2a28', surface: '#0f172a' } };

function useDark() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const o = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => o.disconnect();
  }, []);
  return dark;
}

export function useChartTheme() {
  const dark = useDark();
  return { series: dark ? DARK : LIGHT, ink: dark ? INK.dark : INK.light };
}

function TooltipBox({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card px-3 py-2 text-xs shadow-lg">
      {label != null && <div className="mb-1 font-medium">{label}</div>}
      {payload.map((p: any) => (
        <div key={p.dataKey} className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
          <span className="muted">{p.name}</span>
          <span className="ml-auto pl-3 font-medium tabular-nums">{formatter ? formatter(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

export interface SeriesDef { key: string; label: string }

/** Grouped vertical bars (one axis, ≤ 3 series). */
export function BarsChart({ data, x, series, height = 240, stacked = false }: { data: any[]; x: string; series: SeriesDef[]; height?: number; stacked?: boolean }) {
  const t = useChartTheme();
  if (!data.length) return <p className="muted py-10 text-center text-sm">No data for this period</p>;
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }} barGap={2}>
          <CartesianGrid vertical={false} stroke={t.ink.grid} />
          <XAxis dataKey={x} tick={{ fill: t.ink.secondary }} tickLine={false} axisLine={{ stroke: t.ink.grid }} interval="preserveStartEnd" minTickGap={8} />
          <YAxis allowDecimals={false} tick={{ fill: t.ink.secondary }} tickLine={false} axisLine={false} width={40} />
          <Tooltip content={<TooltipBox />} cursor={{ fill: t.ink.grid, opacity: 0.5 }} />
          {series.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: t.ink.secondary }} />}
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} fill={t.series[i]} radius={stacked ? (i === series.length - 1 ? [4, 4, 0, 0] : 0) : [4, 4, 0, 0]} maxBarSize={28}
              stackId={stacked ? 'a' : undefined} stroke={t.ink.surface} strokeWidth={stacked ? 2 : 0} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal single-series bars — good for category comparisons with long labels. */
export function HBarChart({ data, label, value, valueLabel, height, format }: { data: any[]; label: string; value: string; valueLabel: string; height?: number; format?: (v: number) => string }) {
  const t = useChartTheme();
  if (!data.length) return <p className="muted py-10 text-center text-sm">No data</p>;
  const h = height ?? Math.max(120, data.length * 30 + 20);
  return (
    <div style={{ height: h }} className="w-full">
      <ResponsiveContainer>
        <BarChart data={data.map((d) => ({ ...d, [label]: humanize(String(d[label])) }))} layout="vertical" margin={{ top: 0, right: 24, left: 0, bottom: 0 }}>
          <CartesianGrid horizontal={false} stroke={t.ink.grid} />
          <XAxis type="number" allowDecimals={false} tick={{ fill: t.ink.secondary }} tickLine={false} axisLine={false} />
          <YAxis type="category" dataKey={label} width={110} tick={{ fill: t.ink.secondary }} tickLine={false} axisLine={false} />
          <Tooltip content={<TooltipBox formatter={format} />} cursor={{ fill: t.ink.grid, opacity: 0.5 }} />
          <Bar dataKey={value} name={valueLabel} fill={t.series[0]} radius={[0, 4, 4, 0]} maxBarSize={18} label={{ position: 'right', fill: t.ink.secondary, fontSize: 11 }} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function LinesChart({ data, x, series, height = 240, yMax }: { data: any[]; x: string; series: SeriesDef[]; height?: number; yMax?: number }) {
  const t = useChartTheme();
  if (!data.length) return <p className="muted py-10 text-center text-sm">No data for this period</p>;
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke={t.ink.grid} />
          <XAxis dataKey={x} tick={{ fill: t.ink.secondary }} tickLine={false} axisLine={{ stroke: t.ink.grid }} minTickGap={12} />
          <YAxis tick={{ fill: t.ink.secondary }} tickLine={false} axisLine={false} width={40} domain={[0, yMax ?? 'auto']} />
          <Tooltip content={<TooltipBox />} cursor={{ stroke: t.ink.secondary, strokeDasharray: '3 3' }} />
          {series.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, color: t.ink.secondary }} />}
          {series.map((s, i) => (
            <Line key={s.key} type="monotone" dataKey={s.key} name={s.label} stroke={t.series[i]} strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: t.ink.surface, fill: t.series[i] }} activeDot={{ r: 5 }} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Meter for single-value utilisation; status colours are paired with a text label. */
export function Meter({ value, max = 100, label }: { value: number; max?: number; label?: string }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  const tone = value > 110 ? '#d03b3b' : value > 90 ? '#fab219' : '#0ca30c';
  const word = value > 110 ? 'Overloaded' : value > 90 ? 'Near capacity' : 'OK';
  return (
    <div className="flex items-center gap-2" title={`${value}% — ${word}`}>
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: tone }} /></div>
      <span className="text-xs tabular-nums">{value}%</span>
      {label !== '' && <span className="muted hidden text-[11px] xl:inline">{word}</span>}
    </div>
  );
}
