'use client';

import React, { useState } from 'react';
import type { ChannelStatsDay, VideoStatsDay } from '@winkey/api-client';
import { formatStarts, formatWatchTime } from '../../lib/analytics/stats-utils';

export type ChartMetric = 'starts' | 'watch_time_ms' | 'viewers';

interface StatsChartProps {
  days: (ChannelStatsDay | VideoStatsDay)[];
  showViewers?: boolean;
}

export function StatsChart({ days, showViewers = false }: StatsChartProps) {
  const [selectedMetric, setSelectedMetric] = useState<ChartMetric>('starts');
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  if (!days || days.length === 0) {
    return (
      <div className="flex h-64 w-full items-center justify-center rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white text-sm text-gray-500">
        Chưa có dữ liệu biểu đồ
      </div>
    );
  }

  // Determine values for selected metric
  const values = days.map((d) => {
    if (selectedMetric === 'starts') return d.starts;
    if (selectedMetric === 'watch_time_ms') return Math.round(d.watch_time_ms / 60000); // in minutes
    if (selectedMetric === 'viewers' && 'viewers' in d) return d.viewers ?? 0;
    return 0;
  });

  const maxValue = Math.max(1, ...values);
  const chartHeight = 220;
  const chartWidth = 800;
  const paddingLeft = 50;
  const paddingRight = 30;
  const paddingTop = 20;
  const paddingBottom = 40;

  const innerWidth = chartWidth - paddingLeft - paddingRight;
  const innerHeight = chartHeight - paddingTop - paddingBottom;

  const stepX = days.length > 1 ? innerWidth / (days.length - 1) : innerWidth;

  const points = values.map((val, idx) => {
    const x = paddingLeft + (days.length > 1 ? idx * stepX : innerWidth / 2);
    const y = paddingTop + innerHeight - (val / maxValue) * innerHeight;
    return { x, y, val, day: days[idx].day };
  });

  const linePath = points.reduce((acc, pt, idx) => {
    return `${acc} ${idx === 0 ? 'M' : 'L'} ${pt.x},${pt.y}`;
  }, '');

  const areaPath =
    points.length > 0
      ? `${linePath} L ${points[points.length - 1].x},${paddingTop + innerHeight} L ${points[0].x},${paddingTop + innerHeight} Z`
      : '';

  // Metric formatters for tooltip and Y-axis
  const formatMetricValue = (val: number, metric: ChartMetric) => {
    if (metric === 'starts') return formatStarts(val);
    if (metric === 'watch_time_ms') {
      const ms = val * 60000;
      return formatWatchTime(ms);
    }
    return formatStarts(val);
  };

  const metricLabel =
    selectedMetric === 'starts'
      ? 'Lượt phát'
      : selectedMetric === 'watch_time_ms'
        ? 'Thời gian xem'
        : 'Người xem';

  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-[#272727] dark:border-[#272727] border-gray-200 bg-[#141414] dark:bg-[#141414] bg-white p-5 shadow-xl">
      {/* Metric Selector Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#272727] dark:border-[#272727] border-gray-200 pb-3">
        <h3 className="text-sm font-bold text-gray-900 dark:text-white">Biểu đồ theo ngày</h3>
        <div className="flex items-center gap-1.5 rounded-xl bg-[#1f1f1f] dark:bg-[#1f1f1f] bg-gray-100 p-1 text-xs font-semibold">
          <button
            type="button"
            data-testid="chart-tab-starts"
            onClick={() => setSelectedMetric('starts')}
            className={`rounded-lg px-3 py-1.5 transition ${
              selectedMetric === 'starts'
                ? 'bg-red-600 text-white shadow'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Lượt phát
          </button>
          <button
            type="button"
            data-testid="chart-tab-watch-time"
            onClick={() => setSelectedMetric('watch_time_ms')}
            className={`rounded-lg px-3 py-1.5 transition ${
              selectedMetric === 'watch_time_ms'
                ? 'bg-red-600 text-white shadow'
                : 'text-gray-400 hover:text-white'
            }`}
          >
            Thời gian xem
          </button>
          {showViewers && (
            <button
              type="button"
              data-testid="chart-tab-viewers"
              onClick={() => setSelectedMetric('viewers')}
              className={`rounded-lg px-3 py-1.5 transition ${
                selectedMetric === 'viewers'
                  ? 'bg-red-600 text-white shadow'
                  : 'text-gray-400 hover:text-white'
              }`}
            >
              Người xem
            </button>
          )}
        </div>
      </div>

      {/* SVG Chart Area */}
      <div className="relative w-full overflow-x-auto">
        <svg
          data-testid="stats-daily-chart"
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="w-full h-auto min-w-[500px]"
        >
          <defs>
            <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ef4444" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#ef4444" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Grid lines (horizontal) */}
          {[0, 0.25, 0.5, 0.75, 1].map((pct, i) => {
            const y = paddingTop + innerHeight * (1 - pct);
            const val = Math.round(maxValue * pct);
            return (
              <g key={i}>
                <line
                  x1={paddingLeft}
                  y1={y}
                  x2={chartWidth - paddingRight}
                  y2={y}
                  stroke="#272727"
                  strokeDasharray="4 4"
                  strokeWidth="1"
                />
                <text x={paddingLeft - 8} y={y + 4} fill="#71717a" fontSize="10" textAnchor="end">
                  {selectedMetric === 'watch_time_ms' ? `${val}m` : formatStarts(val)}
                </text>
              </g>
            );
          })}

          {/* Area Fill */}
          {areaPath && <path d={areaPath} fill="url(#chartGradient)" />}

          {/* Main Line */}
          {linePath && (
            <path
              d={linePath}
              fill="none"
              stroke="#ef4444"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          )}

          {/* Data Points & X-Labels */}
          {points.map((pt, idx) => {
            const isHovered = hoveredIndex === idx;
            // Show x-labels on subset to avoid crowding
            const showLabel =
              days.length <= 14 ||
              idx === 0 ||
              idx === days.length - 1 ||
              idx % Math.ceil(days.length / 7) === 0;

            const [, m, d] = pt.day.split('-');
            const shortLabel = `${d}/${m}`;

            return (
              <g key={pt.day}>
                {showLabel && (
                  <text
                    x={pt.x}
                    y={paddingTop + innerHeight + 20}
                    fill="#71717a"
                    fontSize="10"
                    textAnchor="middle"
                  >
                    {shortLabel}
                  </text>
                )}

                {/* Circle for each day in days */}
                <circle
                  data-testid={`chart-point-${pt.day}`}
                  cx={pt.x}
                  cy={pt.y}
                  r={isHovered ? 5.5 : 3}
                  fill={isHovered ? '#ffffff' : '#ef4444'}
                  stroke="#ef4444"
                  strokeWidth={isHovered ? 3 : 1.5}
                  className="transition-all duration-150 cursor-pointer"
                  onMouseEnter={() => setHoveredIndex(idx)}
                  onMouseLeave={() => setHoveredIndex(null)}
                />
              </g>
            );
          })}
        </svg>

        {/* Hover Tooltip */}
        {hoveredIndex !== null && points[hoveredIndex] && (
          <div
            data-testid="chart-tooltip"
            className="pointer-events-none absolute z-20 flex flex-col gap-1 rounded-xl border border-gray-700 bg-black/90 p-2.5 text-xs shadow-2xl backdrop-blur-sm"
            style={{
              left: `${(points[hoveredIndex].x / chartWidth) * 100}%`,
              top: '10px',
              transform: 'translateX(-50%)',
            }}
          >
            <span className="font-semibold text-gray-300">{points[hoveredIndex].day}</span>
            <span className="font-bold text-white">
              {metricLabel}: {formatMetricValue(points[hoveredIndex].val, selectedMetric)}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
