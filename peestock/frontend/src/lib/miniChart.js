/**
 * MiniChart — lightweight canvas-based mini candlestick chart
 * Used in scan results just like KeyStocks shows thumbnail charts.
 */

/**
 * Draw a mini candlestick chart onto a <canvas> element.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{open,high,low,close,volume}>} data  — last N bars
 * @param {Object} opts
 */
export function drawMiniChart(canvas, data, opts = {}) {
  if (!canvas || !data || data.length < 2) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;

  const {
    bgColor = "#FFFFFF",
    upColor = "#26a69a",
    downColor = "#ef5350",
    borderColor = "#C0C0C0",
    gridColor = "#E8E8E8",
    wickColor = null, // if null, same as candle color
    showVolume = true,
    showMA = true,
    maPeriod = 20,
    maColor = "#FF6600",
    padding = 4,
    // S/R level line (for trendlines page)
    srLevel = null,   // price value to draw a horizontal line at
    srColor = "#008000",
  } = opts;

  ctx.clearRect(0, 0, W, H);

  // Background
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, W, H);

  // Border
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

  const n = data.length;
  const volAreaH = showVolume ? Math.floor(H * 0.18) : 0;
  const chartH = H - volAreaH - padding * 2;
  const chartTop = padding;

  // Price range
  let minLow = Infinity, maxHigh = -Infinity;
  data.forEach((d) => {
    if (d.low < minLow) minLow = d.low;
    if (d.high > maxHigh) maxHigh = d.high;
  });
  const priceRange = maxHigh - minLow || 1;

  // Volume range
  let maxVol = 0;
  if (showVolume) data.forEach((d) => { if ((d.volume || 0) > maxVol) maxVol = d.volume || 0; });

  const candleW = Math.max(1, Math.floor((W - padding * 2) / n) - 1);
  const gap = Math.floor((W - padding * 2) / n);

  const priceToY = (price) =>
    chartTop + chartH - ((price - minLow) / priceRange) * chartH;

  // Grid lines (3 horizontal)
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 0.5;
  for (let i = 1; i <= 2; i++) {
    const y = Math.round(chartTop + (chartH / 3) * i) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padding, y);
    ctx.lineTo(W - padding, y);
    ctx.stroke();
  }

  // Draw candles
  data.forEach((d, i) => {
    const x = padding + i * gap;
    const isUp = d.close >= d.open;
    const color = isUp ? upColor : downColor;

    const oY = priceToY(d.open);
    const cY = priceToY(d.close);
    const hY = priceToY(d.high);
    const lY = priceToY(d.low);

    const bodyTop = Math.min(oY, cY);
    const bodyH = Math.max(1, Math.abs(cY - oY));
    const wickX = x + Math.floor(candleW / 2);

    // Wick
    ctx.strokeStyle = wickColor || color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(wickX, hY);
    ctx.lineTo(wickX, lY);
    ctx.stroke();

    // Body
    ctx.fillStyle = isUp ? bgColor : color;
    ctx.fillRect(x, bodyTop, candleW, bodyH);
    ctx.strokeStyle = color;
    ctx.strokeRect(x, bodyTop, candleW, bodyH);

    // Volume bar
    if (showVolume && maxVol > 0) {
      const volH = Math.max(1, ((d.volume || 0) / maxVol) * (volAreaH - 2));
      const volY = H - volH - 1;
      ctx.fillStyle = isUp ? "rgba(38, 166, 154, 0.4)" : "rgba(239, 83, 80, 0.4)";
      ctx.fillRect(x, volY, candleW, volH);
    }
  });

  // MA overlay
  if (showMA && data.length >= maPeriod) {
    const maPoints = [];
    for (let i = maPeriod - 1; i < data.length; i++) {
      let sum = 0;
      for (let j = 0; j < maPeriod; j++) sum += data[i - j].close;
      const avg = sum / maPeriod;
      const x = padding + i * gap + Math.floor(candleW / 2);
      const y = priceToY(avg);
      maPoints.push({ x, y });
    }
    if (maPoints.length > 1) {
      ctx.strokeStyle = maColor;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(maPoints[0].x, maPoints[0].y);
      for (let i = 1; i < maPoints.length; i++) {
        ctx.lineTo(maPoints[i].x, maPoints[i].y);
      }
      ctx.stroke();
    }
  }

  // S/R horizontal level line
  if (srLevel !== null && srLevel >= minLow && srLevel <= maxHigh) {
    const srY = Math.round(priceToY(srLevel)) + 0.5;
    ctx.strokeStyle = srColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padding, srY);
    ctx.lineTo(W - padding, srY);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}


/**
 * Generate synthetic OHLCV data from just a close price array
 * when we don't have full OHLCV (e.g. from scanner match metadata)
 */
export function syntheticOHLCV(closes) {
  return closes.map((c, i) => {
    const prev = closes[i - 1] || c;
    const spread = c * 0.01;
    return {
      open: prev,
      close: c,
      high: Math.max(prev, c) + spread * 0.5,
      low: Math.min(prev, c) - spread * 0.5,
      volume: 100000,
    };
  });
}
