import { DrawingAction, DrawingKeyframe, PintadoToolType } from './supabaseClient';

const CANVAS_W = 1280;
const CANVAS_H = 720;
const TRACK_W = 320;
const TRACK_H = 180;
const SCALE = TRACK_W / CANVAS_W; // 0.25

const PATCH_HALF_W = 4; // 9 px wide in 320x180 (~36 px in 1280x720)
const PATCH_HALF_H = 6; // 13 px tall in 320x180 (~52 px in 1280x720)
const PATCH_W = PATCH_HALF_W * 2 + 1;
const PATCH_H = PATCH_HALF_H * 2 + 1;
const PATCH_LEN = PATCH_W * PATCH_H;

interface PointTemplate {
  /** Posición actual del centro del cuerpo rastreado en coordenadas 320x180 */
  bx: number;
  by: number;
  /** Offset desde el punto ancla del dibujo (ej. pies) hasta el centroide del cuerpo/camiseta */
  offsetX: number;
  offsetY: number;
  /** Velocidad estimada en 320x180 px/s */
  vx: number;
  vy: number;
  /** Plantilla RGB original en el fotograma inicial */
  initR: Float32Array;
  initG: Float32Array;
  initB: Float32Array;
  /** Plantilla RGB adaptativa del fotograma previo */
  adaptR: Float32Array;
  adaptG: Float32Array;
  adaptB: Float32Array;
  /** Peso de cada píxel del parche (mayor peso en colores de camiseta/piel que contrastan con el césped) */
  weights: Float32Array;
  /** Color medio del césped local */
  grassR: number;
  grassG: number;
  grassB: number;
}

interface ActionTrackerState {
  actionId: string;
  lastTime: number;
  templates: PointTemplate[];
  /** Si la herramienta usa un único jugador en points[0] y el resto de puntos se trasladan rígidamente */
  rigidFromFirstPoint: boolean;
  /** Offsets originales de points[1..n] respecto a points[0] en 1280x720 */
  rigidOffsets: { dx: number; dy: number }[];
  /** Últimos puntos calculados en tiempo real (1280x720) para renderizado a 60fps */
  livePoints: { x: number; y: number }[];
  liveTime: number;
}

const trackerMap = new Map<string, ActionTrackerState>();

export interface VideoCropBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

let activeCropBounds: VideoCropBounds = { left: 0, right: 1, top: 0, bottom: 1 };

export function setActiveVideoCropBounds(bounds: VideoCropBounds): void {
  activeCropBounds = bounds;
}

export function getActiveVideoCropBounds(): VideoCropBounds {
  return activeCropBounds;
}

let cropDetectCanvas: HTMLCanvasElement | null = null;
let cropDetectCtx: CanvasRenderingContext2D | null = null;
const CROP_W = 240;
const CROP_H = 135;

/**
 * Dibuja el fotograma actual del vídeo recortando automáticamente cualquier banda negra
 * (letterbox / pillarbox / bordes de grabación de pantalla) para que el partido ocupe el 100%.
 */
export function drawVideoFrameCropped(
  ctx: CanvasRenderingContext2D,
  videoEl: HTMLVideoElement,
  destW: number,
  destH: number,
  customBounds?: VideoCropBounds
): void {
  const b = customBounds || activeCropBounds;
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (vw > 0 && vh > 0 && (b.left > 0.001 || b.right < 0.999 || b.top > 0.001 || b.bottom < 0.999)) {
    const sx = Math.max(0, Math.min(vw - 1, b.left * vw));
    const sy = Math.max(0, Math.min(vh - 1, b.top * vh));
    const sw = Math.max(1, Math.min(vw - sx, (b.right - b.left) * vw));
    const sh = Math.max(1, Math.min(vh - sy, (b.bottom - b.top) * vh));
    ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, destW, destH);
  } else {
    ctx.drawImage(videoEl, 0, 0, destW, destH);
  }
}

/**
 * Detecta automáticamente bandas negras (laterales, superiores e inferiores) dentro del propio archivo de vídeo
 * (muy común en grabaciones de pantalla .mov/.mp4) y devuelve el rectángulo útil del partido [0..1].
 */
