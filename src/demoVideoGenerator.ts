// Generador de vídeo sintético de partido táctico 2D para probar "Usar el vídeo del visor" al instante
export async function createDemoMatchVideoBlobUrl(): Promise<{ url: string; duration: number; blob: Blob }> {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d')!;

  const stream = canvas.captureStream(30);
  let mimeType = 'video/webm;codecs=vp9';
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'video/webm';
  }
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    mimeType = 'video/mp4';
  }

  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  return new Promise((resolve) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: mimeType });
      const url = URL.createObjectURL(blob);
      resolve({ url, duration: 8, blob });
    };

    recorder.start();

    let frame = 0;
    const totalFrames = 240; // 8 segundos a 30fps

    const senecaPlayers = [
      { num: 1, x: 90, y: 360, dx: 0.1, dy: 0 },
      { num: 2, x: 280, y: 150, dx: 1.1, dy: 0.2 },
      { num: 4, x: 250, y: 280, dx: 0.8, dy: 0.1 },
      { num: 5, x: 250, y: 440, dx: 0.8, dy: -0.1 },
      { num: 3, x: 280, y: 570, dx: 1.2, dy: -0.2 },
      { num: 6, x: 450, y: 360, dx: 1.3, dy: 0.1 },
      { num: 8, x: 560, y: 230, dx: 1.6, dy: 0.3 },
      { num: 10, x: 580, y: 480, dx: 1.5, dy: -0.3 },
      { num: 7, x: 760, y: 140, dx: 1.9, dy: 0.6 },
      { num: 9, x: 820, y: 360, dx: 1.7, dy: -0.1 },
      { num: 11, x: 760, y: 580, dx: 1.8, dy: -0.5 },
    ];

    const rivalPlayers = [
      { num: 1, x: 1190, y: 360, dx: -0.1, dy: 0 },
      { num: 2, x: 980, y: 560, dx: -0.8, dy: -0.2 },
      { num: 4, x: 1010, y: 430, dx: -0.7, dy: -0.1 },
      { num: 5, x: 1010, y: 290, dx: -0.7, dy: 0.1 },
      { num: 3, x: 980, y: 160, dx: -0.9, dy: 0.2 },
      { num: 6, x: 830, y: 360, dx: -1.1, dy: 0 },
      { num: 8, x: 740, y: 460, dx: -1.2, dy: -0.2 },
      { num: 10, x: 740, y: 260, dx: -1.2, dy: 0.2 },
      { num: 7, x: 560, y: 550, dx: -1.0, dy: -0.1 },
      { num: 9, x: 500, y: 360, dx: -0.9, dy: 0.1 },
      { num: 11, x: 560, y: 170, dx: -1.0, dy: 0.1 },
    ];

    const drawFrame = () => {
      const progress = frame / totalFrames;

      ctx.fillStyle = '#1b5e20';
      ctx.fillRect(0, 0, 1280, 720);

      for (let i = 0; i < 16; i++) {
        ctx.fillStyle = i % 2 === 0 ? '#1b5e20' : '#216b27';
        ctx.fillRect(i * 80, 40, 80, 640);
      }

      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 3;
      ctx.strokeRect(50, 40, 1180, 640);

      ctx.beginPath();
      ctx.moveTo(640, 40);
      ctx.lineTo(640, 680);
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(640, 360, 85, 0, Math.PI * 2);
      ctx.stroke();

      ctx.strokeRect(50, 170, 170, 380);
      ctx.strokeRect(50, 260, 65, 200);
      ctx.strokeRect(1060, 170, 170, 380);
      ctx.strokeRect(1165, 260, 65, 200);

      ctx.fillStyle = 'rgba(18, 18, 18, 0.9)';
      ctx.fillRect(50, 52, 420, 42);
      ctx.fillStyle = '#cc2016';
      ctx.fillRect(50, 52, 8, 42);
      ctx.fillStyle = '#f5b800';
      ctx.font = 'bold 18px sans-serif';
      ctx.fillText('SÉNECA CF  2 - 0  RIVAL FC', 74, 79);
      ctx.fillStyle = '#ffffff';
      ctx.font = '15px monospace';
      const sec = Math.floor(frame / 30);
      const ms = Math.floor(((frame % 30) / 30) * 10);
      ctx.fillText(`JORNADA LIGA | 00:0${sec}.${ms}`, 310, 79);

      rivalPlayers.forEach((p) => {
        const px = p.x + p.dx * frame * 0.45;
        const py = p.y + p.dy * frame * 0.45;
        ctx.beginPath();
        ctx.arc(px, py, 15, 0, Math.PI * 2);
        ctx.fillStyle = '#1e3a8a';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(p.num), px, py);
      });

      senecaPlayers.forEach((p) => {
        const px = p.x + p.dx * frame * 0.55;
        const py = p.y + p.dy * frame * 0.55;
        ctx.beginPath();
        ctx.arc(px, py, 16, 0, Math.PI * 2);
        ctx.fillStyle = '#cc2016';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#f5b800';
        ctx.stroke();

        ctx.fillStyle = '#f5b800';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(p.num), px, py);
      });

      let bx = 450;
      let by = 360;
      if (progress < 0.3) {
        const t = progress / 0.3;
        bx = 450 + (620 - 450) * t;
        by = 360 + (240 - 360) * t;
      } else if (progress < 0.65) {
        const t = (progress - 0.3) / 0.35;
        bx = 620 + (920 - 620) * t;
        by = 240 + (190 - 240) * t;
      } else if (progress < 0.88) {
        const t = (progress - 0.65) / 0.23;
        bx = 920 + (1020 - 920) * t;
        by = 190 + (350 - 190) * t;
      } else {
        const t = (progress - 0.88) / 0.12;
        bx = 1020 + (1225 - 1020) * t;
        by = 350 + (360 - 350) * t;
      }

      ctx.beginPath();
      ctx.arc(bx, by, 9, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#000000';
      ctx.stroke();

      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';

      frame++;
      if (frame <= totalFrames) {
        setTimeout(drawFrame, 12);
      } else {
        recorder.stop();
      }
    };

    drawFrame();
  });
}

