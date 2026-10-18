import { DrawingAction } from './supabaseClient';
import { getActiveVideoCropBounds, getInterpolatedPointsAtTime, isRigidRadiusTool } from './playerTracker';

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return `rgba(204, 32, 22, ${alpha})`;
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function getDrawingBoundingBox(
  action: DrawingAction,
  currentTime?: number
): {
  cx: number;
  cy: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  const pts =
    currentTime !== undefined ? getInterpolatedPointsAtTime(action, currentTime) : action.points;
  if (!pts || pts.length === 0) {
    return { cx: 0, cy: 0, minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  let minX = Math.min(...xs);
  let maxX = Math.max(...xs);
  let minY = Math.min(...ys);
  let maxY = Math.max(...ys);

  if (
    action.tool === 'texto' ||
    action.tool === 'etiqueta' ||
    action.tool === 'jugador_ficha' ||
    action.tool === 'escudo_seneca' ||
    action.tool === 'balon'
  ) {
    const pad = 45 * (action.scale / 100);
    minX -= pad;
    maxX += pad;
    minY -= pad;
    maxY += pad;
  } else if (
    action.tool === 'circulo' ||
    action.tool === 'zona_elipse' ||
    action.tool === 'lupa' ||
    action.tool === 'foco' ||
    action.tool === 'klip_radar'
  ) {
    const start = pts[0];
    const end = pts[pts.length - 1];
    const r = Math.max(30, Math.hypot(end.x - start.x, end.y - start.y));
    minX = start.x - r;
    maxX = start.x + r;
    minY = start.y - r;
    maxY = start.y + r;
  }

  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { cx, cy, minX: minX - 10, minY: minY - 10, maxX: maxX + 10, maxY: maxY + 10 };
}

/**
 * Devuelve el índice del nodo/jugador sobre el que se hizo clic (o -1 si no se tocó un nodo individual)
 */
export function hitTestDrawingPointIndex(
  action: DrawingAction,
  pt: { x: number; y: number },
  currentTime?: number
): number {
  const pts =
    currentTime !== undefined ? getInterpolatedPointsAtTime(action, currentTime) : action.points;
  if (!pts || pts.length === 0) return -1;
  // En trazos libres con decenas de puntos no seleccionamos vértices individuales
  if (action.tool === 'flecha_libre' || action.tool === 'klip_tracking') return -1;

  const hitRadius = 24;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pt.x - pts[i].x, pt.y - pts[i].y);
    if (d <= hitRadius) {
      return i;
    }
  }
  return -1;
}

export function hitTestDrawing(
  action: DrawingAction,
  pt: { x: number; y: number },
  currentTime?: number
): boolean {
  if (hitTestDrawingPointIndex(action, pt, currentTime) !== -1) return true;
  const box = getDrawingBoundingBox(action, currentTime);
  return pt.x >= box.minX - 14 && pt.x <= box.maxX + 14 && pt.y >= box.minY - 14 && pt.y <= box.maxY + 14;
}