export function detectVideoCropBounds(videoEl: HTMLVideoElement | null): VideoCropBounds | null {
  if (typeof document === 'undefined' || !videoEl || videoEl.readyState < 2) return null;
  if (!videoEl.videoWidth || !videoEl.videoHeight) return null;

  if (!cropDetectCanvas) {
    cropDetectCanvas = document.createElement('canvas');
    cropDetectCanvas.width = CROP_W;
    cropDetectCanvas.height = CROP_H;
    cropDetectCtx = cropDetectCanvas.getContext('2d', { willReadFrequently: true });
  }
  if (!cropDetectCtx) return null;

  let data: Uint8ClampedArray;
  try {
    cropDetectCtx.drawImage(videoEl, 0, 0, CROP_W, CROP_H);
    data = cropDetectCtx.getImageData(0, 0, CROP_W, CROP_H).data;
  } catch {
    return null;
  }

  // 1. Detectar columnas con contenido real del partido (ignorando bandas negras laterales)
  const yStart = Math.floor(CROP_H * 0.14);
  const yEnd = Math.floor(CROP_H * 0.86);
  const colSampleCount = Math.max(1, yEnd - yStart + 1);
  const isContentCol = new Uint8Array(CROP_W);

  for (let x = 0; x < CROP_W; x++) {
    let brightPixels = 0;
    let lumaSum = 0;
    for (let y = yStart; y <= yEnd; y++) {
      const idx = (y * CROP_W + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const maxC = Math.max(r, g, b);
      const sumC = r + g + b;
      lumaSum += sumC / 3;
      if (maxC > 26 && sumC > 55) {
        brightPixels++;
      }
    }
    const activeRatio = brightPixels / colSampleCount;
    const meanLuma = lumaSum / colSampleCount;
    if (activeRatio > 0.2 && meanLuma > 16) {
      isContentCol[x] = 1;
    }
  }

  // Rellenar pequeños huecos de 1-2 columnas dentro del partido
  for (let x = 1; x < CROP_W - 1; x++) {
    if (!isContentCol[x] && isContentCol[x - 1] && (isContentCol[x + 1] || (x + 2 < CROP_W && isContentCol[x + 2]))) {
      isContentCol[x] = 1;
    }
  }

  // Buscar el tramo continuo más largo de columnas con contenido (evita bordes finos de ventana en grabaciones)
  let bestColStart = 0;
  let bestColEnd = CROP_W - 1;
  let bestColLen = 0;
  let curStart = -1;

  for (let x = 0; x < CROP_W; x++) {
    if (isContentCol[x]) {
      if (curStart === -1) curStart = x;
      const len = x - curStart + 1;
      if (len > bestColLen) {
        bestColLen = len;
        bestColStart = curStart;
        bestColEnd = x;
      }
    } else {
      curStart = -1;
    }
  }

  // Si el fotograma está casi completamente negro (ej. fundido a negro), no recortar
  if (bestColLen < CROP_W * 0.32) {
    return null;
  }

  // 2. Detectar filas con contenido real dentro del tramo horizontal del partido
  const xStart = Math.min(CROP_W - 1, bestColStart + 4);
  const xEnd = Math.max(xStart, bestColEnd - 4);
  const rowSampleCount = Math.max(1, xEnd - xStart + 1);
  const isContentRow = new Uint8Array(CROP_H);

  for (let y = 0; y < CROP_H; y++) {
    let brightPixels = 0;
    let lumaSum = 0;
    for (let x = xStart; x <= xEnd; x++) {
      const idx = (y * CROP_W + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const maxC = Math.max(r, g, b);
      const sumC = r + g + b;
      lumaSum += sumC / 3;
      if (maxC > 26 && sumC > 55) {
        brightPixels++;
      }
    }
    const activeRatio = brightPixels / rowSampleCount;
    const meanLuma = lumaSum / rowSampleCount;
    if (activeRatio > 0.2 && meanLuma > 16) {
      isContentRow[y] = 1;
    }
  }

  for (let y = 1; y < CROP_H - 1; y++) {
    if (!isContentRow[y] && isContentRow[y - 1] && (isContentRow[y + 1] || (y + 2 < CROP_H && isContentRow[y + 2]))) {
      isContentRow[y] = 1;
    }
  }

  let bestRowStart = 0;
  let bestRowEnd = CROP_H - 1;
  let bestRowLen = 0;
  let curRowStart = -1;

  for (let y = 0; y < CROP_H; y++) {
    if (isContentRow[y]) {
      if (curRowStart === -1) curRowStart = y;
      const len = y - curRowStart + 1;
      if (len > bestRowLen) {
        bestRowLen = len;
        bestRowStart = curRowStart;
        bestRowEnd = y;
      }
    } else {
      curRowStart = -1;
    }
  }

  if (bestRowLen < CROP_H * 0.32) {
    return null;
  }

  const insetX = 1.5 / CROP_W;
  const insetY = 1.2 / CROP_H;

  const left = bestColStart > 1 ? Math.min(0.4, bestColStart / CROP_W + insetX) : 0;
  const right = bestColEnd < CROP_W - 2 ? Math.max(0.6, (bestColEnd + 1) / CROP_W - insetX) : 1;
  const top = bestRowStart > 0 ? Math.min(0.35, bestRowStart / CROP_H + insetY) : 0;
  const bottom = bestRowEnd < CROP_H - 1 ? Math.max(0.65, (bestRowEnd + 1) / CROP_H - insetY) : 1;

  return {
    left: Math.round(left * 1000) / 1000,
    right: Math.round(right * 1000) / 1000,
    top: Math.round(top * 1000) / 1000,
    bottom: Math.round(bottom * 1000) / 1000,
  };
}

let offscreenCanvas: HTMLCanvasElement | null = null;
let offscreenCtx: CanvasRenderingContext2D | null = null;

function getTrackingContext(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!offscreenCanvas) {
    offscreenCanvas = document.createElement('canvas');
    offscreenCanvas.width = TRACK_W;
    offscreenCanvas.height = TRACK_H;
    offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
  }
  return offscreenCtx;
}

/**
 * Determina si una herramienta tiene un único punto de anclaje en el jugador (points[0])
 * y los demás puntos definen radio/orientación (se mueven solidarios con points[0]),
 * o si cada punto es un jugador independiente (ej: conector, triangulo, distancia, zona_libre).
 */
export function isRigidRadiusTool(tool: PintadoToolType): boolean {
  return (
    tool === 'foco' ||
    tool === 'klip_radar' ||
    tool === 'orientacion' ||
    tool === 'klip_sombra' ||
    tool === 'lupa' ||
    tool === 'circulo' ||
    tool === 'zona_elipse' ||
    tool === 'rectangulo' ||
    tool === 'flecha_libre' ||
    tool === 'klip_tracking'
  );
}

/**
 * Estima el color dominante del césped alrededor de (cx, cy) en la imagen 320x180
 */
function estimateLocalGrassColor(
  data: Uint8ClampedArray,
  cx: number,
  cy: number
): { r: number; g: number; b: number } {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  const rad = 12;
  const x0 = Math.max(0, Math.round(cx) - rad);
  const x1 = Math.min(TRACK_W - 1, Math.round(cx) + rad);
  const y0 = Math.max(0, Math.round(cy) - rad);
  const y1 = Math.min(TRACK_H - 1, Math.round(cy) + rad);

  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      const idx = (y * TRACK_W + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      // Píxeles con predominancia verde típica de césped
      if (g > r + 5 && g > b + 8) {
        sumR += r;
        sumG += g;
        sumB += b;
        count++;
      }
    }
  }

  if (count < 4) {
    // Fallback si es un plano corto o césped artificial oscuro
    for (let y = y0; y <= y1; y += 3) {
      for (let x = x0; x <= x1; x += 3) {
        if (Math.abs(x - cx) <= 3 && Math.abs(y - cy) <= 4) continue;
        const idx = (y * TRACK_W + x) * 4;
        sumR += data[idx];
        sumG += data[idx + 1];
        sumB += data[idx + 2];
        count++;
      }
    }
  }

  if (count === 0) return { r: 70, g: 130, b: 65 };
  return {
    r: sumR / count,
    g: sumG / count,
    b: sumB / count,
  };
}

