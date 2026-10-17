import { createClient } from '@supabase/supabase-js';

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || 'https://aojlwavrjxxpzupwchxr.supabase.co';
export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFvamx3YXZyanh4cHp1cHdjaHhyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyNjE5NjksImV4cCI6MjEwNzgzNzk2OX0.6gV-v3PJf9a4AOgtdnyM6XxEZ32M0ZYyZBTpS9EslO0';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export interface VideoFileItem {
  id: string;
  name: string;
  url: string;
  duration: number;
  size?: number;
  isDemo?: boolean;
}

export interface ClipEvent {
  id: string;
  name: string;
  category: string;
  color: string;
  startTime: number;
  endTime: number;
  videoId: string;
  videoName: string;
  team: 'Séneca CF' | 'Rival';
  player?: string;
  zone?: string;
  half?: '1ª Parte' | '2ª Parte';
  descriptors?: string[]; // Descriptores secundarios estilo Nacsport (ej: ['Éxito', 'Carril Izquierdo', 'Contraataque'])
  notes?: string;
  drawingDataUrl?: string;
  isFreezeInsert?: boolean;
  freezeTimestamp?: number;
  freezeDuration?: number;
  playlistIds?: string[]; // Listas de presentación a las que pertenece
  createdAt: string;
}

export interface PresentationPlaylist {
  id: string;
  name: string;
  description?: string;
  clipIds: string[];
  color: string;
  createdAt: string;
}

export interface CaptureItem {
  id: string;
  name: string;
  timestamp: number;
  dataUrl: string;
  freezeDuration?: number;
  notes?: string;
  createdAt: string;
}

export type PintadoToolType =
  | 'flecha_curva'
  | 'flecha_recta'
  | 'flecha_libre'
  | 'texto'
  | 'etiqueta'
  | 'rectangulo'
  | 'circulo'
  | 'zona_elipse'
  | 'triangulo'
  | 'zona_libre'
  | 'conector'
  | 'foco'
  | 'orientacion'
  | 'lupa'
  | 'distancia'
  | 'jugador_ficha'
  | 'escudo_seneca'
  | 'balon'
  | 'klip_tracking' // Ruta de seguimiento de jugador con estela luminosa estilo KlipDraw
  | 'klip_radar' // Anillo 3D con radar animado estilo KlipDraw
  | 'klip_sombra'; // Bloqueo / Sombra de cobertura defensiva

export interface DrawingAction {
  id: string;
  tool: PintadoToolType;
  color: string;
  fillColor: string;
  lineWidth: number;
  lineStyle: 'solid' | 'dashed';
  scale: number; // Tamaño % (50 a 200)
  opacity: number; // Transparencia % (10 a 100)
  visibleDuration: number; // segundos visible en el vídeo (0 = siempre, o 3, 5, 8, 10, 15s)
  rotation: number; // grados (0 a 360)
  points: { x: number; y: number }[];
  text?: string;
  subText?: string;
  dorsal?: string;
  timestamp: number; // Segundo del vídeo en el que se creó
  closed?: boolean;
}

export interface RosterPlayerItem {
  id: string;
  dorsal: string;
  name: string;
  team: 'Séneca CF' | 'Rival';
}

export interface MatchMarkers {
  firstHalfStart?: number;
  firstHalfEnd?: number;
  secondHalfStart?: number;
  matchEnd?: number;
}

export interface TagCategory {
  id: string;
  name: string;
  color: string;
  shortcut: string;
  preRoll: number;
  postRoll: number;
  type: 'Ataque' | 'Defensa' | 'Transición' | 'ABP' | 'Resultado';
}

export interface SenecaProject {
  id: string;
  name: string;
  rival: string;
  competition: string;
  match_date: string;
  active_module: 'editor' | 'con_video' | 'sin_video';
  events: ClipEvent[];
  captures: CaptureItem[];
  drawings: DrawingAction[];
  markers: MatchMarkers;
  tag_categories: TagCategory[];
  playlists?: PresentationPlaylist[];
  updated_at: string;
}