function drawArrowhead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  size: number,
  color: string
) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - size * Math.cos(angle - Math.PI / 6), y - size * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x - size * Math.cos(angle + Math.PI / 6), y - size * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export function renderDrawingActions(
  ctx: CanvasRenderingContext2D,
  actions: DrawingAction[],
  options: {
    currentTime: number;
    selectedId: string | null;
    ignoreTimeVisibility?: boolean;
    videoElement?: HTMLVideoElement | null;
    senecaLogoImg?: HTMLImageElement | null;
  }
) {
  const { currentTime, selectedId, ignoreTimeVisibility = false, videoElement, senecaLogoImg } = options;

  actions.forEach((action) => {
    if (!action.points || action.points.length === 0) return;

    // Comprobar si la acción es visible en el segundo actual (según "Visible durante: 8 s")
    if (!ignoreTimeVisibility && action.visibleDuration > 0) {
      const diff = currentTime - action.timestamp;
      if (diff < -0.25 || diff > action.visibleDuration) {
        return;
      }
    }

    const pts = getInterpolatedPointsAtTime(action, currentTime);
    if (!pts || pts.length === 0) return;

    ctx.save();
    const alpha = Math.max(0.1, Math.min(1, (action.opacity ?? 100) / 100));
    const scaleFactor = Math.max(0.4, (action.scale ?? 100) / 100);
    const strokeW = Math.max(1.5, (action.lineWidth || 4) * scaleFactor);

    const box = getDrawingBoundingBox(action, currentTime);
    if (action.rotation && action.rotation !== 0) {
      ctx.translate(box.cx, box.cy);
      ctx.rotate((action.rotation * Math.PI) / 180);
      ctx.translate(-box.cx, -box.cy);
    }

    ctx.globalAlpha = alpha;
    ctx.strokeStyle = action.color || '#cc2016';
    ctx.fillStyle = action.fillColor || '#141414';
    ctx.lineWidth = strokeW;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (action.lineStyle === 'dashed') {
      ctx.setLineDash([strokeW * 3, strokeW * 2]);
    } else {
      ctx.setLineDash([]);
    }

    const start = pts[0];
    const end = pts[pts.length - 1];
    const headLen = Math.max(14, strokeW * 3.8);

    switch (action.tool) {
      /* ==================== 1. FLECHAS ==================== */
      case 'flecha_recta': {
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.setLineDash([]);
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        drawArrowhead(ctx, end.x, end.y, angle, headLen, action.color);
        break;
      }

      case 'flecha_curva': {
        const midX = (start.x + end.x) / 2;
        const midY = (start.y + end.y) / 2;
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const dist = Math.hypot(dx, dy);
        // Punto de control elevado perpendicularmente para simular pase aéreo o desmarque curvo
        const ctrl =
          pts.length >= 3
            ? pts[1]
            : {
                x: midX - dy * 0.28,
                y: midY - Math.max(45, dist * 0.3) * (dx >= 0 ? 1 : -1) * (dx >= 0 ? 1 : -1),
              };

        // Sombra en el suelo opcional para sensación 3D de balón aéreo
        ctx.save();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = Math.max(2, strokeW * 0.55);
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();
        ctx.restore();

        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.quadraticCurveTo(ctrl.x, ctrl.y, end.x, end.y);
        ctx.stroke();
        ctx.setLineDash([]);

        const tangentAngle = Math.atan2(end.y - ctrl.y, end.x - ctrl.x);
        drawArrowhead(ctx, end.x, end.y, tangentAngle, headLen, action.color);
        break;
      }

      case 'flecha_libre': {
        ctx.beginPath();
        pts.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        if (pts.length >= 2) {
          const prev = pts[Math.max(0, pts.length - 4)];
          const angle = Math.atan2(end.y - prev.y, end.x - prev.x);
          drawArrowhead(ctx, end.x, end.y, angle, headLen, action.color);
        }
        break;
      }

      /* ==================== 2. TEXTOS Y ETIQUETAS ==================== */
      case 'texto': {
        ctx.setLineDash([]);
        const fontSize = Math.round(24 * scaleFactor);
        ctx.font = `800 ${fontSize}px "Barlow Condensed", sans-serif`;
        const label = (action.text || 'TEXTO TÁCTICO').toUpperCase();
        const metrics = ctx.measureText(label);
        const padX = 12 * scaleFactor;
        const padY = 8 * scaleFactor;
        const boxW = metrics.width + padX * 2;
        const boxH = fontSize + padY * 1.6;

        ctx.fillStyle = hexToRgba(action.fillColor || '#141414', 0.85);
        ctx.fillRect(start.x - padX, start.y - fontSize, boxW, boxH);
        ctx.strokeStyle = action.color;
        ctx.lineWidth = 2.5;
        ctx.strokeRect(start.x - padX, start.y - fontSize, boxW, boxH);

        ctx.fillStyle = action.color;
        ctx.fillText(label, start.x, start.y);
        break;
      }

      case 'etiqueta': {
        ctx.setLineDash([]);
        const fontSize = Math.round(20 * scaleFactor);
        ctx.font = `700 ${fontSize}px "Barlow Condensed", sans-serif`;
        const label = (action.text || 'ETIQUETA SÉNECA CF').toUpperCase();
        const metrics = ctx.measureText(label);
        const w = metrics.width + 32 * scaleFactor;
        const h = fontSize + 16 * scaleFactor;
        const x = start.x;
        const y = start.y - h / 2;

        // Forma de etiqueta con punta lateral + pin hacia el jugador
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + w, y);
        ctx.lineTo(x + w + 12 * scaleFactor, y + h / 2);
        ctx.lineTo(x + w, y + h);
        ctx.lineTo(x, y + h);
        ctx.closePath();
        ctx.fillStyle = action.color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, x + 12 * scaleFactor, start.y + fontSize * 0.34);
        break;
      }

      /* ==================== 3. ZONAS ==================== */
      case 'rectangulo': {
        const w = end.x - start.x;
        const h = end.y - start.y;
        ctx.fillStyle = hexToRgba(action.fillColor || action.color, 0.25);
        ctx.fillRect(start.x, start.y, w, h);
        ctx.strokeRect(start.x, start.y, w, h);
        break;
      }

      case 'circulo': {
        const radius = Math.max(15, Math.hypot(end.x - start.x, end.y - start.y));
        ctx.beginPath();
        ctx.arc(start.x, start.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(action.fillColor || action.color, 0.25);
        ctx.fill();
        ctx.stroke();
        break;
      }

      case 'zona_elipse': {
        // Anillo de perspectiva de césped (Zona en perspectiva)
        const rx = Math.max(24, Math.hypot(end.x - start.x, end.y - start.y));
        const ry = rx * 0.42;
        ctx.beginPath();
        ctx.ellipse(start.x, start.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(action.fillColor || action.color, 0.32);
        ctx.fill();
        ctx.stroke();

        // Segundo anillo interior para estética televisiva
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.ellipse(start.x, start.y, rx * 0.72, ry * 0.72, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }

      case 'triangulo': {
        const p1 = start;
        const p2 = end;
        const p3 = pts.length >= 3 ? pts[1] : { x: start.x - (end.x - start.x), y: end.y };
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.closePath();
        ctx.fillStyle = hexToRgba(action.fillColor || action.color, 0.28);
        ctx.fill();
        ctx.stroke();
        // Vértices destacados
        [p1, p2, p3].forEach((v) => {
          ctx.beginPath();
          ctx.arc(v.x, v.y, strokeW * 1.4, 0, Math.PI * 2);
          ctx.fillStyle = action.color;
          ctx.fill();
        });
        break;
      }

      case 'zona_libre': {
        if (pts.length < 2) break;
        ctx.beginPath();
        pts.forEach((p, idx) => {
          if (idx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.closePath();
        ctx.fillStyle = hexToRgba(action.fillColor || action.color, 0.28);
        ctx.fill();
        ctx.stroke();
        // Nodos poligonales
        pts.forEach((v) => {
          ctx.beginPath();
          ctx.arc(v.x, v.y, Math.max(4, strokeW * 1.2), 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.stroke();
        });
        break;
      }

      /* ==================== 4. VARIOS (CONECTOR, FOCO, ORIENTACIÓN, LUPA, DISTANCIA) ==================== */
      case 'conector': {
        // Línea de estructura táctica que une varios jugadores con anillos en los pies
        ctx.beginPath();
        pts.forEach((p, idx) => {
          if (idx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
        ctx.setLineDash([]);
        pts.forEach((p) => {
          ctx.beginPath();
          ctx.ellipse(p.x, p.y, 24 * scaleFactor, 11 * scaleFactor, 0, 0, Math.PI * 2);
          ctx.fillStyle = hexToRgba(action.color, 0.35);
          ctx.fill();
          ctx.lineWidth = strokeW;
          ctx.strokeStyle = action.color;
          ctx.stroke();
        });
        break;
      }

      case 'foco': {
        ctx.setLineDash([]);
        const rx = Math.max(28, Math.hypot(end.x - start.x, end.y - start.y) || 38 * scaleFactor);
        const ry = rx * 0.42;
        const beamHeight = Math.max(180, rx * 4.2);

        // Haz de luz cilíndrico / cónico vertical desde arriba hacia el jugador
        const grad = ctx.createLinearGradient(start.x, start.y - beamHeight, start.x, start.y);
        grad.addColorStop(0, hexToRgba(action.color, 0.02));
        grad.addColorStop(0.5, hexToRgba(action.color, 0.22));
        grad.addColorStop(1, hexToRgba(action.color, 0.55));

        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.moveTo(start.x - rx * 0.65, start.y - beamHeight);
        ctx.lineTo(start.x + rx * 0.65, start.y - beamHeight);
        ctx.lineTo(start.x + rx, start.y);
        ctx.lineTo(start.x - rx, start.y);
        ctx.closePath();
        ctx.fill();

        // Anillo luminoso en los pies del jugador
        ctx.beginPath();
        ctx.ellipse(start.x, start.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(action.fillColor || action.color, 0.4);
        ctx.fill();
        ctx.lineWidth = strokeW;
        ctx.strokeStyle = action.color;
        ctx.stroke();
        break;
      }

      case 'orientacion': {
        // Perfil corporal y cono de visión / escaneo visual del jugador
        ctx.setLineDash([]);
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const coneLen = Math.max(65, Math.hypot(end.x - start.x, end.y - start.y));
        const spread = Math.PI / 4.2;

        // Cono de visión (Field of View)
        const grad = ctx.createRadialGradient(start.x, start.y, 10, start.x, start.y, coneLen);
        grad.addColorStop(0, hexToRgba(action.color, 0.55));
        grad.addColorStop(1, hexToRgba(action.color, 0.05));

        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.arc(start.x, start.y, coneLen, angle - spread, angle + spread);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = action.color;
        ctx.stroke();

        // Arco de orientación corporal en los pies
        ctx.beginPath();
        ctx.ellipse(start.x, start.y, 24 * scaleFactor, 12 * scaleFactor, 0, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 3;
        ctx.stroke();
        break;
      }

      case 'lupa': {
        // Lupa de Zoom x2 sobre el fotograma del vídeo
        ctx.setLineDash([]);
        const radius = Math.max(48, Math.hypot(end.x - start.x, end.y - start.y) || 70 * scaleFactor);
        ctx.save();
        ctx.beginPath();
        ctx.arc(start.x, start.y, radius, 0, Math.PI * 2);
        ctx.clip();

        if (videoElement && videoElement.readyState >= 2) {
          try {
            const vw = videoElement.videoWidth || 1280;
            const vh = videoElement.videoHeight || 720;
            const cb = getActiveVideoCropBounds();
            const cropX = cb.left * vw;
            const cropY = cb.top * vh;
            const cropW = Math.max(1, (cb.right - cb.left) * vw);
            const cropH = Math.max(1, (cb.bottom - cb.top) * vh);
            const sx = Math.max(0, cropX + (start.x / 1280) * cropW - (radius / 1280) * cropW * 0.5);
            const sy = Math.max(0, cropY + (start.y / 720) * cropH - (radius / 720) * cropH * 0.5);
            const sw = Math.min(vw - sx, (radius / 1280) * cropW);
            const sh = Math.min(vh - sy, (radius / 720) * cropH);
            if (sw > 0 && sh > 0) {
              ctx.drawImage(videoElement, sx, sy, sw, sh, start.x - radius, start.y - radius, radius * 2, radius * 2);
            }
          } catch {
            ctx.fillStyle = hexToRgba(action.color, 0.25);
            ctx.fillRect(start.x - radius, start.y - radius, radius * 2, radius * 2);
          }
        } else {
          ctx.fillStyle = hexToRgba(action.color, 0.25);
          ctx.fillRect(start.x - radius, start.y - radius, radius * 2, radius * 2);
        }
        ctx.restore();

        ctx.beginPath();
        ctx.arc(start.x, start.y, radius, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(4, strokeW);
        ctx.strokeStyle = action.color;
        ctx.stroke();
        break;
      }

      case 'distancia': {
        // Medidor táctico de distancia en metros entre dos líneas o jugadores
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();

        const pxDist = Math.hypot(end.x - start.x, end.y - start.y);
        const meters = (pxDist / 18).toFixed(1);
        const mx = (start.x + end.x) / 2;
        const my = (start.y + end.y) / 2;

        ctx.setLineDash([]);
        ctx.font = `bold ${Math.round(16 * scaleFactor)}px "Barlow Condensed", sans-serif`;
        const txt = `${meters} m`;
        const tw = ctx.measureText(txt).width + 14;
        ctx.fillStyle = '#141414';
        ctx.fillRect(mx - tw / 2, my - 13, tw, 24);
        ctx.strokeStyle = action.color;
        ctx.lineWidth = 2;
        ctx.strokeRect(mx - tw / 2, my - 13, tw, 24);
        ctx.fillStyle = '#f5b800';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(txt, mx, my);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        break;
      }

      /* ==================== 5. NÚMEROS Y JUGADORES / ESCUDO / BALÓN ==================== */
      case 'jugador_ficha': {
        ctx.setLineDash([]);
        const r = Math.round(20 * scaleFactor);
        // Anillo de base
        ctx.beginPath();
        ctx.ellipse(start.x, start.y + r * 0.85, r * 1.25, r * 0.45, 0, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.45)';
        ctx.fill();

        // Ficha circular del dorsal
        ctx.beginPath();
        ctx.arc(start.x, start.y, r, 0, Math.PI * 2);
        ctx.fillStyle = action.color || '#cc2016';
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#f5b800';
        ctx.stroke();

        // Número de dorsal
        ctx.fillStyle = '#ffffff';
        ctx.font = `800 ${Math.round(18 * scaleFactor)}px "Barlow Condensed", sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(action.dorsal || '9', start.x, start.y + 1);

        // Nombre del jugador debajo si existe
        if (action.text) {
          ctx.font = `700 ${Math.round(13 * scaleFactor)}px "Barlow Condensed", sans-serif`;
          const nameUp = action.text.toUpperCase();
          const nw = ctx.measureText(nameUp).width + 12;
          ctx.fillStyle = 'rgba(20,20,20,0.9)';
          ctx.fillRect(start.x - nw / 2, start.y + r + 4, nw, 18 * scaleFactor);
          ctx.fillStyle = '#f5b800';
          ctx.fillText(nameUp, start.x, start.y + r + 4 + 9 * scaleFactor);
        }
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        break;
      }

      case 'escudo_seneca': {
        ctx.setLineDash([]);
        const size = Math.round(48 * scaleFactor);
        let drawn = false;
        if (senecaLogoImg && senecaLogoImg.complete && senecaLogoImg.naturalWidth > 0) {
          try {
            ctx.drawImage(senecaLogoImg, start.x - size / 2, start.y - size / 2, size, size);
            drawn = true;
          } catch {
            drawn = false;
          }
        }
        if (!drawn) {
          ctx.beginPath();
          ctx.arc(start.x, start.y, size / 2, 0, Math.PI * 2);
          ctx.fillStyle = '#f5b800';
          ctx.fill();
          ctx.strokeStyle = '#cc2016';
          ctx.lineWidth = 3;
          ctx.stroke();
        }
        break;
      }

      case 'balon': {
        ctx.setLineDash([]);
        const r = Math.round(14 * scaleFactor);
        ctx.beginPath();
        ctx.arc(start.x, start.y, r, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#141414';
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(start.x, start.y, r * 0.45, 0, Math.PI * 2);
        ctx.fillStyle = '#141414';
        ctx.fill();
        break;
      }

      /* ==================== 6. HERRAMIENTAS KLIPDRAW PRO ==================== */
      case 'klip_tracking': {
        // Estela de seguimiento de jugador en movimiento estilo KlipDraw (anillo inicial + rastro degradado + anillo final + flecha)
        ctx.setLineDash([]);
        const ringRx = 26 * scaleFactor;
        const ringRy = 11 * scaleFactor;

        // Sombra luminosa de la trayectoria
        ctx.save();
        ctx.strokeStyle = hexToRgba(action.color, 0.35);
        ctx.lineWidth = strokeW * 3.2;
        ctx.beginPath();
        pts.forEach((p, idx) => {
          if (idx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
        ctx.restore();

        // Línea central punteada de carrera
        ctx.save();
        ctx.setLineDash([8, 6]);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(2, strokeW * 0.8);
        ctx.beginPath();
        pts.forEach((p, idx) => {
          if (idx === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        ctx.stroke();
        ctx.restore();

        // Anillo en posición de origen
        ctx.beginPath();
        ctx.ellipse(start.x, start.y, ringRx * 0.85, ringRy * 0.85, 0, 0, Math.PI * 2);
        ctx.strokeStyle = hexToRgba(action.color, 0.7);
        ctx.lineWidth = 2.5;
        ctx.stroke();

        // Anillo 3D KlipDraw en posición de destino
        ctx.beginPath();
        ctx.ellipse(end.x, end.y, ringRx, ringRy, 0, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(action.color, 0.4);
        ctx.fill();
        ctx.lineWidth = strokeW;
        ctx.strokeStyle = action.color;
        ctx.stroke();

        if (pts.length >= 2) {
          const prev = pts[Math.max(0, pts.length - 3)];
          const angle = Math.atan2(end.y - prev.y, end.x - prev.x);
          drawArrowhead(ctx, end.x, end.y, angle, headLen * 1.1, action.color);
        }
        break;
      }

      case 'klip_radar': {
        // Anillo 3D multicapa estilo KlipDraw con indicador de jugador clave
        ctx.setLineDash([]);
        const rx = Math.max(30, Math.hypot(end.x - start.x, end.y - start.y) || 42 * scaleFactor);
        const ry = rx * 0.44;

        // Anillo exterior luminoso
        ctx.beginPath();
        ctx.ellipse(start.x, start.y, rx * 1.25, ry * 1.25, 0, 0, Math.PI * 2);
        ctx.strokeStyle = hexToRgba(action.color, 0.45);
        ctx.lineWidth = 2;
        ctx.stroke();

        // Anillo principal 3D con grosor KlipDraw
        ctx.beginPath();
        ctx.ellipse(start.x, start.y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(action.fillColor || action.color, 0.35);
        ctx.fill();
        ctx.lineWidth = Math.max(4, strokeW * 1.3);
        ctx.strokeStyle = action.color;
        ctx.stroke();

        // Arcos segmentados internos tipo diana táctica
        ctx.save();
        ctx.setLineDash([10, 6]);
        ctx.beginPath();
        ctx.ellipse(start.x, start.y, rx * 0.68, ry * 0.68, 0, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.restore();
        break;
      }

      case 'klip_sombra': {
        // Sombra de cobertura defensiva (Cover Shadow) detrás del jugador que presiona
        ctx.setLineDash([]);
        const angle = Math.atan2(end.y - start.y, end.x - start.x);
        const len = Math.max(80, Math.hypot(end.x - start.x, end.y - start.y));
        const halfSpread = Math.PI / 5.5;

        const grad = ctx.createRadialGradient(start.x, start.y, 8, start.x, start.y, len);
        grad.addColorStop(0, 'rgba(20, 20, 20, 0.75)');
        grad.addColorStop(0.7, hexToRgba(action.color, 0.35));
        grad.addColorStop(1, 'rgba(20, 20, 20, 0.02)');

        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.arc(start.x, start.y, len, angle - halfSpread, angle + halfSpread);
        ctx.closePath();
        ctx.fillStyle = grad;
        ctx.fill();

        // Bordes discontinuos de la línea de pase bloqueada
        ctx.save();
        ctx.setLineDash([6, 5]);
        ctx.strokeStyle = action.color;
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.restore();

        // Anillo del jugador defensor en el vértice
        ctx.beginPath();
        ctx.ellipse(start.x, start.y, 22 * scaleFactor, 10 * scaleFactor, 0, 0, Math.PI * 2);
        ctx.fillStyle = action.color;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2;
        ctx.stroke();
        break;
      }
    }

    // Si el elemento está seleccionado (para Mover, Editar, Rotar, Duplicar, Papelera, Delante, Detrás)
    if (selectedId === action.id) {
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = '#f5b800';
      ctx.lineWidth = 2;
      ctx.strokeRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY);

      // Esquinas de selección
      const corners = [
        { x: box.minX, y: box.minY },
        { x: box.maxX, y: box.minY },
        { x: box.maxX, y: box.maxY },
        { x: box.minX, y: box.maxY },
      ];
      ctx.setLineDash([]);
      corners.forEach((c) => {
        ctx.fillStyle = '#cc2016';
        ctx.fillRect(c.x - 4, c.y - 4, 8, 8);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(c.x - 4, c.y - 4, 8, 8);
      });

      // Nodos individuales de jugadores arrastrables (para Conector, Foco, Triángulo, Distancia, etc.)
      if (action.tool !== 'flecha_libre' && action.tool !== 'klip_tracking') {
        const handlePts = isRigidRadiusTool(action.tool) ? [pts[0], pts[pts.length - 1]] : pts;
        handlePts.forEach((hp, hIdx) => {
          ctx.beginPath();
          ctx.arc(hp.x, hp.y, hIdx === 0 || !isRigidRadiusTool(action.tool) ? 7 : 5, 0, Math.PI * 2);
          ctx.fillStyle = hIdx === 0 || !isRigidRadiusTool(action.tool) ? '#f5b800' : '#1666c0';
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = '#141414';
          ctx.stroke();
        });
      }
    }

    ctx.restore();
  });
}