/**
 * Crea la plantilla visual de un jugador alrededor del punto marcado (pt en 1280x720)
 */
function buildPointTemplate(data: Uint8ClampedArray, pt: { x: number; y: number }): PointTemplate {
  const tx = Math.max(PATCH_HALF_W + 2, Math.min(TRACK_W - PATCH_HALF_W - 3, pt.x * SCALE));
  const ty = Math.max(PATCH_HALF_H + 2, Math.min(TRACK_H - PATCH_HALF_H - 3, pt.y * SCALE));

  const grass = estimateLocalGrassColor(data, tx, ty);

  // Cuando el analista marca a un jugador con Conector o Foco, suele hacer clic en los pies o cintura.
  // Buscamos ligeramente hacia arriba (-4 a +1 px en 320x180, es decir -16 a +4 px en 720p)
  // el centroide con mayor contraste respecto al césped (la camiseta/torso del jugador).
  let bestShiftX = 0;
  let bestShiftY = -2;
  let bestContrast = -1;

  for (let sy = -5; sy <= 1; sy++) {
    for (let sx = -2; sx <= 2; sx++) {
      const cx = Math.round(tx + sx);
      const cy = Math.round(ty + sy);
      if (
        cx < PATCH_HALF_W + 1 ||
        cx >= TRACK_W - PATCH_HALF_W - 1 ||
        cy < PATCH_HALF_H + 1 ||
        cy >= TRACK_H - PATCH_HALF_H - 1
      ) {
        continue;
      }
      let score = 0;
      for (let py = -3; py <= 3; py++) {
        for (let px = -2; px <= 2; px++) {
          const idx = ((cy + py) * TRACK_W + (cx + px)) * 4;
          const dr = Math.abs(data[idx] - grass.r);
          const dg = Math.abs(data[idx + 1] - grass.g);
          const db = Math.abs(data[idx + 2] - grass.b);
          score += dr + dg * 1.2 + db;
        }
      }
      if (score > bestContrast) {
        bestContrast = score;
        bestShiftX = sx;
        bestShiftY = sy;
      }
    }
  }

  const bx = Math.max(PATCH_HALF_W + 2, Math.min(TRACK_W - PATCH_HALF_W - 3, tx + bestShiftX));
  const by = Math.max(PATCH_HALF_H + 2, Math.min(TRACK_H - PATCH_HALF_H - 3, ty + bestShiftY));
  const offsetX = bx - tx;
  const offsetY = by - ty;

  const initR = new Float32Array(PATCH_LEN);
  const initG = new Float32Array(PATCH_LEN);
  const initB = new Float32Array(PATCH_LEN);
  const adaptR = new Float32Array(PATCH_LEN);
  const adaptG = new Float32Array(PATCH_LEN);
  const adaptB = new Float32Array(PATCH_LEN);
  const weights = new Float32Array(PATCH_LEN);

  let weightSum = 0;
  const ibx = Math.round(bx);
  const iby = Math.round(by);

  let k = 0;
  for (let dy = -PATCH_HALF_H; dy <= PATCH_HALF_H; dy++) {
    for (let dx = -PATCH_HALF_W; dx <= PATCH_HALF_W; dx++) {
      const px = Math.max(0, Math.min(TRACK_W - 1, ibx + dx));
      const py = Math.max(0, Math.min(TRACK_H - 1, iby + dy));
      const idx = (py * TRACK_W + px) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      initR[k] = r;
      initG[k] = g;
      initB[k] = b;
      adaptR[k] = r;
      adaptG[k] = g;
      adaptB[k] = b;

      // Peso espacial (gaussiana centrada en el torso del jugador)
      const distSq = (dx / (PATCH_HALF_W + 0.5)) ** 2 + (dy / (PATCH_HALF_H + 0.5)) ** 2;
      const spatialW = Math.max(0.25, Math.exp(-distSq * 1.15));

      // Peso por contraste con el césped: los píxeles de camiseta/pantalón/piel pesan mucho más que el verde de fondo
      const grassDiff = Math.abs(r - grass.r) + Math.abs(g - grass.g) * 1.3 + Math.abs(b - grass.b);
      const contrastW = grassDiff > 42 ? 3.2 + Math.min(3.0, grassDiff / 60) : 0.45;

      const w = spatialW * contrastW;
      weights[k] = w;
      weightSum += w;
      k++;
    }
  }

  if (weightSum > 0) {
    for (let i = 0; i < PATCH_LEN; i++) {
      weights[i] /= weightSum;
    }
  }

  return {
    bx,
    by,
    offsetX,
    offsetY,
    vx: 0,
    vy: 0,
    initR,
    initG,
    initB,
    adaptR,
    adaptG,
    adaptB,
    weights,
    grassR: grass.r,
    grassG: grass.g,
    grassB: grass.b,
  };
}