export const DEFAULT_TAG_CATEGORIES: TagCategory[] = [
  { id: 'cat-1', name: 'Salida de Balón', color: '#cc2016', shortcut: '1', preRoll: 5, postRoll: 5, type: 'Ataque' },
  { id: 'cat-2', name: 'Ataque Organizado', color: '#e65100', shortcut: '2', preRoll: 6, postRoll: 6, type: 'Ataque' },
  { id: 'cat-3', name: 'Transición Ofensiva', color: '#f5b800', shortcut: '3', preRoll: 5, postRoll: 6, type: 'Transición' },
  { id: 'cat-4', name: 'Ocasión / Tiro', color: '#2e7d32', shortcut: '4', preRoll: 6, postRoll: 4, type: 'Resultado' },
  { id: 'cat-5', name: 'GOL SÉNECA CF', color: '#1565c0', shortcut: '5', preRoll: 8, postRoll: 6, type: 'Resultado' },
  { id: 'cat-6', name: 'Presión Alta / Robo', color: '#00838f', shortcut: '6', preRoll: 5, postRoll: 5, type: 'Defensa' },
  { id: 'cat-7', name: 'Repliegue / Bloque Bajo', color: '#4527a0', shortcut: '7', preRoll: 5, postRoll: 5, type: 'Defensa' },
  { id: 'cat-8', name: 'Transición Defensiva', color: '#6a1b9a', shortcut: '8', preRoll: 5, postRoll: 6, type: 'Transición' },
  { id: 'cat-9', name: 'ABP Ofensiva', color: '#00695c', shortcut: '9', preRoll: 5, postRoll: 5, type: 'ABP' },
  { id: 'cat-10', name: 'ABP Defensiva', color: '#37474f', shortcut: '0', preRoll: 5, postRoll: 5, type: 'ABP' },
];

export const NACSPORT_DESCRIPTORS = [
  'Éxito / Positivo',
  'Pérdida / Fallo',
  'Progresión',
  'Supera Líneas',
  'Centro Lateral',
  'Remate a Puerta',
  'Duelo Ganado',
  'Segunda Jugada',
  'Córner',
  'Falta Lateral',
];

export const DEFAULT_PLAYLISTS: PresentationPlaylist[] = [
  {
    id: 'pl-charla-equipo',
    name: 'Charla Equipo (Resumen)',
    description: 'Cortes clave para mostrar a la plantilla del Séneca CF',
    clipIds: [],
    color: '#cc2016',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'pl-ajustes-defensivos',
    name: 'Informe Defensivo / ABP',
    description: 'Acciones de presión, repliegue y balón parado',
    clipIds: [],
    color: '#1565c0',
    createdAt: new Date().toISOString(),
  },
  {
    id: 'pl-ataque-goles',
    name: 'Ataque y Finalizaciones',
    description: 'Salidas de balón, transiciones y ocasiones de gol',
    clipIds: [],
    color: '#2e7d32',
    createdAt: new Date().toISOString(),
  },
];

export const DEFAULT_ROSTER_PLAYERS: RosterPlayerItem[] = [
  { id: 'p-1', dorsal: '1', name: 'PORTERO', team: 'Séneca CF' },
  { id: 'p-2', dorsal: '2', name: 'LATERAL DER.', team: 'Séneca CF' },
  { id: 'p-3', dorsal: '3', name: 'LATERAL IZQ.', team: 'Séneca CF' },
  { id: 'p-4', dorsal: '4', name: 'CENTRAL DER.', team: 'Séneca CF' },
  { id: 'p-5', dorsal: '5', name: 'CENTRAL IZQ.', team: 'Séneca CF' },
  { id: 'p-6', dorsal: '6', name: 'PIVOTE', team: 'Séneca CF' },
  { id: 'p-7', dorsal: '7', name: 'EXTREMO DER.', team: 'Séneca CF' },
  { id: 'p-8', dorsal: '8', name: 'INTERIOR', team: 'Séneca CF' },
  { id: 'p-9', dorsal: '9', name: 'DELANTERO', team: 'Séneca CF' },
  { id: 'p-10', dorsal: '10', name: 'MEDIAPUNTA', team: 'Séneca CF' },
  { id: 'p-11', dorsal: '11', name: 'EXTREMO IZQ.', team: 'Séneca CF' },
  { id: 'p-12', dorsal: '12', name: 'SUPLENTE 12', team: 'Séneca CF' },
];

export const SENECA_PLAYERS = [
  '1. Portero',
  '2. Lateral Der.',
  '3. Lateral Izq.',
  '4. Central Der.',
  '5. Central Izq.',
  '6. Pivote Def.',
  '7. Extremo Der.',
  '8. Interior Der.',
  '9. Delantero Centro',
  '10. Media Punta',
  '11. Extremo Izq.',
  '12. Suplente / Otro',
];