export function formatTimecode(seconds: number, includeTenths = true): string {
  if (!isFinite(seconds) || seconds < 0) return includeTenths ? '0:00.0' : '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds % 1) * 10);
  const paddedSecs = secs < 10 ? `0${secs}` : `${secs}`;
  return includeTenths ? `${mins}:${paddedSecs}.${tenths}` : `${mins}:${paddedSecs}`;
}

export function getMatchPeriodClock(
  videoSeconds: number,
  markers: {
    firstHalfStart?: number;
    firstHalfEnd?: number;
    secondHalfStart?: number;
    matchEnd?: number;
  }
): { periodLabel: string; matchClock: string } | null {
  const { firstHalfStart, firstHalfEnd, secondHalfStart, matchEnd } = markers;

  if (secondHalfStart !== undefined && videoSeconds >= secondHalfStart) {
    if (matchEnd !== undefined && videoSeconds > matchEnd) {
      return { periodLabel: 'FIN PARTIDO', matchClock: formatTimecode(45 * 60 + (matchEnd - secondHalfStart), false) };
    }
    const elapsed2nd = Math.max(0, videoSeconds - secondHalfStart);
    return {
      periodLabel: '2ª PARTE',
      matchClock: formatTimecode(45 * 60 + elapsed2nd, false),
    };
  }

  if (firstHalfStart !== undefined && videoSeconds >= firstHalfStart) {
    if (firstHalfEnd !== undefined && videoSeconds > firstHalfEnd) {
      return {
        periodLabel: 'DESCANSO',
        matchClock: formatTimecode(firstHalfEnd - firstHalfStart, false),
      };
    }
    const elapsed1st = Math.max(0, videoSeconds - firstHalfStart);
    return {
      periodLabel: '1ª PARTE',
      matchClock: formatTimecode(elapsed1st, false),
    };
  }

  if (firstHalfStart !== undefined && videoSeconds < firstHalfStart) {
    return {
      periodLabel: 'PREVIA',
      matchClock: '0:00',
    };
  }

  return null;
}