/**
 * Evalúa el coste de coincidencia de la plantilla del jugador en el candidato (cx, cy)
 */
function evaluatePatchCost(
  data: Uint8ClampedArray,
  tpl: PointTemplate,
  cx: number,
  cy: number,
  predX: number,
  predY: number
): number {
  let cost = 0;
  let nonGrassEnergy = 0;
  let k = 0;

  for (let dy = -PATCH_HALF_H; dy <= PATCH_HALF_H; dy++) {
    const py = cy + dy;
    const rowOffset = py * TRACK_W;
    for (let dx = -PATCH_HALF_W; dx <= PATCH_HALF_W; dx++) {
      const px = cx + dx;
      const idx = (rowOffset + px) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      const w = tpl.weights[k];
      // Combinación 65% plantilla inicial + 35% plantilla adaptativa para soportar cambios de postura en carrera
      const refR = tpl.initR[k] * 0.65 + tpl.adaptR[k] * 0.35;
      const refG = tpl.initG[k] * 0.65 + tpl.adaptG[k] * 0.35;
      const refB = tpl.initB[k] * 0.65 + tpl.adaptB[k] * 0.35;

      const diff = Math.abs(r - refR) + Math.abs(g - refG) * 1.15 + Math.abs(b - refB);
      cost += w * diff;

      const gDiff = Math.abs(r - tpl.grassR) + Math.abs(g - tpl.grassG) + Math.abs(b - tpl.grassB);
      nonGrassEnergy += w * gDiff;
      k++;
    }
  }

  // Penalizar si el parche cae sobre césped vacío sin jugador
  if (nonGrassEnergy < 26) {
    cost += (26 - nonGrassEnergy) * 2.2;
  }

  // Regularización suave de movimiento para evitar saltos bruscos a otro jugador lejano
  const distSq = (cx - predX) * (cx - predX) + (cy - predY) * (cy - predY);
  cost += distSq * 0.42;

  return cost;
}

