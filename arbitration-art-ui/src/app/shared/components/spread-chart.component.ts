import {
  ChangeDetectionStrategy,
  Component,
  effect,
  ElementRef,
  input,
  viewChild,
} from '@angular/core';

import { SpreadSnapshot } from '../../core/services/spread-monitor.service';

@Component({
  selector: 'app-spread-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<canvas #canvas></canvas>`,
  styles: `
    :host {
      display: block;
    }
    canvas {
      width: 100%;
      height: 100%;
      border-radius: 8px;
      background: rgba(0, 0, 0, 0.2);
    }
  `,
})
export class SpreadChartComponent {
  readonly history = input.required<SpreadSnapshot[]>();

  readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  constructor() {
    effect(() => {
      const data = this.history();
      const el = this.canvas();
      if (el && data.length > 1) {
        this.draw(el.nativeElement, data);
      }
    });
  }

  private draw(canvas: HTMLCanvasElement, data: SpreadSnapshot[]): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();

    // Set actual canvas size accounting for DPR
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    const padL = 8;
    const padR = 52; // space for Y-axis labels
    const padT = 10;
    const padB = 10;

    ctx.clearRect(0, 0, w, h);

    // Calculate bounds
    let min = Infinity;
    let max = -Infinity;
    for (const s of data) {
      min = Math.min(min, s.openSpread, s.closeSpread);
      max = Math.max(max, s.openSpread, s.closeSpread);
    }

    const range = max - min || 1;
    const margin = range * 0.15;
    const yMin = min - margin;
    const yMax = max + margin;

    const chartW = w - padL - padR;
    const chartH = h - padT - padB;

    const toX = (i: number) => padL + (chartW * i) / (data.length - 1);
    const toY = (v: number) => padT + chartH - ((v - yMin) / (yMax - yMin)) * chartH;

    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 1;
    const gridSteps = 4;
    for (let i = 0; i <= gridSteps; i++) {
      const y = padT + (chartH * i) / gridSteps;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
    }

    // Zero line
    if (yMin < 0 && yMax > 0) {
      const zeroY = toY(0);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(padL, zeroY);
      ctx.lineTo(w - padR, zeroY);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw lines
    this.drawLine(ctx, data, toX, toY, padT, chartH, 'openSpread', '#4caf50', 'rgba(76,175,80,0.06)');
    this.drawLine(ctx, data, toX, toY, padT, chartH, 'closeSpread', '#ef5350', 'rgba(239,83,80,0.06)');

    // Y-axis labels
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';
    const labelX = w - padR + 6;

    ctx.fillText(max.toFixed(3), labelX, padT + 4);
    ctx.fillText(min.toFixed(3), labelX, h - padB + 3);

    // Mid label
    const mid = (max + min) / 2;
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillText(mid.toFixed(3), labelX, padT + chartH / 2 + 3);

    // Latest values in top-left legend
    const last = data[data.length - 1];
    ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'left';

    ctx.fillStyle = '#4caf50';
    ctx.fillText(`O: ${last.openSpread.toFixed(3)}`, padL + 2, padT - 1);

    ctx.fillStyle = '#ef5350';
    const oWidth = ctx.measureText(`O: ${last.openSpread.toFixed(3)}`).width;
    ctx.fillText(`C: ${last.closeSpread.toFixed(3)}`, padL + oWidth + 12, padT - 1);
  }

  private drawLine(
    ctx: CanvasRenderingContext2D,
    data: SpreadSnapshot[],
    toX: (i: number) => number,
    toY: (v: number) => number,
    padT: number,
    chartH: number,
    key: 'openSpread' | 'closeSpread',
    color: string,
    fillColor: string,
  ): void {
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(data[0][key]));
    for (let i = 1; i < data.length; i++) {
      ctx.lineTo(toX(i), toY(data[i][key]));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Fill area to bottom
    ctx.lineTo(toX(data.length - 1), padT + chartH);
    ctx.lineTo(toX(0), padT + chartH);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
  }
}