/**
 * Actualiza la posición de un punto rastreado de un fotograma al siguiente con refinamiento sub-píxel
 */
function trackSinglePoint(
  data: Uint8ClampedArray,
  tpl: PointTemplate,
  dt: number
): { x: number; y: number } {
  const clampedDt = Math.max(0.015, Math.min(0.12, dt));
  const predX = Math.max(
    PATCH_HALF_W + 2,
    Math.min(TRACK_W - PATCH_HALF_W - 3, tpl.bx + tpl.vx * clampedDt * 0.65)
  );
  const predY = Math.max(
    PATCH_HALF_H + 2,
    Math.min(TRACK_H - PATCH_HALF_H - 3, tpl.by + tpl.vy * clampedDt * 0.65)
  );

  const centerX = Math.round(predX);
  const centerY = Math.round(predY);

  const searchRx = 8; // +-32 px por frame en 1280x720
  const searchRy = 6; // +-24 px por frame en 1280x720

  const minX = Math.max(PATCH_HALF_W + 1, centerX - searchRx);
  const maxX = Math.min(TRACK_W - PATCH_HALF_W - 2, centerX + searchRx);
  const minY = Math.max(PATCH_HALF_H + 1, centerY - searchRy);
  const maxY = Math.min(TRACK_H - PATCH_HALF_H - 2, centerY + searchRy);

  let bestX = centerX;
  let bestY = centerY;
  let bestCost = Infinity;

  const widthSpan = maxX - minX + 1;
  const heightSpan = maxY - minY + 1;
  const costGrid = new Float32Array(widthSpan * heightSpan);

  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      const c = evaluatePatchCost(data, tpl, cx, cy, predX, predY);
      costGrid[(cy - minY) * widthSpan + (cx - minX)] = c;
      if (c < bestCost) {
        bestCost = c;
        bestX = cx;
        bestY = cy;
      }
    }
  }

  // Refinamiento sub-píxel parabólico para movimiento ultra fluido sin escalones
  let subX = bestX;
  let subY = bestY;
  if (bestX > minX && bestX < maxX) {
    const cLeft = costGrid[(bestY - minY) * widthSpan + (bestX - 1 - minX)];
    const cRight = costGrid[(bestY - minY) * widthSpan + (bestX + 1 - minX)];
    const denom = 2 * (cLeft - 2 * bestCost + cRight);
    if (Math.abs(denom) > 1e-4) {
      const delta = (cLeft - cRight) / denom;
      if (Math.abs(delta) <= 0.6) subX += delta;
    }
  }
  if (bestY > minY && bestY < maxY) {
    const cUp = costGrid[(bestY - 1 - minY) * widthSpan + (bestX - minX)];
    const cDown = costGrid[(bestY + 1 - minY) * widthSpan + (bestX - minX)];
    const denom = 2 * (cUp - 2 * bestCost + cDown);
    if (Math.abs(denom) > 1e-4) {
      const delta = (cUp - cDown) / denom;
      if (Math.abs(delta) <= 0.6) subY += delta;
    }
  }

  // Suavizado exponencial (EMA) de posición y velocidad
  const alphaPos = 0.58;
  const newBx = tpl.bx * (1 - alphaPos) + subX * alphaPos;
  const newBy = tpl.by * (1 - alphaPos) + subY * alphaPos;

  const instVx = (newBx - tpl.bx) / clampedDt;
  const instVy = (newBy - tpl.by) / clampedDt;
  tpl.vx = tpl.vx * 0.55 + instVx * 0.45;
  tpl.vy = tpl.vy * 0.55 + instVy * 0.45;
  tpl.bx = newBx;
  tpl.by = newBy;

  // Actualizar suavemente la plantilla adaptativa si la coincidencia es buena
  if (bestCost < 95) {
    const ibx = Math.round(newBx);
    const iby = Math.round(newBy);
    let k = 0;
    const rate = 0.12;
    for (let dy = -PATCH_HALF_H; dy <= PATCH_HALF_H; dy++) {
      for (let dx = -PATCH_HALF_W; dx <= PATCH_HALF_W; dx++) {
        const px = Math.max(0, Math.min(TRACK_W - 1, ibx + dx));
        const py = Math.max(0, Math.min(TRACK_H - 1, iby + dy));
        const idx = (py * TRACK_W + px) * 4;
        tpl.adaptR[k] = tpl.adaptR[k] * (1 - rate) + data[idx] * rate;
        tpl.adaptG[k] = tpl.adaptG[k] * (1 - rate) + data[idx + 1] * rate;
        tpl.adaptB[k] = tpl.adaptB[k] * (1 - rate) + data[idx + 2] * rate;
        k++;
      }
    }
  }

  const outX = Math.max(10, Math.min(CANVAS_W - 10, (newBx - tpl.offsetX) / SCALE));
  const outY = Math.max(10, Math.min(CANVAS_H - 10, (newBy - tpl.offsetY) / SCALE));
  return {
    x: Math.round(outX * 10) / 10,
    y: Math.round(outY * 10) / 10,
  };
}

/**
 * Captura las plantillas visuales de los jugadores marcados en el fotograma actual del vídeo
 */
export function captureDrawingTemplates(
  videoEl: HTMLVideoElement | null,
  action: DrawingAction,
  atTime?: number,
  overridePoints?: { x: number; y: number }[]
): void {
  if (!videoEl || videoEl.readyState < 2 || !action.points || action.points.length === 0) return;
  if (action.trackPlayers === false) return;

  const ctx = getTrackingContext();
  if (!ctx) return;

  try {
    drawVideoFrameCropped(ctx, videoEl, TRACK_W, TRACK_H);
    const imgData = ctx.getImageData(0, 0, TRACK_W, TRACK_H).data;

    const pts = overridePoints || action.points;
    const rigid = isRigidRadiusTool(action.tool);
    const anchorPts = rigid ? [pts[0]] : pts;
    const templates = anchorPts.map((pt) => buildPointTemplate(imgData, pt));
    const rigidOffsets = rigid
      ? pts.slice(1).map((p) => ({ dx: p.x - pts[0].x, dy: p.y - pts[0].y }))
      : [];

    const t = atTime !== undefined ? atTime : action.timestamp;
    trackerMap.set(action.id, {
      actionId: action.id,
      lastTime: t,
      templates,
      rigidFromFirstPoint: rigid,
      rigidOffsets,
      livePoints: pts.map((p) => ({ ...p })),
      liveTime: t,
    });
  } catch {
    // Ignorar si el vídeo externo tiene restricción CORS
  }
}

/**
 * Elimina el estado en memoria de un dibujo (o todos si no se pasa id)
 */
export function resetTrackerState(actionId?: string): void {
  if (actionId) {
    trackerMap.delete(actionId);
  } else {
    trackerMap.clear();
  }
}

/**
 * Devuelve los puntos interpolados o rastreados de un dibujo en el segundo `currentTime`
 */
export function getInterpolatedPointsAtTime(
  action: DrawingAction,
  currentTime: number
): { x: number; y: number }[] {
  if (!action.points || action.points.length === 0) return [];
  if (action.trackPlayers === false) return action.points;

  // Si el motor en vivo acaba de calcular la posición exacta para este instante, usarla directamente (60fps)
  const mem = trackerMap.get(action.id);
  if (
    mem &&
    mem.livePoints.length === action.points.length &&
    Math.abs(currentTime - mem.liveTime) <= 0.045
  ) {
    return mem.livePoints;
  }

  const kfs = action.keyframes;
  if (!kfs || kfs.length === 0) {
    return action.points;
  }

  if (currentTime <= kfs[0].time) {
    return kfs[0].points.length === action.points.length ? kfs[0].points : action.points;
  }
  const lastKf = kfs[kfs.length - 1];
  if (currentTime >= lastKf.time) {
    return lastKf.points.length === action.points.length ? lastKf.points : action.points;
  }

  // Buscar el par de fotogramas clave [prev, next] que contienen currentTime
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (currentTime >= a.time && currentTime <= b.time) {
      const span = b.time - a.time;
      if (span <= 1e-4 || a.points.length !== b.points.length) {
        return a.points;
      }
      const ratio = Math.max(0, Math.min(1, (currentTime - a.time) / span));
      return a.points.map((pa, idx) => {
        const pb = b.points[idx] || pa;
        return {
          x: pa.x + (pb.x - pa.x) * ratio,
          y: pa.y + (pb.y - pa.y) * ratio,
        };
      });
    }
  }

  return action.points;
}

/**
 * Inserta o actualiza un fotograma clave manual cuando el analista mueve un nodo o dibujo en el segundo `time`
 */
export function upsertManualKeyframe(
  action: DrawingAction,
  time: number,
  newPoints: { x: number; y: number }[],
  videoEl?: HTMLVideoElement | null
): DrawingAction {
  const cleanTime = Math.round(time * 100) / 100;
  const cleanPoints = newPoints.map((p) => ({
    x: Math.round(p.x * 10) / 10,
    y: Math.round(p.y * 10) / 10,
  }));

  const isAtOrigin = Math.abs(cleanTime - action.timestamp) <= 0.15;
  const existingKfs = action.keyframes ? [...action.keyframes] : [];

  // Asegurar que exista el keyframe origen en action.timestamp
  if (existingKfs.length === 0) {
    existingKfs.push({
      time: Math.round(action.timestamp * 100) / 100,
      points: isAtOrigin
        ? cleanPoints
        : action.points.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })),
      manual: true,
    });
  }

  // Encontrar el fotograma manual previo a cleanTime
  const prevManualTime = existingKfs
    .filter((k) => k.manual && k.time < cleanTime - 0.12)
    .reduce((maxT, k) => Math.max(maxT, k.time), action.timestamp);

  // Filtrar keyframes: conservar los manuales fuera de [cleanTime - 0.12, cleanTime + 0.12]
  // y eliminar los auto-generados entre prevManualTime y el final para que interpolen limpio
  const filtered = existingKfs.filter((k) => {
    if (Math.abs(k.time - cleanTime) <= 0.12) return false;
    if (!k.manual && k.time >= prevManualTime) return false;
    return true;
  });

  filtered.push({
    time: isAtOrigin ? Math.round(action.timestamp * 100) / 100 : cleanTime,
    points: cleanPoints,
    manual: true,
  });

  filtered.sort((a, b) => a.time - b.time);

  const updated: DrawingAction = {
    ...action,
    points: isAtOrigin ? cleanPoints : action.points,
    trackPlayers: action.trackPlayers ?? true,
    keyframes: filtered,
  };

  if (videoEl) {
    captureDrawingTemplates(videoEl, updated, cleanTime, cleanPoints);
  }

  return updated;
}

/**
 * Ejecuta un paso de seguimiento visual en tiempo real sobre el fotograma actual del vídeo
 * para todos los dibujos visibles con `trackPlayers !== false`.
 */
export function stepLivePlayerTracking(
  videoEl: HTMLVideoElement | null,
  actions: DrawingAction[],
  currentTime: number
): { hasNewKeyframes: boolean; updatedActions: DrawingAction[] } {
  if (!videoEl || videoEl.readyState < 2 || actions.length === 0) {
    return { hasNewKeyframes: false, updatedActions: actions };
  }

  // Filtrar dibujos que están activos en este instante y tienen seguimiento activado
  const activeIndices: number[] = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.trackPlayers === false || !a.points || a.points.length === 0) continue;
    const maxDur = a.visibleDuration > 0 ? a.visibleDuration : 15;
    if (currentTime >= a.timestamp - 0.15 && currentTime <= a.timestamp + maxDur) {
      activeIndices.push(i);
    }
  }

  if (activeIndices.length === 0) {
    return { hasNewKeyframes: false, updatedActions: actions };
  }

  const ctx = getTrackingContext();
  if (!ctx) {
    return { hasNewKeyframes: false, updatedActions: actions };
  }

  let imgData: Uint8ClampedArray;
  try {
    drawVideoFrameCropped(ctx, videoEl, TRACK_W, TRACK_H);
    imgData = ctx.getImageData(0, 0, TRACK_W, TRACK_H).data;
  } catch {
    return { hasNewKeyframes: false, updatedActions: actions };
  }

  let hasNewKeyframes = false;
  const nextActions = [...actions];

  for (const idx of activeIndices) {
    const action = nextActions[idx];
    let mem = trackerMap.get(action.id);

    // Si estamos justo en el inicio del dibujo (o se acaba de rebobinar al inicio), inicializar plantilla
    if (!mem || Math.abs(currentTime - action.timestamp) <= 0.08) {
      const startPts =
        action.keyframes && action.keyframes.length > 0 && Math.abs(action.keyframes[0].time - action.timestamp) <= 0.15
          ? action.keyframes[0].points
          : action.points;
      const rigid = isRigidRadiusTool(action.tool);
      const anchorPts = rigid ? [startPts[0]] : startPts;
      const templates = anchorPts.map((pt) => buildPointTemplate(imgData, pt));
      const rigidOffsets = rigid
        ? startPts.slice(1).map((p) => ({ dx: p.x - startPts[0].x, dy: p.y - startPts[0].y }))
        : [];

      mem = {
        actionId: action.id,
        lastTime: currentTime,
        templates,
        rigidFromFirstPoint: rigid,
        rigidOffsets,
        livePoints: startPts.map((p) => ({ ...p })),
        liveTime: currentTime,
      };
      trackerMap.set(action.id, mem);

      if (!action.keyframes || action.keyframes.length === 0) {
        nextActions[idx] = {
          ...action,
          trackPlayers: true,
          keyframes: [
            {
              time: Math.round(action.timestamp * 100) / 100,
              points: startPts.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })),
              manual: true,
            },
          ],
        };
        hasNewKeyframes = true;
      }
      continue;
    }

    const dt = currentTime - mem.lastTime;
    // Si el vídeo saltó hacia atrás o dio un salto largo, re-sincronizar con los keyframes existentes
    if (dt < 0 || dt > 0.45) {
      const interpPts = getInterpolatedPointsAtTime(action, currentTime);
      const rigid = isRigidRadiusTool(action.tool);
      const anchorPts = rigid ? [interpPts[0]] : interpPts;
      mem.templates = anchorPts.map((pt) => buildPointTemplate(imgData, pt));
      mem.lastTime = currentTime;
      mem.livePoints = interpPts;
      mem.liveTime = currentTime;
      continue;
    }

    // Si hay un keyframe manual posterior a currentTime, respetar la interpolación manual hasta pasar ese keyframe
    const hasManualAhead = action.keyframes?.some(
      (k) => k.manual && k.time > currentTime + 0.02
    );
    if (hasManualAhead) {
      const interpPts = getInterpolatedPointsAtTime(action, currentTime);
      mem.livePoints = interpPts;
      mem.liveTime = currentTime;
      mem.lastTime = currentTime;
      // Si estamos muy cerca de un keyframe manual, actualizar plantilla en ese punto
      const nearManual = action.keyframes?.find(
        (k) => k.manual && Math.abs(k.time - currentTime) <= 0.08
      );
      if (nearManual) {
        const rigid = isRigidRadiusTool(action.tool);
        const anchorPts = rigid ? [nearManual.points[0]] : nearManual.points;
        mem.templates = anchorPts.map((pt) => buildPointTemplate(imgData, pt));
      }
      continue;
    }

    if (dt < 0.015) continue;

    // Rastrear cada punto de jugador en el nuevo fotograma
    let newPts: { x: number; y: number }[];
    if (mem.rigidFromFirstPoint) {
      const trackedCenter = trackSinglePoint(imgData, mem.templates[0], dt);
      newPts = [
        trackedCenter,
        ...mem.rigidOffsets.map((off) => ({
          x: Math.round((trackedCenter.x + off.dx) * 10) / 10,
          y: Math.round((trackedCenter.y + off.dy) * 10) / 10,
        })),
      ];
    } else {
      newPts = mem.templates.map((tpl) => trackSinglePoint(imgData, tpl, dt));
    }

    mem.lastTime = currentTime;
    mem.livePoints = newPts;
    mem.liveTime = currentTime;

    // Guardar un keyframe cada ~0.10 s para persistir la trayectoria del jugador
    const kfs = action.keyframes ? [...action.keyframes] : [];
    const lastKfTime = kfs.length > 0 ? kfs[kfs.length - 1].time : -999;
    if (currentTime - lastKfTime >= 0.1) {
      const roundedT = Math.round(currentTime * 100) / 100;
      kfs.push({
        time: roundedT,
        points: newPts,
        manual: false,
      });
      nextActions[idx] = {
        ...action,
        trackPlayers: true,
        keyframes: kfs,
      };
      hasNewKeyframes = true;
    }
  }

  return { hasNewKeyframes, updatedActions: nextActions };
}
