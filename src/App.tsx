import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  supabase,
  VideoFileItem,
  ClipEvent,
  CaptureItem,
  DrawingAction,
  PintadoToolType,
  RosterPlayerItem,
  MatchMarkers,
  TagCategory,
  BotoneraTemplate,
  PresentationPlaylist,
  SenecaProject,
  DEFAULT_TAG_CATEGORIES,
  DEFAULT_ROSTER_PLAYERS,
  DEFAULT_PLAYLISTS,
  DEFAULT_BOTONERA_TEMPLATES,
  NACSPORT_DESCRIPTORS,
  SENECA_PLAYERS,
} from './supabaseClient';
import { createDemoMatchVideoBlobUrl, formatTimecode, getMatchPeriodClock } from './demoVideoGenerator';
import { renderDrawingActions, hitTestDrawing, hitTestDrawingPointIndex } from './pintadoRenderer';
import {
  captureDrawingTemplates,
  detectVideoCropBounds,
  drawVideoFrameCropped,
  getInterpolatedPointsAtTime,
  isRigidRadiusTool,
  resetTrackerState,
  setActiveVideoCropBounds,
  stepLivePlayerTracking,
  upsertManualKeyframe,
  VideoCropBounds,
} from './playerTracker';
import {
  Volume2,
  VolumeX,
  Maximize,
  Play,
  Pause,
  Undo2,
  Redo2,
  Trash2,
  Download,
  Plus,
  Cloud,
  CloudOff,
  RefreshCw,
  Pencil,
  Check,
  X,
  Film,
  FolderOpen,
  Save,
  FileSpreadsheet,
  Clock,
  MapPin,
  Users,
  Eye,
  HelpCircle,
  Move,
  Copy,
  RotateCw,
  BringToFront,
  SendToBack,
  Tag,
  Type,
  Triangle,
  Hexagon,
  Share2,
  Cone,
  Compass,
  Search,
  Ruler,
  Shield,
  CircleDot,
  Layers,
  Grid,
  ListVideo,
  FolderKanban,
  Code,
  Sparkles,
  CheckSquare,
  Square,
  ChevronDown,
  ChevronRight,
  Footprints,
  Radar,
  ShieldAlert,
  Maximize2,
  Minimize2,
  Sliders,
  LayoutGrid,
  Keyboard,
  Radio,
  Palette,
  Settings,
  Tv,
  Activity,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';

interface HistorySnapshot {
  events: ClipEvent[];
  captures: CaptureItem[];
  drawings: DrawingAction[];
  markers: MatchMarkers;
}

// Limpia eventos antiguos donde se asignaba por defecto '9. Delantero Centro' y 'Éxito / Positivo' sin que el usuario lo hubiera marcado
function sanitizeLoadedEvents(rawEvents: unknown): ClipEvent[] {
  if (!Array.isArray(rawEvents)) return [];
  return rawEvents.map((ev: ClipEvent) => {
    if (!ev || typeof ev !== 'object') return ev;
    if (ev.userClassified || String(ev.id || '').startsWith('ev-demo-')) {
      return ev;
    }
    const cleanedPlayer = ev.player === '9. Delantero Centro' ? undefined : ev.player;
    const cleanedDescriptors = Array.isArray(ev.descriptors)
      ? ev.descriptors.filter((d) => d !== 'Éxito / Positivo')
      : [];
    return {
      ...ev,
      player: cleanedPlayer,
      descriptors: cleanedDescriptors,
    };
  });
}

export default function App() {
  // Navegación principal (Botonera con vídeo activa por defecto)
  const [activeTab, setActiveTab] = useState<'editor' | 'con_video' | 'sin_video'>('con_video');

  // Estado del proyecto actual y sincronización con Supabase
  const [projectId, setProjectId] = useState<string>('seneca-default-project');
  const [projectName, setProjectName] = useState<string>('Jornada 1 - Séneca CF vs Rival');
  const [rivalName, setRivalName] = useState<string>('Rival FC');
  const [competition, setCompetition] = useState<string>('División de Honor / Liga Nacional');
  const [savedProjects, setSavedProjects] = useState<SenecaProject[]>([]);
  const [showProjectsModal, setShowProjectsModal] = useState<boolean>(false);
  const [showSqlModal, setShowSqlModal] = useState<boolean>(false);
  const [showTutorialModal, setShowTutorialModal] = useState<boolean>(false);
  const [showMatrixModal, setShowMatrixModal] = useState<boolean>(false);
  const [matrixViewMode, setMatrixViewMode] = useState<'completa' | 'posiciones' | 'categorias' | 'cruce'>('completa');
  const [supabaseStatus, setSupabaseStatus] = useState<'synced' | 'syncing' | 'local_only'>('syncing');
  const [statusMessage, setStatusMessage] = useState<string>('');

  // Vídeos cargados (soporta múltiples vídeos sin restricción premium)
  const [videos, setVideos] = useState<VideoFileItem[]>([]);
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
  const activeVideo = videos.find((v) => v.id === activeVideoId) || null;

  // Estado del reproductor de vídeo
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const videoContainerRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const senecaLogoRef = useRef<HTMLImageElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [duration, setDuration] = useState<number>(0);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const [videoZoom, setVideoZoom] = useState<number>(100);
  const [autoCropBlackBars, setAutoCropBlackBars] = useState<boolean>(true);
  const [videoCropBounds, setVideoCropBounds] = useState<VideoCropBounds>({
    left: 0,
    right: 1,
    top: 0,
    bottom: 1,
  });
  const lastCropDetectTimeRef = useRef<number>(0);

  const refreshVideoCropBounds = useCallback(
    (videoEl: HTMLVideoElement | null, force = false) => {
      if (!autoCropBlackBars) {
        const full = { left: 0, right: 1, top: 0, bottom: 1 };
        setVideoCropBounds(full);
        setActiveVideoCropBounds(full);
        return;
      }
      if (!videoEl || videoEl.readyState < 2) return;
      const now = performance.now();
      if (!force && now - lastCropDetectTimeRef.current < 400) return;
      lastCropDetectTimeRef.current = now;

      const detected = detectVideoCropBounds(videoEl);
      if (!detected) return;

      setVideoCropBounds((prev) => {
        const isDefault =
          prev.left === 0 && prev.right === 1 && prev.top === 0 && prev.bottom === 1;
        if (force || isDefault) {
          setActiveVideoCropBounds(detected);
          return detected;
        }
        // Estabilizar para evitar vibración durante reproducción salvo cambio claro de encuadre
        const diff =
          Math.abs(prev.left - detected.left) +
          Math.abs(prev.right - detected.right) +
          Math.abs(prev.top - detected.top) +
          Math.abs(prev.bottom - detected.bottom);
        if (diff > 0.04) {
          setActiveVideoCropBounds(detected);
          return detected;
        }
        return prev;
      });
    },
    [autoCropBlackBars]
  );

  useEffect(() => {
    const full = { left: 0, right: 1, top: 0, bottom: 1 };
    setVideoCropBounds(full);
    setActiveVideoCropBounds(full);
    if (!activeVideoId) return;
    const t1 = setTimeout(() => refreshVideoCropBounds(videoRef.current, true), 80);
    const t2 = setTimeout(() => refreshVideoCropBounds(videoRef.current, true), 300);
    const t3 = setTimeout(() => refreshVideoCropBounds(videoRef.current, true), 700);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [activeVideoId, refreshVideoCropBounds]);

  const [timelineZoom, setTimelineZoom] = useState<number>(1);
  const [isDraggingOver, setIsDraggingOver] = useState<boolean>(false);
  const [isGeneratingDemo, setIsGeneratingDemo] = useState<boolean>(false);

  // Cortes Punto A y Punto B
  const [pointA, setPointA] = useState<number | null>(null);
  const [pointB, setPointB] = useState<number | null>(null);
  const [abLoopActive, setAbLoopActive] = useState<boolean>(false);
  const [pipActive, setPipActive] = useState<boolean>(false);
  const [draggingHandle, setDraggingHandle] = useState<
    | null
    | { type: 'playhead' }
    | { type: 'pointA' }
    | { type: 'pointB' }
    | { type: 'marker'; key: keyof MatchMarkers }
    | { type: 'eventStart'; eventId: string }
    | { type: 'eventEnd'; eventId: string }
  >(null);

  // Modal o formulario rápido para clasificar el corte (quién lo ha hecho y positivo/negativo)
  const [pendingClipRange, setPendingClipRange] = useState<{ start: number; end: number } | null>(null);
  const [editingClipId, setEditingClipId] = useState<string | null>(null);
  const [newClipName, setNewClipName] = useState<string>('');
  const [newClipCategory, setNewClipCategory] = useState<string>('Salida de Balón');
  const [newClipTeam, setNewClipTeam] = useState<'Séneca CF' | 'Rival'>('Séneca CF');
  const [newClipPlayer, setNewClipPlayer] = useState<string>('');
  const [newClipDescriptors, setNewClipDescriptors] = useState<string[]>([]);
  const [newClipNotes, setNewClipNotes] = useState<string>('');

  // Datos de análisis (Eventos, Capturas, Pintado, Marcadores de partido, Categorías, Listas de Presentación)
  const [events, setEvents] = useState<ClipEvent[]>([]);
  const [captures, setCaptures] = useState<CaptureItem[]>([]);
  const [drawings, setDrawings] = useState<DrawingAction[]>([]);
  const [markers, setMarkers] = useState<MatchMarkers>({});
  const [tagCategories, setTagCategories] = useState<TagCategory[]>(DEFAULT_TAG_CATEGORIES);
  const [playlists, setPlaylists] = useState<PresentationPlaylist[]>(DEFAULT_PLAYLISTS);
  const [activePlaylistId, setActivePlaylistId] = useState<string>(DEFAULT_PLAYLISTS[0].id);
  const [newPlaylistName, setNewPlaylistName] = useState<string>('');
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [showCategoryLanes, setShowCategoryLanes] = useState<boolean>(true);

  // =========================================================================
  // AGRUPACIÓN Y FILTRADO DE CORTES SEGÚN LO CLASIFICADO (NACSPORT / LONGO)
  // =========================================================================
  const [eventsGroupBy, setEventsGroupBy] = useState<
    'none' | 'category' | 'team' | 'half' | 'player' | 'outcome' | 'zone'
  >('category');
  const [filterTeam, setFilterTeam] = useState<'ALL' | 'Séneca CF' | 'Rival'>('ALL');
  const [filterCategory, setFilterCategory] = useState<string>('ALL');
  const [filterHalf, setFilterHalf] = useState<'ALL' | '1ª Parte' | '2ª Parte'>('ALL');
  const [filterOutcome, setFilterOutcome] = useState<'ALL' | 'positivo' | 'negativo'>('ALL');
  const [checkedClipIds, setCheckedClipIds] = useState<string[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [playingQueue, setPlayingQueue] = useState<ClipEvent[] | null>(null);
  const [playingQueueIndex, setPlayingQueueIndex] = useState<number>(0);

  // Historial Undo / Redo general
  const [history, setHistory] = useState<HistorySnapshot[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);

  // Visibilidad de secciones
  const [hideVideosPanel, setHideVideosPanel] = useState<boolean>(false);
  const [hideEventsPanel, setHideEventsPanel] = useState<boolean>(false);
  const [hideExportPanel, setHideExportPanel] = useState<boolean>(false);
  const [hideDrawingPanel, setHideDrawingPanel] = useState<boolean>(false);
  const [showNumbersPlayersSection, setShowNumbersPlayersSection] = useState<boolean>(false);
  const [hideGeneralStyleSection, setHideGeneralStyleSection] = useState<boolean>(false);
  const [hideBottomControls, setHideBottomControls] = useState<boolean>(false);
  const [hideMarkerButtons, setHideMarkerButtons] = useState<boolean>(false);
  const [eventsSubTab, setEventsSubTab] = useState<'evento' | 'listas' | 'capturas'>('evento');

  // Exportación
  const [exportResolution, setExportResolution] = useState<'720p' | '1080p' | '480p'>('720p');
  const [exportFps, setExportFps] = useState<'30 fps' | '60 fps' | '25 fps'>('30 fps');
  const [exportFileName, setExportFileName] = useState<string>('');
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgressText, setExportProgressText] = useState<string>('');

  // =========================================================================
  // ESTADO AVANZADO DE PINTADO DE ACCIONES + KLIPDRAW
  // =========================================================================
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [drawingMode, setDrawingMode] = useState<boolean>(false);
  const [activeTool, setActiveTool] = useState<PintadoToolType>('flecha_curva');
  const [isMoveMode, setIsMoveMode] = useState<boolean>(false);
  const [selectedDrawingId, setSelectedDrawingId] = useState<string | null>(null);
  const [draggingDrawingOffset, setDraggingDrawingOffset] = useState<{ x: number; y: number } | null>(null);
  const [draggingPointIndex, setDraggingPointIndex] = useState<number>(-1);
  const [trackPlayersMode, setTrackPlayersMode] = useState<boolean>(true);
  const drawingsRef = useRef<DrawingAction[]>([]);

  const [strokeColor, setStrokeColor] = useState<string>('#d3291e');
  const [fillColor, setFillColor] = useState<string>('#141414');
  const [strokeWidth, setStrokeWidth] = useState<number>(4);
  const [lineStyle, setLineStyle] = useState<'solid' | 'dashed'>('solid');
  const [shapeScale, setShapeScale] = useState<number>(100);
  const [shapeOpacity, setShapeOpacity] = useState<number>(100);
  const [visibleDuration, setVisibleDuration] = useState<number>(8);
  const [insertFreezeSeconds, setInsertFreezeSeconds] = useState<number>(5);

  const [currentDraftAction, setCurrentDraftAction] = useState<DrawingAction | null>(null);
  const [multiPointDraft, setMultiPointDraft] = useState<DrawingAction | null>(null);
  const [activeFreezeOverlay, setActiveFreezeOverlay] = useState<{
    eventId: string;
    dataUrl: string;
    remaining: number;
    total: number;
    resumeAfter: boolean;
    manualHold?: boolean;
    advanceQueueAfter?: boolean;
  } | null>(null);
  const triggeredFreezeIdsRef = useRef<Set<string>>(new Set());

  // Plantilla de Números y Jugadores
  const [rosterPlayers, setRosterPlayers] = useState<RosterPlayerItem[]>(DEFAULT_ROSTER_PLAYERS);
  const [activeRosterPlayer, setActiveRosterPlayer] = useState<RosterPlayerItem>(DEFAULT_ROSTER_PLAYERS[8]);
  const [newPlayerDorsal, setNewPlayerDorsal] = useState<string>('');
  const [newPlayerName, setNewPlayerName] = useState<string>('');

  // Estado específico para "REGISTRO SIN VÍDEO" y Descriptores Nacsport (por defecto sin posición ni resultado marcado)
  const [liveTimerRunning, setLiveTimerRunning] = useState<boolean>(false);
  const [liveTimerSeconds, setLiveTimerSeconds] = useState<number>(0);
  const [liveHalf, setLiveHalf] = useState<'1ª Parte' | '2ª Parte'>('1ª Parte');
  const [selectedPitchZone, setSelectedPitchZone] = useState<string>('Zona Media Centro');
  const [selectedTeamFilter, setSelectedTeamFilter] = useState<'Séneca CF' | 'Rival'>('Séneca CF');
  const [selectedPlayerTag, setSelectedPlayerTag] = useState<string>('');
  const [activeDescriptors, setActiveDescriptors] = useState<string[]>([]);

  // =========================================================================
  // BOTONERA NACSPORT: PLANTILLAS, CONSTRUCTOR Y PANTALLA COMPLETA
  // =========================================================================
  const [botoneraTemplates, setBotoneraTemplates] = useState<BotoneraTemplate[]>(() => {
    try {
      const local = localStorage.getItem('seneca_botonera_templates');
      if (local) return JSON.parse(local);
    } catch {}
    return DEFAULT_BOTONERA_TEMPLATES;
  });
  const [activeTemplateId, setActiveTemplateId] = useState<string>('tpl-seneca-pro');
  const [customDescriptors, setCustomDescriptors] = useState<string[]>(() => {
    try {
      const local = localStorage.getItem('seneca_custom_descriptors');
      if (local) return JSON.parse(local);
    } catch {}
    return NACSPORT_DESCRIPTORS;
  });
  const [isBotoneraFullscreen, setIsBotoneraFullscreen] = useState<boolean>(false);
  const [botoneraFullscreenLayout, setBotoneraFullscreenLayout] = useState<'split_video' | 'board_only'>('split_video');
  const [showBotoneraBuilderModal, setShowBotoneraBuilderModal] = useState<boolean>(false);
  const [builderTab, setBuilderTab] = useState<'categorias' | 'descriptores' | 'diseno' | 'plantillas'>('categorias');
  const [directOneClickMode, setDirectOneClickMode] = useState<boolean>(true);
  const [botoneraColumns, setBotoneraColumns] = useState<number>(5);
  const [botoneraButtonSize, setBotoneraButtonSize] = useState<'sm' | 'md' | 'lg'>('md');
  const [showPitchInBotonera, setShowPitchInBotonera] = useState<boolean>(true);
  const [showPlayersInBotonera, setShowPlayersInBotonera] = useState<boolean>(true);
  const [showDescriptorsInBotonera, setShowDescriptorsInBotonera] = useState<boolean>(true);
  const [activeManualRecordings, setActiveManualRecordings] = useState<
    Record<
      string,
      {
        startTime: number;
        team: 'Séneca CF' | 'Rival';
        player?: string;
        zone?: string;
        descriptors: string[];
      }
    >
  >({});
  const [lastDirectTaggedClipId, setLastDirectTaggedClipId] = useState<string | null>(null);

  // Campos para crear nueva categoría en el constructor de botonera
  const [newCatName, setNewCatName] = useState<string>('');
  const [newCatColor, setNewCatColor] = useState<string>('#cc2016');
  const [newCatShortcut, setNewCatShortcut] = useState<string>('');
  const [newCatPreRoll, setNewCatPreRoll] = useState<number>(5);
  const [newCatPostRoll, setNewCatPostRoll] = useState<number>(5);
  const [newCatType, setNewCatType] = useState<'Ataque' | 'Defensa' | 'Transición' | 'ABP' | 'Resultado'>('Ataque');
  const [newCatMode, setNewCatMode] = useState<'auto' | 'manual'>('auto');
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);

  // Campo para nuevo descriptor
  const [newDescriptorInput, setNewDescriptorInput] = useState<string>('');

  // Campo para nueva plantilla
  const [newTemplateNameInput, setNewTemplateNameInput] = useState<string>('');
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);

  const handleDeleteClip = (clipId: string) => {
    const filtered = events.filter((item) => item.id !== clipId);
    setEvents(filtered);
    pushHistory({ events: filtered });
    if (selectedEventId === clipId) setSelectedEventId(null);
  };

  // Guardar plantillas y descriptores en LocalStorage
  useEffect(() => {
    try {
      localStorage.setItem('seneca_botonera_templates', JSON.stringify(botoneraTemplates));
    } catch {}
  }, [botoneraTemplates]);

  useEffect(() => {
    try {
      localStorage.setItem('seneca_custom_descriptors', JSON.stringify(customDescriptors));
    } catch {}
  }, [customDescriptors]);

  useEffect(() => {
    const img = new Image();
    img.src = '/seneca-shield.jpg';
    senecaLogoRef.current = img;
  }, []);

  const notify = useCallback((msg: string) => {
    setStatusMessage(msg);
    setTimeout(() => {
      setStatusMessage((prev) => (prev === msg ? '' : prev));
    }, 3500);
  }, []);

  const pushHistory = useCallback(
    (next: Partial<HistorySnapshot>) => {
      const snap: HistorySnapshot = {
        events: next.events !== undefined ? next.events : events,
        captures: next.captures !== undefined ? next.captures : captures,
        drawings: next.drawings !== undefined ? next.drawings : drawings,
        markers: next.markers !== undefined ? next.markers : markers,
      };
      setHistory((prev) => {
        const sliced = prev.slice(0, historyIndex + 1);
        return [...sliced.slice(-15), snap];
      });
      setHistoryIndex((prev) => Math.min(prev + 1, 15));
    },
    [events, captures, drawings, markers, historyIndex]
  );

  const handleUndo = () => {
    if (historyIndex > 0) {
      const target = history[historyIndex - 1];
      setEvents(target.events);
      setCaptures(target.captures);
      setDrawings(target.drawings);
      setMarkers(target.markers);
      setHistoryIndex(historyIndex - 1);
      notify('Acción deshecha');
    } else if (drawings.length > 0) {
      const nextD = drawings.slice(0, -1);
      setDrawings(nextD);
      notify('Último dibujo deshecho');
    }
  };

  const handleRedo = () => {
    if (historyIndex < history.length - 1) {
      const target = history[historyIndex + 1];
      setEvents(target.events);
      setCaptures(target.captures);
      setDrawings(target.drawings);
      setMarkers(target.markers);
      setHistoryIndex(historyIndex + 1);
      notify('Acción rehecha');
    }
  };

  // Cargar desde LocalStorage y sincronizar con Supabase al iniciar
  useEffect(() => {
    try {
      const localRaw = localStorage.getItem('seneca_cf_current_project');
      if (localRaw) {
        const parsed: SenecaProject = JSON.parse(localRaw);
        setProjectId(parsed.id || 'seneca-default-project');
        setProjectName(parsed.name || 'Jornada 1 - Séneca CF vs Rival');
        setRivalName(parsed.rival || 'Rival FC');
        setCompetition(parsed.competition || 'División de Honor');
        setEvents(sanitizeLoadedEvents(parsed.events));
        setCaptures(Array.isArray(parsed.captures) ? parsed.captures : []);
        setDrawings(Array.isArray(parsed.drawings) ? parsed.drawings : []);
        setMarkers(parsed.markers || {});
        if (parsed.tag_categories && parsed.tag_categories.length > 0) {
          setTagCategories(parsed.tag_categories);
        }
        if (parsed.playlists && parsed.playlists.length > 0) {
          setPlaylists(parsed.playlists);
        }
      }
    } catch (e) {
      console.warn('Error cargando estado local:', e);
    }

    fetchProjectsFromSupabase();

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  }, []);

  const fetchProjectsFromSupabase = async () => {
    setSupabaseStatus('syncing');
    try {
      const { data, error } = await supabase
        .from('seneca_projects')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(20);

      if (error) {
        setSupabaseStatus('local_only');
      } else {
        setSupabaseStatus('synced');
        if (data && data.length > 0) {
          setSavedProjects(data as SenecaProject[]);
          const localRaw = localStorage.getItem('seneca_cf_current_project');
          if (!localRaw) {
            const latest = data[0] as SenecaProject;
            setProjectId(latest.id);
            setProjectName(latest.name);
            setRivalName(latest.rival || 'Rival FC');
            setCompetition(latest.competition || 'División de Honor');
            setEvents(sanitizeLoadedEvents(latest.events));
            setCaptures(latest.captures || []);
            setDrawings(latest.drawings || []);
            setMarkers(latest.markers || {});
            if (latest.tag_categories?.length) setTagCategories(latest.tag_categories);
            if (latest.playlists?.length) setPlaylists(latest.playlists);
          }
        }
      }
    } catch {
      setSupabaseStatus('local_only');
    }
  };

  // Auto-guardado seguro en LocalStorage + Supabase (protegido contra QuotaExceededError)
  useEffect(() => {
    const projectPayload: SenecaProject = {
      id: projectId,
      name: projectName,
      rival: rivalName,
      competition,
      match_date: new Date().toISOString().split('T')[0],
      active_module: activeTab,
      events,
      captures,
      drawings,
      markers,
      tag_categories: tagCategories,
      playlists,
      updated_at: new Date().toISOString(),
    };

    try {
      localStorage.setItem('seneca_cf_current_project', JSON.stringify(projectPayload));
    } catch {
      try {
        const lightPayload: SenecaProject = {
          ...projectPayload,
          events: events.map(({ drawingDataUrl, ...rest }) => rest),
          captures: captures.slice(0, 6),
        };
        localStorage.setItem('seneca_cf_current_project', JSON.stringify(lightPayload));
      } catch {
        try {
          const minimalPayload: SenecaProject = {
            ...projectPayload,
            events: events.map(({ drawingDataUrl, ...rest }) => rest),
            captures: [],
          };
          localStorage.setItem('seneca_cf_current_project', JSON.stringify(minimalPayload));
        } catch (err) {
          console.warn('No se pudo guardar en localStorage por límite de cuota:', err);
        }
      }
    }

    const timer = setTimeout(async () => {
      try {
        const { error } = await supabase.from('seneca_projects').upsert(projectPayload, { onConflict: 'id' });
        if (!error) {
          setSupabaseStatus('synced');
        } else {
          setSupabaseStatus('local_only');
        }
      } catch {
        setSupabaseStatus('local_only');
      }
    }, 1200);

    return () => clearTimeout(timer);
  }, [
    projectId,
    projectName,
    rivalName,
    competition,
    activeTab,
    events,
    captures,
    drawings,
    markers,
    tagCategories,
    playlists,
  ]);

  const activateClipPlayback = useCallback(
    (clip: ClipEvent, options?: { fromQueue?: boolean; holdManual?: boolean }) => {
      setSelectedEventId(clip.id);
      const targetT = clip.freezeTimestamp ?? clip.startTime;

      if (activeTab === 'sin_video') {
        setLiveTimerSeconds(targetT);
        return;
      }

      // Si es una Imagen Parada insertada, paramos el vídeo por completo y mostramos la imagen fija
      if (clip.isFreezeInsert && clip.drawingDataUrl && clip.notes === 'IMAGEN_PARADA') {
        setCurrentTime(targetT);
        if (videoRef.current && activeVideo) {
          videoRef.current.pause();
          videoRef.current.currentTime = targetT;
          setIsPlaying(false);
        }
        const dur = clip.freezeDuration !== undefined ? clip.freezeDuration : 5;
        triggeredFreezeIdsRef.current.add(clip.id);
        setActiveFreezeOverlay({
          eventId: clip.id,
          dataUrl: clip.drawingDataUrl,
          remaining: dur > 0 ? dur : 5,
          total: dur > 0 ? dur : 5,
          resumeAfter: !options?.fromQueue && !options?.holdManual,
          manualHold: options?.holdManual || dur === 0,
          advanceQueueAfter: Boolean(options?.fromQueue),
        });
        return;
      }

      setActiveFreezeOverlay(null);
      setCurrentTime(clip.startTime);
      if (videoRef.current && activeVideo) {
        videoRef.current.currentTime = clip.startTime;
        videoRef.current.play().catch(() => {});
        setIsPlaying(true);
      }
    },
    [activeTab, activeVideo]
  );

  // Temporizador de pausa táctica cuando se reproduce o previsualiza un dibujo insertado en el vídeo
  useEffect(() => {
    if (!activeFreezeOverlay) return;

    // Asegurar que mientras está la imagen parada activa el vídeo NO siga corriendo por debajo
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
      setIsPlaying(false);
    }

    if (activeFreezeOverlay.manualHold) {
      return;
    }

    const interval = setInterval(() => {
      if (videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
        setIsPlaying(false);
      }
      setActiveFreezeOverlay((prev) => {
        if (!prev) return null;
        if (prev.manualHold) return prev;
        if (prev.remaining <= 0.15) {
          if (prev.advanceQueueAfter && playingQueue && playingQueue.length > 0) {
            if (playingQueueIndex + 1 < playingQueue.length) {
              const nextIdx = playingQueueIndex + 1;
              const nextClip = playingQueue[nextIdx];
              setPlayingQueueIndex(nextIdx);
              setTimeout(() => activateClipPlayback(nextClip, { fromQueue: true }), 0);
            } else {
              if (videoRef.current) videoRef.current.pause();
              setIsPlaying(false);
              setPlayingQueue(null);
              notify('Reproducción del grupo finalizada');
            }
          } else if (prev.resumeAfter && videoRef.current && activeVideo) {
            videoRef.current.currentTime = Math.min(
              duration || 99999,
              videoRef.current.currentTime + 0.2
            );
            videoRef.current.play().catch(() => {});
            setIsPlaying(true);
          }
          return null;
        }
        return { ...prev, remaining: Number((prev.remaining - 0.1).toFixed(1)) };
      });
    }, 100);
    return () => clearInterval(interval);
  }, [activeFreezeOverlay, activeVideo, duration, playingQueue, playingQueueIndex, activateClipPlayback, notify]);

  // Cronómetro en vivo para Registro Sin Vídeo
  useEffect(() => {
    if (!liveTimerRunning) return;
    const interval = setInterval(() => {
      setLiveTimerSeconds((prev) => prev + 0.1);
    }, 100);
    return () => clearInterval(interval);
  }, [liveTimerRunning]);

  // Duración máxima de referencia para la línea del tiempo
  const maxTimelineDuration = useMemo(() => {
    const highestEvEnd = events.reduce((m, ev) => Math.max(m, ev.endTime), 0);
    const highestMarker = Math.max(
      markers.firstHalfStart || 0,
      markers.firstHalfEnd || 0,
      markers.secondHalfStart || 0,
      markers.matchEnd || 0
    );
    const base = activeTab === 'sin_video' ? Math.max(90, liveTimerSeconds + 15) : duration > 0 ? duration : 90;
    return Math.max(base, highestEvEnd + 5, highestMarker + 5);
  }, [duration, events, markers, activeTab, liveTimerSeconds]);

  // Arrastre interactivo de tiradores en la línea de tiempo
  useEffect(() => {
    if (!draggingHandle) return;

    const handleGlobalMouseMove = (e: MouseEvent) => {
      if (!timelineRef.current) return;
      const rect = timelineRef.current.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const targetTime = Number((ratio * maxTimelineDuration).toFixed(1));

      if (draggingHandle.type === 'playhead') {
        setCurrentTime(targetTime);
        if (videoRef.current && activeVideo) {
          videoRef.current.currentTime = targetTime;
        }
      } else if (draggingHandle.type === 'pointA') {
        setPointA(targetTime);
      } else if (draggingHandle.type === 'pointB') {
        setPointB(targetTime);
      } else if (draggingHandle.type === 'marker') {
        setMarkers((prev) => ({ ...prev, [draggingHandle.key]: targetTime }));
      } else if (draggingHandle.type === 'eventStart') {
        setEvents((prev) =>
          prev.map((ev) =>
            ev.id === draggingHandle.eventId
              ? { ...ev, startTime: Math.min(targetTime, ev.endTime - 0.5) }
              : ev
          )
        );
      } else if (draggingHandle.type === 'eventEnd') {
        setEvents((prev) =>
          prev.map((ev) =>
            ev.id === draggingHandle.eventId
              ? { ...ev, endTime: Math.max(targetTime, ev.startTime + 0.5) }
              : ev
          )
        );
      }
    };

    const handleGlobalMouseUp = () => {
      setDraggingHandle(null);
    };

    window.addEventListener('mousemove', handleGlobalMouseMove);
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleGlobalMouseMove);
      window.removeEventListener('mouseup', handleGlobalMouseUp);
    };
  }, [draggingHandle, maxTimelineDuration, activeVideo]);

  // Reproducción continua de una cola de cortes agrupados o de una Lista de Presentación (estilo Nacsport)
  const startPlayingClipQueue = (clips: ClipEvent[]) => {
    if (clips.length === 0) {
      notify('No hay cortes en este grupo para reproducir');
      return;
    }
    setPlayingQueue(clips);
    setPlayingQueueIndex(0);
    const first = clips[0];
    activateClipPlayback(first, { fromQueue: true });
    notify(`Reproduciendo grupo: ${clips.length} corte(s) seguidos`);
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current) return;
    const t = videoRef.current.currentTime;
    setCurrentTime(t);
    refreshVideoCropBounds(videoRef.current);

    // Pausa táctica automática cuando el vídeo pasa por una Imagen Parada insertada (el vídeo se detiene por completo)
    if (!videoRef.current.paused && !activeFreezeOverlay) {
      for (const ev of events) {
        if (ev.isFreezeInsert && ev.drawingDataUrl) {
          const ft = ev.freezeTimestamp ?? ev.startTime;
          if (Math.abs(t - ft) > 0.9) {
            triggeredFreezeIdsRef.current.delete(ev.id);
          } else if (Math.abs(t - ft) <= 0.28 && !triggeredFreezeIdsRef.current.has(ev.id)) {
            triggeredFreezeIdsRef.current.add(ev.id);
            videoRef.current.pause();
            videoRef.current.currentTime = ft;
            setIsPlaying(false);
            const dur = ev.freezeDuration !== undefined ? ev.freezeDuration : 5;
            setActiveFreezeOverlay({
              eventId: ev.id,
              dataUrl: ev.drawingDataUrl,
              remaining: dur > 0 ? dur : 5,
              total: dur > 0 ? dur : 5,
              resumeAfter: true,
              manualHold: dur === 0,
            });
            return;
          }
        }
      }
    }

    // Si estamos reproduciendo una cola de cortes agrupados o lista de presentación
    if (playingQueue && playingQueue.length > 0) {
      const currentClip = playingQueue[playingQueueIndex];
      if (currentClip && t >= currentClip.endTime) {
        if (playingQueueIndex + 1 < playingQueue.length) {
          const nextIdx = playingQueueIndex + 1;
          const nextClip = playingQueue[nextIdx];
          setPlayingQueueIndex(nextIdx);
          activateClipPlayback(nextClip, { fromQueue: true });
        } else {
          videoRef.current.pause();
          setIsPlaying(false);
          setPlayingQueue(null);
          notify('Reproducción del grupo finalizada');
        }
        return;
      }
    }

    if (abLoopActive && pointA !== null && pointB !== null && pointB > pointA) {
      if (t >= pointB) {
        videoRef.current.currentTime = pointA;
        videoRef.current.play();
      }
    }
  };

  useEffect(() => {
    drawingsRef.current = drawings;
  }, [drawings]);

  // Bucle a 60fps para seguimiento automático en vivo de jugadores (Conector, Foco, Radar, etc.) cuando el vídeo corre
  useEffect(() => {
    if (!isPlaying || activeFreezeOverlay) return;
    let rafId = 0;
    let lastStateSync = performance.now();

    const tick = () => {
      const videoEl = videoRef.current;
      const canvas = overlayCanvasRef.current;
      if (videoEl && !videoEl.paused && canvas) {
        const t = videoEl.currentTime;
        const { hasNewKeyframes, updatedActions } = stepLivePlayerTracking(
          videoEl,
          drawingsRef.current,
          t
        );
        if (hasNewKeyframes) {
          drawingsRef.current = updatedActions;
          if (performance.now() - lastStateSync > 450) {
            lastStateSync = performance.now();
            setDrawings(updatedActions);
          }
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          renderDrawingActions(ctx, drawingsRef.current, {
            currentTime: t,
            selectedId: selectedDrawingId,
            ignoreTimeVisibility: false,
            videoElement: videoEl,
            senecaLogoImg: senecaLogoRef.current,
          });
        }
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
      setDrawings([...drawingsRef.current]);
    };
  }, [isPlaying, activeFreezeOverlay, selectedDrawingId]);

  // Renderizado continuo del canvas de Pintado de Acciones
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const allToRender: DrawingAction[] = [...drawings];
    if (currentDraftAction) allToRender.push(currentDraftAction);
    if (multiPointDraft) allToRender.push(multiPointDraft);

    renderDrawingActions(ctx, allToRender, {
      currentTime: videoRef.current && isPlaying ? videoRef.current.currentTime : currentTime,
      selectedId: selectedDrawingId,
      ignoreTimeVisibility: drawingMode && !isPlaying,
      videoElement: videoRef.current,
      senecaLogoImg: senecaLogoRef.current,
    });
  }, [drawings, currentDraftAction, multiPointDraft, currentTime, selectedDrawingId, drawingMode, isPlaying]);

  const selectedDrawingObj = drawings.find((d) => d.id === selectedDrawingId) || null;

  const updateSelectedDrawingStyle = (patch: Partial<DrawingAction>) => {
    if (!selectedDrawingId) return;
    const updated = drawings.map((d) => (d.id === selectedDrawingId ? { ...d, ...patch } : d));
    setDrawings(updated);
    pushHistory({ drawings: updated });
  };

  const handleDeleteSelectedDrawing = () => {
    if (!selectedDrawingId) {
      if (drawings.length > 0) {
        const removed = drawings[drawings.length - 1];
        resetTrackerState(removed.id);
        const next = drawings.slice(0, -1);
        setDrawings(next);
        pushHistory({ drawings: next });
        notify('Último elemento eliminado');
      }
      return;
    }
    resetTrackerState(selectedDrawingId);
    const next = drawings.filter((d) => d.id !== selectedDrawingId);
    setDrawings(next);
    setSelectedDrawingId(null);
    pushHistory({ drawings: next });
    notify('Elemento eliminado');
  };

  const handleEditSelectedDrawing = () => {
    const target = selectedDrawingObj || drawings[drawings.length - 1];
    if (!target) {
      notify('Selecciona primero un dibujo o texto sobre el vídeo');
      return;
    }
    const newTxt = window.prompt(
      'Editar texto o etiqueta del elemento seleccionado:',
      target.text || target.dorsal || 'SÉNECA CF'
    );
    if (newTxt !== null) {
      const updated = drawings.map((d) => (d.id === target.id ? { ...d, text: newTxt } : d));
      setDrawings(updated);
      pushHistory({ drawings: updated });
      notify('Elemento actualizado');
    }
  };

  const handleDuplicateSelectedDrawing = () => {
    const target = selectedDrawingObj || drawings[drawings.length - 1];
    if (!target) {
      notify('No hay ningún elemento para duplicar');
      return;
    }
    const shiftedPts = target.points.map((p) => ({ x: p.x + 28, y: p.y + 28 }));
    const copy: DrawingAction = {
      ...target,
      id: `draw-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      points: shiftedPts,
      keyframes: [
        {
          time: Math.round(currentTime * 100) / 100,
          points: shiftedPts,
          manual: true,
        },
      ],
    };
    captureDrawingTemplates(videoRef.current, copy, currentTime);
    const next = [...drawings, copy];
    setDrawings(next);
    setSelectedDrawingId(copy.id);
    pushHistory({ drawings: next });
    notify('Elemento duplicado');
  };

  const handleRotateSelectedDrawing = () => {
    const target = selectedDrawingObj || drawings[drawings.length - 1];
    if (!target) {
      notify('Selecciona un elemento para rotar');
      return;
    }
    const nextRot = ((target.rotation || 0) + 30) % 360;
    const updated = drawings.map((d) => (d.id === target.id ? { ...d, rotation: nextRot } : d));
    setDrawings(updated);
    setSelectedDrawingId(target.id);
    pushHistory({ drawings: updated });
    notify(`Rotado a ${nextRot}°`);
  };

  const handleBringToFront = () => {
    if (!selectedDrawingId) return;
    const target = drawings.find((d) => d.id === selectedDrawingId);
    if (!target) return;
    const others = drawings.filter((d) => d.id !== selectedDrawingId);
    const next = [...others, target];
    setDrawings(next);
    pushHistory({ drawings: next });
    notify('Traído al frente');
  };

  const handleSendToBack = () => {
    if (!selectedDrawingId) return;
    const target = drawings.find((d) => d.id === selectedDrawingId);
    if (!target) return;
    const others = drawings.filter((d) => d.id !== selectedDrawingId);
    const next = [target, ...others];
    setDrawings(next);
    pushHistory({ drawings: next });
    notify('Enviado al fondo');
  };

  const getCanvasCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = overlayCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  };

  const selectToolAndActivate = (tool: PintadoToolType) => {
    setMultiPointDraft(null);
    setIsMoveMode(false);
    setActiveTool(tool);
    setDrawingMode(true);
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawingMode) return;
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
      setIsPlaying(false);
    }
    const pt = getCanvasCoords(e);

    if (isMoveMode) {
      const hit = [...drawings].reverse().find((d) => hitTestDrawing(d, pt, currentTime));
      if (hit) {
        const ptIdx = hitTestDrawingPointIndex(hit, pt, currentTime);
        setSelectedDrawingId(hit.id);
        setDraggingDrawingOffset(pt);
        setDraggingPointIndex(ptIdx);
        setStrokeColor(hit.color);
        setFillColor(hit.fillColor);
        setStrokeWidth(hit.lineWidth);
        setLineStyle(hit.lineStyle);
        setShapeScale(hit.scale);
        setShapeOpacity(hit.opacity);
        setVisibleDuration(hit.visibleDuration);
      } else {
        setSelectedDrawingId(null);
        setDraggingPointIndex(-1);
      }
      return;
    }

    // Permitir arrastrar directamente cualquiera de los nodos amarillos de jugador del elemento seleccionado en cualquier segundo del vídeo
    if (!multiPointDraft && selectedDrawingObj) {
      const directPtIdx = hitTestDrawingPointIndex(selectedDrawingObj, pt, currentTime);
      if (directPtIdx !== -1) {
        setDraggingDrawingOffset(pt);
        setDraggingPointIndex(directPtIdx);
        return;
      }
    }

    if (activeTool === 'texto' || activeTool === 'etiqueta') {
      const defaultVal = activeTool === 'etiqueta' ? 'PRESIÓN ALTA' : 'BASCULACIÓN SÉNECA CF';
      const userText = window.prompt(
        activeTool === 'etiqueta' ? 'Texto de la etiqueta:' : 'Introduce el texto táctico:',
        defaultVal
      );
      if (userText && userText.trim()) {
        const newAct: DrawingAction = {
          id: `draw-${Date.now()}`,
          tool: activeTool,
          color: strokeColor,
          fillColor,
          lineWidth: strokeWidth,
          lineStyle,
          scale: shapeScale,
          opacity: shapeOpacity,
          visibleDuration,
          rotation: 0,
          points: [pt],
          text: userText.trim(),
          timestamp: currentTime,
          trackPlayers: trackPlayersMode,
          keyframes: [
            {
              time: Math.round(currentTime * 100) / 100,
              points: [pt],
              manual: true,
            },
          ],
        };
        captureDrawingTemplates(videoRef.current, newAct, currentTime);
        const nextD = [...drawings, newAct];
        setDrawings(nextD);
        setSelectedDrawingId(newAct.id);
        pushHistory({ drawings: nextD });
      }
      return;
    }

    if (activeTool === 'jugador_ficha' || activeTool === 'escudo_seneca' || activeTool === 'balon') {
      const newAct: DrawingAction = {
        id: `draw-${Date.now()}`,
        tool: activeTool,
        color: strokeColor,
        fillColor,
        lineWidth: strokeWidth,
        lineStyle,
        scale: shapeScale,
        opacity: shapeOpacity,
        visibleDuration,
        rotation: 0,
        points: [pt],
        dorsal: activeRosterPlayer?.dorsal || '9',
        text: activeRosterPlayer?.name || '',
        timestamp: currentTime,
        trackPlayers: trackPlayersMode,
        keyframes: [
          {
            time: Math.round(currentTime * 100) / 100,
            points: [pt],
            manual: true,
          },
        ],
      };
      captureDrawingTemplates(videoRef.current, newAct, currentTime);
      const nextD = [...drawings, newAct];
      setDrawings(nextD);
      setSelectedDrawingId(newAct.id);
      pushHistory({ drawings: nextD });
      return;
    }

    if (activeTool === 'zona_libre' || activeTool === 'conector') {
      if (!multiPointDraft) {
        const draft: DrawingAction = {
          id: `draw-${Date.now()}`,
          tool: activeTool,
          color: strokeColor,
          fillColor,
          lineWidth: strokeWidth,
          lineStyle,
          scale: shapeScale,
          opacity: shapeOpacity,
          visibleDuration,
          rotation: 0,
          points: [pt, pt],
          timestamp: currentTime,
          trackPlayers: trackPlayersMode,
        };
        setMultiPointDraft(draft);
      } else {
        setMultiPointDraft({
          ...multiPointDraft,
          points: [...multiPointDraft.points, pt],
        });
      }
      return;
    }

    const initialPoints =
      activeTool === 'triangulo' ? [pt, { x: pt.x - 40, y: pt.y + 50 }, pt] : [pt, pt];

    setCurrentDraftAction({
      id: `draw-${Date.now()}`,
      tool: activeTool,
      color: strokeColor,
      fillColor,
      lineWidth: strokeWidth,
      lineStyle,
      scale: shapeScale,
      opacity: shapeOpacity,
      visibleDuration,
      rotation: 0,
      points: initialPoints,
      timestamp: currentTime,
      trackPlayers: trackPlayersMode,
    });
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drawingMode) return;
    const pt = getCanvasCoords(e);

    if ((isMoveMode || draggingPointIndex !== -1) && selectedDrawingId && draggingDrawingOffset) {
      const dx = pt.x - draggingDrawingOffset.x;
      const dy = pt.y - draggingDrawingOffset.y;
      setDrawings((prev) =>
        prev.map((d) => {
          if (d.id !== selectedDrawingId) return d;
          const currentPts = getInterpolatedPointsAtTime(d, currentTime);
          let nextPts: { x: number; y: number }[];

          if (
            draggingPointIndex >= 0 &&
            draggingPointIndex < currentPts.length &&
            !(isRigidRadiusTool(d.tool) && draggingPointIndex === 0)
          ) {
            // Mover únicamente el jugador/nodo individual seleccionado (ej. un jugador del Conector o vértice de Triángulo)
            nextPts = currentPts.map((p, idx) =>
              idx === draggingPointIndex ? { x: p.x + dx, y: p.y + dy } : p
            );
          } else {
            // Mover todo el elemento (o el jugador central + su radio en Foco / Radar)
            nextPts = currentPts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
          }

          return upsertManualKeyframe(d, currentTime, nextPts, videoRef.current);
        })
      );
      setDraggingDrawingOffset(pt);
      return;
    }

    if (multiPointDraft) {
      const pts = [...multiPointDraft.points];
      pts[pts.length - 1] = pt;
      setMultiPointDraft({ ...multiPointDraft, points: pts });
      return;
    }

    if (!currentDraftAction) return;

    if (currentDraftAction.tool === 'flecha_libre' || currentDraftAction.tool === 'klip_tracking') {
      setCurrentDraftAction({
        ...currentDraftAction,
        points: [...currentDraftAction.points, pt],
      });
    } else if (currentDraftAction.tool === 'triangulo') {
      const start = currentDraftAction.points[0];
      const third = { x: start.x - (pt.x - start.x), y: pt.y };
      setCurrentDraftAction({
        ...currentDraftAction,
        points: [start, third, pt],
      });
    } else {
      setCurrentDraftAction({
        ...currentDraftAction,
        points: [currentDraftAction.points[0], pt],
      });
    }
  };

  const handleCanvasMouseUp = () => {
    if ((isMoveMode || draggingPointIndex !== -1) && draggingDrawingOffset) {
      setDraggingDrawingOffset(null);
      setDraggingPointIndex(-1);
      pushHistory({ drawings });
      return;
    }
    if (!drawingMode || !currentDraftAction) return;
    const finalized: DrawingAction = {
      ...currentDraftAction,
      trackPlayers: trackPlayersMode,
      keyframes: [
        {
          time: Math.round(currentTime * 100) / 100,
          points: currentDraftAction.points.map((p) => ({
            x: Math.round(p.x * 10) / 10,
            y: Math.round(p.y * 10) / 10,
          })),
          manual: true,
        },
      ],
    };
    captureDrawingTemplates(videoRef.current, finalized, currentTime);
    const nextD = [...drawings, finalized];
    setDrawings(nextD);
    setSelectedDrawingId(finalized.id);
    pushHistory({ drawings: nextD });
    setCurrentDraftAction(null);
  };

  const handleCanvasDoubleClick = () => {
    if (multiPointDraft) {
      const cleanedPoints =
        multiPointDraft.points.length > 2 ? multiPointDraft.points.slice(0, -1) : multiPointDraft.points;
      const finalAction: DrawingAction = {
        ...multiPointDraft,
        points: cleanedPoints,
        closed: true,
        trackPlayers: trackPlayersMode,
        keyframes: [
          {
            time: Math.round(currentTime * 100) / 100,
            points: cleanedPoints.map((p) => ({
              x: Math.round(p.x * 10) / 10,
              y: Math.round(p.y * 10) / 10,
            })),
            manual: true,
          },
        ],
      };
      captureDrawingTemplates(videoRef.current, finalAction, currentTime);
      const nextD = [...drawings, finalAction];
      setDrawings(nextD);
      setSelectedDrawingId(finalAction.id);
      pushHistory({ drawings: nextD });
      setMultiPointDraft(null);
      notify(
        `${
          multiPointDraft.tool === 'conector' ? 'Conector táctico' : 'Zona libre'
        } completado con seguimiento de jugadores`
      );
    }
  };

  const drawPitchFallback = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    ctx.fillStyle = '#1b5e20';
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = 3;
    ctx.strokeRect(50, 40, width - 100, height - 80);
    ctx.beginPath();
    ctx.moveTo(width / 2, 40);
    ctx.lineTo(width / 2, height - 40);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, 70, 0, Math.PI * 2);
    ctx.stroke();
  };

  const buildCompositeCanvasDataUrl = (
    format: 'png' | 'jpeg' = 'jpeg',
    customDrawings?: DrawingAction[]
  ): string | null => {
    try {
      const outCanvas = document.createElement('canvas');
      outCanvas.width = 1280;
      outCanvas.height = 720;
      const ctx = outCanvas.getContext('2d');
      if (!ctx) return null;

      const safeTime = Number.isFinite(currentTime) ? currentTime : 0;
      const listToDraw = customDrawings ?? drawings;

      let drewVideo = false;
      if (videoRef.current && activeVideo && videoRef.current.readyState >= 2) {
        try {
          drawVideoFrameCropped(ctx, videoRef.current, outCanvas.width, outCanvas.height);
          drewVideo = true;
        } catch {
          drewVideo = false;
        }
      }
      if (!drewVideo) {
        drawPitchFallback(ctx, outCanvas.width, outCanvas.height);
      }

      renderDrawingActions(ctx, listToDraw, {
        currentTime: safeTime,
        selectedId: null,
        ignoreTimeVisibility: true,
        videoElement: videoRef.current,
        senecaLogoImg: senecaLogoRef.current,
      });

      ctx.fillStyle = 'rgba(20, 20, 20, 0.88)';
      ctx.fillRect(24, 658, 330, 42);
      ctx.fillStyle = '#cc2016';
      ctx.fillRect(24, 658, 7, 42);
      ctx.fillStyle = '#f5b800';
      ctx.font = 'bold 16px "Barlow Condensed", sans-serif';
      ctx.fillText(`ANÁLISIS SÉNECA CF | ${formatTimecode(safeTime)}`, 42, 684);

      try {
        return format === 'png'
          ? outCanvas.toDataURL('image/png')
          : outCanvas.toDataURL('image/jpeg', 0.84);
      } catch {
        // Fallback si el vídeo o imagen externa bloquea el canvas por CORS
        const cleanCanvas = document.createElement('canvas');
        cleanCanvas.width = 1280;
        cleanCanvas.height = 720;
        const cleanCtx = cleanCanvas.getContext('2d');
        if (!cleanCtx) return null;
        drawPitchFallback(cleanCtx, 1280, 720);
        renderDrawingActions(cleanCtx, listToDraw, {
          currentTime: safeTime,
          selectedId: null,
          ignoreTimeVisibility: true,
          videoElement: null,
          senecaLogoImg: null,
        });
        cleanCtx.fillStyle = 'rgba(20, 20, 20, 0.88)';
        cleanCtx.fillRect(24, 658, 330, 42);
        cleanCtx.fillStyle = '#cc2016';
        cleanCtx.fillRect(24, 658, 7, 42);
        cleanCtx.fillStyle = '#f5b800';
        cleanCtx.font = 'bold 16px "Barlow Condensed", sans-serif';
        cleanCtx.fillText(`ANÁLISIS SÉNECA CF | ${formatTimecode(safeTime)}`, 42, 684);
        return cleanCanvas.toDataURL('image/jpeg', 0.84);
      }
    } catch (err) {
      console.error('Error generando imagen compuesta del pintado:', err);
      return null;
    }
  };

  const handleExportPNG = () => {
    const dataUrl = buildCompositeCanvasDataUrl('png');
    if (!dataUrl) {
      notify('No se pudo generar la imagen PNG');
      return;
    }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `Pintado_Seneca_CF_${formatTimecode(currentTime).replace(/[:.]/g, '-')}.png`;
    a.click();
    notify('Imagen PNG con el pintado de acciones descargada');
  };

  const handleInsertPaintedFrameInVideo = (
    mode: 'imagen_parada' | 'video_corriendo' = 'imagen_parada'
  ) => {
    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
      setIsPlaying(false);
    }

    const safeTime = Number.isFinite(currentTime) ? Number(currentTime.toFixed(1)) : 0;
    const rawFreeze = Number(insertFreezeSeconds);
    const isManualHold = rawFreeze === 0;
    const freezeSecs = isManualHold ? 5 : Math.max(1, rawFreeze || 5);
    const runningSecs = visibleDuration > 0 ? visibleDuration : 8;
    const clipDurationSecs = mode === 'imagen_parada' ? freezeSecs : runningSecs;
    const labelDuration = isManualHold ? 'Pausa fija' : `${freezeSecs} s`;

    // Si había un polígono/conector en curso al pulsar Insertar, lo cerramos e incluimos con seguimiento de jugadores
    let updatedDrawings = [...drawings];
    if (multiPointDraft && multiPointDraft.points.length >= 2) {
      const cleanedPts =
        multiPointDraft.points.length > 2
          ? multiPointDraft.points.slice(0, -1)
          : multiPointDraft.points;
      const closedDraft: DrawingAction = {
        ...multiPointDraft,
        points: cleanedPts,
        closed: true,
        timestamp: safeTime,
        trackPlayers: trackPlayersMode,
        keyframes: [
          {
            time: safeTime,
            points: cleanedPts.map((p) => ({
              x: Math.round(p.x * 10) / 10,
              y: Math.round(p.y * 10) / 10,
            })),
            manual: true,
          },
        ],
      };
      captureDrawingTemplates(videoRef.current, closedDraft, safeTime);
      updatedDrawings.push(closedDraft);
      setMultiPointDraft(null);
    }
    if (currentDraftAction && currentDraftAction.points.length >= 2) {
      const closedCurrent: DrawingAction = {
        ...currentDraftAction,
        timestamp: safeTime,
        trackPlayers: trackPlayersMode,
        keyframes: [
          {
            time: safeTime,
            points: currentDraftAction.points.map((p) => ({
              x: Math.round(p.x * 10) / 10,
              y: Math.round(p.y * 10) / 10,
            })),
            manual: true,
          },
        ],
      };
      captureDrawingTemplates(videoRef.current, closedCurrent, safeTime);
      updatedDrawings.push(closedCurrent);
      setCurrentDraftAction(null);
    }

    let earliestStart = safeTime;

    // Anclar los dibujos visibles y activar su plantilla de seguimiento de jugadores
    updatedDrawings = updatedDrawings.map((d) => {
      const isCurrentlyShown =
        drawingMode ||
        d.visibleDuration === 0 ||
        Math.abs(safeTime - d.timestamp) <= Math.max(d.visibleDuration, clipDurationSecs);
      if (isCurrentlyShown) {
        const hasMultipleKeyframes = d.keyframes && d.keyframes.length > 1;
        const anchorTime = hasMultipleKeyframes ? d.timestamp : safeTime;
        if (anchorTime < earliestStart) earliestStart = anchorTime;

        const nextD: DrawingAction = {
          ...d,
          timestamp: anchorTime,
          visibleDuration: Math.max(d.visibleDuration || clipDurationSecs, clipDurationSecs),
          trackPlayers: d.trackPlayers ?? trackPlayersMode,
          keyframes:
            hasMultipleKeyframes && d.keyframes
              ? d.keyframes
              : [
                  {
                    time: anchorTime,
                    points: d.points.map((p) => ({
                      x: Math.round(p.x * 10) / 10,
                      y: Math.round(p.y * 10) / 10,
                    })),
                    manual: true,
                  },
                ],
        };
        if (!hasMultipleKeyframes) {
          captureDrawingTemplates(videoRef.current, nextD, safeTime);
        }
        return nextD;
      }
      return d;
    });

    drawingsRef.current = updatedDrawings;
    setDrawings(updatedDrawings);
    setSelectedDrawingId(null);

    const dataUrl = buildCompositeCanvasDataUrl('jpeg', updatedDrawings);
    if (!dataUrl) {
      notify('No se pudo insertar el pintado en el vídeo');
      return;
    }

    const newCap: CaptureItem = {
      id: `cap-${Date.now()}`,
      name:
        mode === 'imagen_parada'
          ? `Imagen Parada (${labelDuration}) @ ${formatTimecode(safeTime)}`
          : `Pintado en Movimiento (${runningSecs}s) @ ${formatTimecode(earliestStart)}`,
      timestamp: earliestStart,
      dataUrl,
      freezeDuration: mode === 'imagen_parada' ? (isManualHold ? 0 : freezeSecs) : 0,
      createdAt: new Date().toISOString(),
    };
    const nextCaps = [newCap, ...captures];
    setCaptures(nextCaps);

    let detectedHalf: '1ª Parte' | '2ª Parte' = liveHalf;
    if (markers.secondHalfStart !== undefined && safeTime >= markers.secondHalfStart) {
      detectedHalf = '2ª Parte';
    } else if (markers.firstHalfStart !== undefined && safeTime >= markers.firstHalfStart) {
      detectedHalf = '1ª Parte';
    }

    const isStill = mode === 'imagen_parada';

    const newEvent: ClipEvent = {
      id: `ev-pint-${Date.now()}`,
      name: isStill
        ? `Imagen Parada (${labelDuration})`
        : `Pintado con Seguimiento (${runningSecs} s)`,
      category: 'Pizarra Táctica',
      color: strokeColor || '#cc2016',
      startTime: isStill ? safeTime : earliestStart,
      endTime: Number((earliestStart + clipDurationSecs).toFixed(1)),
      videoId: activeVideo?.id || 'sin-video',
      videoName: activeVideo?.name || 'Visor',
      team: 'Séneca CF',
      player: selectedPlayerTag || undefined,
      half: detectedHalf,
      zone: selectedPitchZone,
      descriptors: activeDescriptors,
      userClassified: Boolean(selectedPlayerTag || activeDescriptors.length > 0),
      notes: isStill ? 'IMAGEN_PARADA' : 'VIDEO_CORRIENDO_TRACKING',
      drawingDataUrl: dataUrl,
      isFreezeInsert: isStill,
      freezeTimestamp: safeTime,
      freezeDuration: isManualHold ? 0 : freezeSecs,
      createdAt: new Date().toISOString(),
    };

    const nextEvents = [...events, newEvent];
    setEvents(nextEvents);
    setSelectedEventId(newEvent.id);
    setDrawingMode(false);
    pushHistory({ events: nextEvents, captures: nextCaps, drawings: updatedDrawings });

    if (isStill) {
      // Mantiene la imagen totalmente parada en el visor sin que el vídeo siga corriendo
      triggeredFreezeIdsRef.current.add(newEvent.id);
      setActiveFreezeOverlay({
        eventId: newEvent.id,
        dataUrl,
        remaining: freezeSecs,
        total: freezeSecs,
        resumeAfter: false,
        manualHold: true,
      });
      notify(
        `Imagen parada (${labelDuration}) insertada: el vídeo se detendrá en este fotograma sin seguir corriendo`
      );
    } else {
      setActiveFreezeOverlay(null);
      if (videoRef.current && activeVideo) {
        if (Math.abs(videoRef.current.currentTime - earliestStart) > 0.2) {
          videoRef.current.currentTime = earliestStart;
        }
        videoRef.current.play().catch(() => {});
        setIsPlaying(true);
      }
      notify(
        `Pintado insertado en movimiento (${runningSecs} s): el conector/foco sigue a los jugadores marcados`
      );
    }
  };

  const handleFilesSelected = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const newItems: VideoFileItem[] = [];
    Array.from(fileList).forEach((file) => {
      if (file.type.startsWith('video/') || file.name.match(/\.(mp4|mov|webm|mkv|avi)$/i)) {
        const url = URL.createObjectURL(file);
        newItems.push({
          id: `vid-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          name: file.name,
          url,
          duration: 0,
          size: file.size,
        });
      }
    });

    if (newItems.length > 0) {
      setVideos((prev) => [...prev, ...newItems]);
      if (!activeVideoId) {
        setActiveVideoId(newItems[0].id);
      }
      notify(`${newItems.length} vídeo(s) cargado(s) correctamente`);
    }
  };

  const handleLoadDemoVideo = async () => {
    setIsGeneratingDemo(true);
    notify('Generando vídeo táctico de partido en el visor...');
    try {
      const { url, duration: demoDur } = await createDemoMatchVideoBlobUrl();
      const demoItem: VideoFileItem = {
        id: `demo-seneca-${Date.now()}`,
        name: 'Partido_Seneca_CF_Visor_Tactico.webm',
        url,
        duration: demoDur,
        isDemo: true,
      };
      setVideos((prev) => [...prev, demoItem]);
      setActiveVideoId(demoItem.id);
      setDuration(demoDur);

      if (
        markers.firstHalfStart === undefined &&
        markers.firstHalfEnd === undefined &&
        markers.secondHalfStart === undefined
      ) {
        setMarkers({
          firstHalfStart: 0.3,
          firstHalfEnd: Number((demoDur * 0.45).toFixed(1)),
          secondHalfStart: Number((demoDur * 0.52).toFixed(1)),
          matchEnd: Number((demoDur * 0.96).toFixed(1)),
        });
      }

      if (events.length === 0) {
        const sampleEvents: ClipEvent[] = [
          {
            id: `ev-demo-1`,
            name: 'Salida de Balón Limpia',
            category: 'Salida de Balón',
            color: '#cc2016',
            startTime: 0.4,
            endTime: 2.2,
            videoId: demoItem.id,
            videoName: demoItem.name,
            team: 'Séneca CF',
            player: '6. Pivote Def.',
            zone: 'Zona Central Defensiva',
            half: '1ª Parte',
            descriptors: ['Éxito / Positivo', 'Supera Líneas'],
            userClassified: true,
            createdAt: new Date().toISOString(),
          },
          {
            id: `ev-demo-2`,
            name: 'Presión Alta tras Pérdida',
            category: 'Presión Alta / Robo',
            color: '#00838f',
            startTime: 2.3,
            endTime: 3.9,
            videoId: demoItem.id,
            videoName: demoItem.name,
            team: 'Séneca CF',
            player: '8. Interior Der.',
            zone: 'Zona Media Centro',
            half: '1ª Parte',
            descriptors: ['Duelo Ganado', 'Progresión'],
            userClassified: true,
            createdAt: new Date().toISOString(),
          },
          {
            id: `ev-demo-3`,
            name: 'Transición Ofensiva Rápida',
            category: 'Transición Ofensiva',
            color: '#f5b800',
            startTime: 4.3,
            endTime: 6.0,
            videoId: demoItem.id,
            videoName: demoItem.name,
            team: 'Séneca CF',
            player: '7. Extremo Der.',
            zone: 'Carril Der. Ofensivo',
            half: '2ª Parte',
            descriptors: ['Progresión', 'Centro Lateral'],
            userClassified: true,
            createdAt: new Date().toISOString(),
          },
          {
            id: `ev-demo-4`,
            name: 'GOL SÉNECA CF (Remate 9)',
            category: 'GOL SÉNECA CF',
            color: '#1565c0',
            startTime: 6.1,
            endTime: 7.8,
            videoId: demoItem.id,
            videoName: demoItem.name,
            team: 'Séneca CF',
            player: '9. Delantero Centro',
            zone: 'Zona Central Ofensiva (Área)',
            half: '2ª Parte',
            descriptors: ['Éxito / Positivo', 'Remate a Puerta'],
            userClassified: true,
            createdAt: new Date().toISOString(),
          },
        ];
        setEvents(sampleEvents);
        setSelectedEventId(sampleEvents[0].id);
      }

      notify('Vídeo cargado con 1ª Parte, 2ª Parte y cortes agrupados por clasificación');
    } catch (e) {
      console.error(e);
      notify('Error al generar el vídeo de prueba');
    } finally {
      setIsGeneratingDemo(false);
    }
  };

  const togglePlay = () => {
    if (!videoRef.current || !activeVideo) {
      if (activeFreezeOverlay) setActiveFreezeOverlay(null);
      return;
    }
    if (activeFreezeOverlay) {
      setActiveFreezeOverlay(null);
      videoRef.current.currentTime = Math.min(
        duration || 99999,
        videoRef.current.currentTime + 0.25
      );
      setDrawingMode(false);
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
      return;
    }
    if (videoRef.current.paused) {
      setDrawingMode(false);
      videoRef.current.play().catch(() => {});
      setIsPlaying(true);
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  const skipSeconds = (delta: number) => {
    if (activeFreezeOverlay) setActiveFreezeOverlay(null);
    if (!videoRef.current || !activeVideo) return;
    const nextTime = Math.max(0, Math.min(duration || 99999, videoRef.current.currentTime + delta));
    videoRef.current.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  const handleToggleFullscreen = () => {
    if (!videoContainerRef.current) return;
    if (!document.fullscreenElement) {
      videoContainerRef.current.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  };

  const handleTogglePiP = async () => {
    try {
      if (videoRef.current && document.pictureInPictureElement !== videoRef.current) {
        await videoRef.current.requestPictureInPicture();
        setPipActive(true);
      } else if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        setPipActive(false);
      } else {
        setAbLoopActive((prev) => !prev);
        notify(!abLoopActive ? 'Bucle A/B activado' : 'Bucle A/B desactivado');
      }
    } catch {
      setAbLoopActive((prev) => !prev);
      notify(!abLoopActive ? 'Bucle A/B activado' : 'Bucle A/B desactivado');
    }
  };

  const handleSetPointA = () => {
    const t = activeTab === 'sin_video' ? liveTimerSeconds : currentTime;
    setPointA(t);
    if (pointB !== null && pointB <= t) {
      setPointB(null);
    }
    notify(`Punto A (Inicio) marcado en la línea de tiempo (${formatTimecode(t)})`);
  };

  const allAvailablePlayers = useMemo(() => {
    const fromRoster = rosterPlayers.map((rp) => `${rp.dorsal}. ${rp.name}`);
    const fromEvents = events.map((e) => e.player).filter((p): p is string => Boolean(p && p.trim()));
    return Array.from(new Set([...SENECA_PLAYERS, ...fromRoster, ...fromEvents]));
  }, [rosterPlayers, events]);

  const getClipOutcome = useCallback((descriptors?: string[]): 'positivo' | 'negativo' | 'neutro' => {
    const list = descriptors || [];
    if (list.some((d) => d.includes('Positivo') || d.includes('Éxito'))) return 'positivo';
    if (list.some((d) => d.includes('Negativo') || d.includes('Pérdida') || d.includes('Fallo'))) return 'negativo';
    return 'neutro';
  }, []);

  const applyOutcomeToDescriptors = useCallback(
    (descriptors: string[] | undefined, outcome: 'positivo' | 'negativo' | 'neutro'): string[] => {
      const cleaned = (descriptors || []).filter(
        (d) =>
          d !== 'Éxito / Positivo' &&
          d !== 'Pérdida / Fallo' &&
          d !== 'Negativo / Fallo' &&
          !d.includes('Positivo') &&
          !d.includes('Negativo')
      );
      if (outcome === 'positivo') return ['Éxito / Positivo', ...cleaned];
      if (outcome === 'negativo') return ['Pérdida / Fallo', ...cleaned];
      return cleaned;
    },
    []
  );

  const updateExistingClip = useCallback(
    (clipId: string, patch: Partial<ClipEvent>) => {
      const updated = events.map((ev) =>
        ev.id === clipId ? { ...ev, ...patch, userClassified: true } : ev
      );
      setEvents(updated);
      pushHistory({ events: updated });
    },
    [events, pushHistory]
  );

  const openEditClipModal = useCallback(
    (ev: ClipEvent) => {
      if (activeTab !== 'sin_video' && videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
        setIsPlaying(false);
      }
      setEditingClipId(ev.id);
      setPendingClipRange({ start: ev.startTime, end: ev.endTime });
      setNewClipCategory(ev.category);
      setNewClipName(ev.name);
      setNewClipTeam(ev.team);
      setNewClipPlayer(ev.player || '');
      setNewClipDescriptors(ev.descriptors && ev.descriptors.length > 0 ? ev.descriptors : []);
      if (ev.zone) setSelectedPitchZone(ev.zone);
      setNewClipNotes(ev.notes || '');
      setSelectedEventId(ev.id);
    },
    [activeTab]
  );

  const handleSetPointB = () => {
    const t = activeTab === 'sin_video' ? liveTimerSeconds : currentTime;
    const start = Number((pointA !== null ? Math.min(pointA, t) : Math.max(0, t - 4)).toFixed(1));
    const end = pointA !== null ? Math.max(pointA, t) : t;
    const finalEnd = Number((end <= start ? start + 2.5 : end).toFixed(1));

    setPointA(start);
    setPointB(finalEnd);

    if (videoRef.current && !videoRef.current.paused) {
      videoRef.current.pause();
      setIsPlaying(false);
    }

    setEditingClipId(null);
    setPendingClipRange({ start, end: finalEnd });
    setNewClipName(`${newClipCategory}`);
    setNewClipTeam(selectedTeamFilter);
    setNewClipPlayer(selectedPlayerTag);
    setNewClipDescriptors(activeDescriptors);
    setNewClipNotes('');
  };

  const confirmSavePendingClip = () => {
    if (!pendingClipRange) return;
    const catObj = tagCategories.find((c) => c.name === newClipCategory);

    let detectedHalf: '1ª Parte' | '2ª Parte' = liveHalf;
    if (markers.secondHalfStart !== undefined && pendingClipRange.start >= markers.secondHalfStart) {
      detectedHalf = '2ª Parte';
    } else if (markers.firstHalfStart !== undefined && pendingClipRange.start >= markers.firstHalfStart) {
      detectedHalf = '1ª Parte';
    }

    if (editingClipId) {
      const updated = events.map((ev) =>
        ev.id === editingClipId
          ? {
              ...ev,
              name: newClipName.trim() || `${newClipCategory}`,
              category: newClipCategory,
              color: catObj?.color || ev.color || '#cc2016',
              startTime: Number(pendingClipRange.start.toFixed(1)),
              endTime: Number(Math.max(pendingClipRange.start + 0.5, pendingClipRange.end).toFixed(1)),
              team: newClipTeam,
              player: newClipPlayer.trim() || undefined,
              zone: selectedPitchZone,
              half: detectedHalf,
              descriptors: newClipDescriptors,
              userClassified: true,
              notes: newClipNotes.trim() || undefined,
            }
          : ev
      );
      setEvents(updated);
      pushHistory({ events: updated });
      setSelectedEventId(editingClipId);
      setEditingClipId(null);
      setPendingClipRange(null);
      setNewClipNotes('');
      const outLabel =
        getClipOutcome(newClipDescriptors) === 'positivo'
          ? 'Con Éxito / Acierto'
          : getClipOutcome(newClipDescriptors) === 'negativo'
          ? 'Negativo / No acertada'
          : 'Sin marcar';
      notify(`Acción actualizada (${newClipPlayer.trim() || 'Sin posición'} · ${outLabel})`);
      return;
    }

    const newClip: ClipEvent = {
      id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      name: newClipName.trim() || `${newClipCategory}`,
      category: newClipCategory,
      color: catObj?.color || '#cc2016',
      startTime: Number(pendingClipRange.start.toFixed(1)),
      endTime: Number(Math.max(pendingClipRange.start + 0.5, pendingClipRange.end).toFixed(1)),
      videoId: activeVideo?.id || 'sin-video',
      videoName: activeVideo?.name || 'Registro Directo',
      team: newClipTeam,
      player: newClipPlayer.trim() || undefined,
      zone: selectedPitchZone,
      half: detectedHalf,
      descriptors: newClipDescriptors,
      userClassified: true,
      notes: newClipNotes.trim() || undefined,
      createdAt: new Date().toISOString(),
    };

    const nextEvents = [...events, newClip];
    setEvents(nextEvents);
    pushHistory({ events: nextEvents });
    setSelectedEventId(newClip.id);
    setEditingClipId(null);
    setPendingClipRange(null);
    setNewClipNotes('');
    const outLabel =
      getClipOutcome(newClip.descriptors) === 'positivo'
        ? 'Con Éxito / Acierto'
        : getClipOutcome(newClip.descriptors) === 'negativo'
        ? 'Negativo / No acertada'
        : 'Sin marcar';
    notify(`Acción "${newClip.name}" guardada (${newClip.player || 'Sin posición'} · ${outLabel})`);
  };

  const updateLastDirectTaggedClip = useCallback(
    (patch: Partial<ClipEvent>) => {
      if (!lastDirectTaggedClipId) return;
      setEvents((prev) =>
        prev.map((ev) => (ev.id === lastDirectTaggedClipId ? { ...ev, ...patch, userClassified: true } : ev))
      );
    },
    [lastDirectTaggedClipId]
  );

  const handleQuickCategoryTag = useCallback(
    (cat: TagCategory, forceMode?: 'auto' | 'manual') => {
      const baseTime = activeTab === 'sin_video' ? liveTimerSeconds : currentTime;
      const isManual = forceMode ? forceMode === 'manual' : cat.mode === 'manual';

      let detectedHalf: '1ª Parte' | '2ª Parte' = liveHalf;
      if (markers.secondHalfStart !== undefined && baseTime >= markers.secondHalfStart) {
        detectedHalf = '2ª Parte';
      } else if (markers.firstHalfStart !== undefined && baseTime >= markers.firstHalfStart) {
        detectedHalf = '1ª Parte';
      }

      // Caso 1: Modo Manual (Inicio / Fin) estilo Nacsport
      if (isManual) {
        if (activeManualRecordings[cat.id]) {
          // Cierre de la grabación manual
          const rec = activeManualRecordings[cat.id];
          const start = Number(rec.startTime.toFixed(1));
          const end = Number(Math.max(start + 0.8, baseTime).toFixed(1));

          setActiveManualRecordings((prev) => {
            const next = { ...prev };
            delete next[cat.id];
            return next;
          });

          if (directOneClickMode) {
            const newClip: ClipEvent = {
              id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
              name: cat.name,
              category: cat.name,
              color: cat.color || '#cc2016',
              startTime: start,
              endTime: end,
              videoId: activeVideo?.id || 'sin-video',
              videoName: activeVideo?.name || 'Registro Directo',
              team: rec.team,
              player: rec.player || selectedPlayerTag || undefined,
              zone: rec.zone || selectedPitchZone,
              half: detectedHalf,
              descriptors: rec.descriptors && rec.descriptors.length > 0 ? rec.descriptors : activeDescriptors,
              userClassified: true,
              createdAt: new Date().toISOString(),
            };
            const nextEvents = [...events, newClip];
            setEvents(nextEvents);
            pushHistory({ events: nextEvents });
            setSelectedEventId(newClip.id);
            setLastDirectTaggedClipId(newClip.id);
            notify(`✓ Corte manual "${cat.name}" guardado (${formatTimecode(start)} - ${formatTimecode(end)})`);
            return;
          } else {
            if (activeTab !== 'sin_video' && videoRef.current && !videoRef.current.paused) {
              videoRef.current.pause();
              setIsPlaying(false);
            }
            setEditingClipId(null);
            setPendingClipRange({ start, end });
            setNewClipCategory(cat.name);
            setNewClipName(cat.name);
            setNewClipTeam(rec.team);
            setNewClipPlayer(rec.player || selectedPlayerTag);
            setNewClipDescriptors(rec.descriptors.length > 0 ? rec.descriptors : activeDescriptors);
            setNewClipNotes('');
            return;
          }
        } else {
          // Inicio de la grabación manual
          setActiveManualRecordings((prev) => ({
            ...prev,
            [cat.id]: {
              startTime: baseTime,
              team: selectedTeamFilter,
              player: selectedPlayerTag || undefined,
              zone: selectedPitchZone,
              descriptors: [...activeDescriptors],
            },
          }));
          notify(
            `● GRABANDO "${cat.name}" desde ${formatTimecode(baseTime)}... Haz clic de nuevo o pulsa [${
              cat.shortcut || 'tecla'
            }] para cerrar`
          );
          return;
        }
      }

      // Caso 2: Modo Automático con Pre-roll / Post-roll
      const pre = duration > 0 && duration <= 20 ? 1.2 : cat.preRoll || 5;
      const post = duration > 0 && duration <= 20 ? 1.5 : cat.postRoll || 5;
      const start = Number(Math.max(0, baseTime - pre).toFixed(1));
      const endRaw = activeTab === 'sin_video' ? baseTime + post : Math.min(maxTimelineDuration, baseTime + post);
      const end = Number(Math.max(start + 1.2, endRaw).toFixed(1));

      if (directOneClickMode) {
        // Registro 1-Clic directo estilo Nacsport en vivo: no detiene el vídeo
        const newClip: ClipEvent = {
          id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
          name: cat.name,
          category: cat.name,
          color: cat.color || '#cc2016',
          startTime: start,
          endTime: end,
          videoId: activeVideo?.id || 'sin-video',
          videoName: activeVideo?.name || 'Registro Directo',
          team: selectedTeamFilter,
          player: selectedPlayerTag || undefined,
          zone: selectedPitchZone,
          half: detectedHalf,
          descriptors: [...activeDescriptors],
          userClassified: true,
          createdAt: new Date().toISOString(),
        };
        const nextEvents = [...events, newClip];
        setEvents(nextEvents);
        pushHistory({ events: nextEvents });
        setSelectedEventId(newClip.id);
        setLastDirectTaggedClipId(newClip.id);
        const outLabel =
          getClipOutcome(newClip.descriptors) === 'positivo'
            ? '✓ Positivo'
            : getClipOutcome(newClip.descriptors) === 'negativo'
            ? '✕ Negativo'
            : 'Neutro';
        notify(
          `⚡ Acción "${cat.name}" registrada [${formatTimecode(start)} - ${formatTimecode(end)}] (${
            newClip.player || 'Colectivo'
          } · ${outLabel})`
        );
        return;
      }

      // Modo con modal de clasificación
      if (activeTab !== 'sin_video' && videoRef.current && !videoRef.current.paused) {
        videoRef.current.pause();
        setIsPlaying(false);
      }

      setEditingClipId(null);
      setPendingClipRange({ start, end });
      setNewClipCategory(cat.name);
      setNewClipName(cat.name);
      setNewClipTeam(selectedTeamFilter);
      setNewClipPlayer(selectedPlayerTag);
      setNewClipDescriptors(activeDescriptors);
      setNewClipNotes('');
    },
    [
      activeTab,
      liveTimerSeconds,
      currentTime,
      liveHalf,
      markers,
      activeManualRecordings,
      directOneClickMode,
      activeVideo,
      selectedPlayerTag,
      selectedPitchZone,
      activeDescriptors,
      events,
      pushHistory,
      notify,
      selectedTeamFilter,
      duration,
      maxTimelineDuration,
      getClipOutcome,
    ]
  );

  const enterBotoneraFullscreen = useCallback(
    (layout?: 'split_video' | 'board_only') => {
      if (layout) setBotoneraFullscreenLayout(layout);
      setIsBotoneraFullscreen(true);
      try {
        if (!document.fullscreenElement) {
          document.documentElement.requestFullscreen?.().catch(() => {});
        }
      } catch {}
      notify('Botonera Nacsport en pantalla completa activada');
    },
    [notify]
  );

  const exitBotoneraFullscreen = useCallback(() => {
    setIsBotoneraFullscreen(false);
    try {
      if (document.fullscreenElement) {
        document.exitFullscreen?.().catch(() => {});
      }
    } catch {}
    notify('Pantalla completa desactivada');
  }, [notify]);

  // Atajos de teclado en vivo para la botonera (1, 2, 3... Q, W... y tecla F para pantalla completa)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (
        activeEl &&
        (activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          activeEl.tagName === 'SELECT' ||
          (activeEl as HTMLElement).isContentEditable)
      ) {
        return;
      }

      if (e.key === 'Escape' && isBotoneraFullscreen) {
        exitBotoneraFullscreen();
        return;
      }

      if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (!isBotoneraFullscreen) {
          enterBotoneraFullscreen();
        } else {
          exitBotoneraFullscreen();
        }
        return;
      }

      if (e.code === 'Space' && activeVideo && activeTab !== 'sin_video') {
        e.preventDefault();
        togglePlay();
        return;
      }

      const keyUpper = e.key.toUpperCase();
      const matchedCat = tagCategories.find((c) => c.shortcut && c.shortcut.toUpperCase() === keyUpper);
      if (matchedCat) {
        e.preventDefault();
        handleQuickCategoryTag(matchedCat);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [tagCategories, isBotoneraFullscreen, activeVideo, activeTab, handleQuickCategoryTag, enterBotoneraFullscreen, exitBotoneraFullscreen]);

  // Manejo de Plantillas de Botonera
  const handleApplyTemplate = (tpl: BotoneraTemplate) => {
    setActiveTemplateId(tpl.id);
    setTagCategories(tpl.categories);
    setCustomDescriptors(tpl.descriptors || NACSPORT_DESCRIPTORS);
    setBotoneraColumns(tpl.columns || 5);
    setBotoneraButtonSize(tpl.buttonSize || 'md');
    setDirectOneClickMode(tpl.directOneClickMode !== false);
    setShowPitchInBotonera(tpl.showPitchZones !== false);
    setShowPlayersInBotonera(tpl.showPlayersGrid !== false);
    notify(`Plantilla de botonera "${tpl.name}" cargada`);
  };

  const handleSaveCurrentAsTemplate = (name: string) => {
    if (!name.trim()) return;
    const newTpl: BotoneraTemplate = {
      id: `tpl-${Date.now()}`,
      name: name.trim(),
      description: `Botonera personalizada creada (${tagCategories.length} categorías)`,
      categories: [...tagCategories],
      descriptors: [...customDescriptors],
      columns: botoneraColumns,
      buttonSize: botoneraButtonSize,
      directOneClickMode,
      showPitchZones: showPitchInBotonera,
      showPlayersGrid: showPlayersInBotonera,
    };
    const nextTemplates = [...botoneraTemplates, newTpl];
    setBotoneraTemplates(nextTemplates);
    setActiveTemplateId(newTpl.id);
    setNewTemplateNameInput('');
    notify(`Nueva plantilla "${newTpl.name}" guardada con éxito`);
  };

  const handleDeleteTemplate = (id: string) => {
    if (botoneraTemplates.length <= 1) {
      notify('No puedes eliminar la única plantilla de botonera');
      return;
    }
    const filtered = botoneraTemplates.filter((t) => t.id !== id);
    setBotoneraTemplates(filtered);
    if (activeTemplateId === id) {
      handleApplyTemplate(filtered[0]);
    }
    notify('Plantilla de botonera eliminada');
  };

  const handleAddNewCategory = () => {
    if (!newCatName.trim()) {
      notify('Indica un nombre para el botón de categoría');
      return;
    }
    const shortcutAuto =
      newCatShortcut.trim() ||
      String(tagCategories.length < 9 ? tagCategories.length + 1 : tagCategories.length === 9 ? '0' : '');
    const newCat: TagCategory = {
      id: `cat-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
      name: newCatName.trim(),
      color: newCatColor || '#cc2016',
      shortcut: shortcutAuto,
      preRoll: Number(newCatPreRoll) || 5,
      postRoll: Number(newCatPostRoll) || 5,
      type: newCatType,
      mode: newCatMode,
    };
    const updated = [...tagCategories, newCat];
    setTagCategories(updated);
    setNewCatName('');
    setNewCatShortcut('');
    notify(`Botón "${newCat.name}" añadido a la botonera`);
  };

  const handleDeleteCategory = (catId: string) => {
    const updated = tagCategories.filter((c) => c.id !== catId);
    setTagCategories(updated);
    notify('Botón eliminado de la botonera');
  };

  const handleMoveCategory = (index: number, direction: 'up' | 'down') => {
    const targetIdx = direction === 'up' ? index - 1 : index + 1;
    if (targetIdx < 0 || targetIdx >= tagCategories.length) return;
    const copy = [...tagCategories];
    const [moved] = copy.splice(index, 1);
    copy.splice(targetIdx, 0, moved);
    setTagCategories(copy);
  };

  // Filtrado y Agrupación de Eventos según lo clasificado
  const filteredEvents = useMemo(() => {
    return events.filter((ev) => {
      if (filterTeam !== 'ALL' && ev.team !== filterTeam) return false;
      if (filterCategory !== 'ALL' && ev.category !== filterCategory) return false;
      if (filterHalf !== 'ALL' && ev.half !== filterHalf) return false;
      if (filterOutcome !== 'ALL' && getClipOutcome(ev.descriptors) !== filterOutcome) return false;
      return true;
    });
  }, [events, filterTeam, filterCategory, filterHalf, filterOutcome, getClipOutcome]);

  const groupedEvents = useMemo(() => {
    if (eventsGroupBy === 'none') {
      return [{ groupTitle: 'Todos los cortes cronológicos', color: '#15181d', items: filteredEvents }];
    }

    const map = new Map<string, { groupTitle: string; color: string; items: ClipEvent[] }>();

    filteredEvents.forEach((ev) => {
      let key = '';
      let color = ev.color || '#cc2016';

      if (eventsGroupBy === 'category') {
        key = ev.category || 'Sin Categoría';
      } else if (eventsGroupBy === 'team') {
        key = ev.team;
        color = ev.team === 'Séneca CF' ? '#cc2016' : '#1666c0';
      } else if (eventsGroupBy === 'half') {
        key = ev.half || '1ª Parte';
        color = key === '1ª Parte' ? '#1f6fd1' : '#2f8a4a';
      } else if (eventsGroupBy === 'player') {
        key = ev.player || 'Jugador Colectivo / No asignado';
        color = '#15181d';
      } else if (eventsGroupBy === 'outcome') {
        const out = getClipOutcome(ev.descriptors);
        if (out === 'positivo') {
          key = 'Éxito / Positivo';
          color = '#2e7d32';
        } else if (out === 'negativo') {
          key = 'Pérdida / Negativo';
          color = '#cc2016';
        } else {
          key = 'Neutro / Sin calificar';
          color = '#6b7280';
        }
      } else if (eventsGroupBy === 'zone') {
        key = ev.zone || 'Zona General';
        color = '#2e7d32';
      }

      if (!map.has(key)) {
        map.set(key, { groupTitle: key, color, items: [] });
      }
      map.get(key)!.items.push(ev);
    });

    return Array.from(map.values());
  }, [filteredEvents, eventsGroupBy, getClipOutcome]);

  // Añadir cortes seleccionados o un grupo entero a una Lista de Presentación (Playlist Nacsport)
  const addClipsToActivePlaylist = (clipsToAdd: ClipEvent[]) => {
    if (clipsToAdd.length === 0) return;
    setPlaylists((prev) =>
      prev.map((pl) => {
        if (pl.id !== activePlaylistId) return pl;
        const existingSet = new Set(pl.clipIds);
        clipsToAdd.forEach((c) => existingSet.add(c.id));
        return { ...pl, clipIds: Array.from(existingSet) };
      })
    );
    const targetPl = playlists.find((p) => p.id === activePlaylistId);
    notify(`${clipsToAdd.length} corte(s) añadidos a la lista "${targetPl?.name || 'Presentación'}"`);
  };

  // Marcadores de tiempo de partido
  const setMatchMarker = (key: keyof MatchMarkers, label: string) => {
    const t = Number((activeTab === 'sin_video' ? liveTimerSeconds : currentTime).toFixed(1));
    const nextMarkers = { ...markers, [key]: t };
    setMarkers(nextMarkers);
    pushHistory({ markers: nextMarkers });
    notify(`Marca "${label}" fijada en la línea del tiempo en ${formatTimecode(t)}`);
  };

  const clearMatchMarker = (key: keyof MatchMarkers, label: string) => {
    const nextMarkers = { ...markers };
    delete nextMarkers[key];
    setMarkers(nextMarkers);
    pushHistory({ markers: nextMarkers });
    notify(`Marca "${label}" eliminada de la línea de tiempo`);
  };

  const handleJump45Min = () => {
    const jumpDelta = duration > 0 && duration < 45 * 60 ? Number((duration * 0.45).toFixed(1)) : 45 * 60;
    if (activeTab === 'sin_video') {
      setLiveTimerSeconds((prev) => prev + jumpDelta);
      notify(`+${jumpDelta >= 2700 ? '45 min' : `${jumpDelta}s`} añadidos al cronómetro`);
      return;
    }
    const target = Math.min(maxTimelineDuration, currentTime + jumpDelta);
    setCurrentTime(target);
    if (videoRef.current && activeVideo) {
      videoRef.current.currentTime = target;
    }
    notify('Avanzado al siguiente periodo en la línea de tiempo');
  };

  const loadDataUrlImage = (dataUrl: string): Promise<HTMLImageElement | null> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  };

  const renderClipToExportCanvas = async (
    clip: ClipEvent,
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    bannerText: string
  ): Promise<void> => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    const drawBanner = () => {
      ctx.fillStyle = 'rgba(20, 20, 20, 0.88)';
      ctx.fillRect(30, height - 68, 600, 46);
      ctx.fillStyle = clip.color || '#cc2016';
      ctx.fillRect(30, height - 68, 10, 46);
      ctx.fillStyle = '#f5b800';
      ctx.font = 'bold 18px sans-serif';
      ctx.fillText(bannerText, 52, height - 40);
    };

    // Caso 1: El corte es una Imagen Parada insertada (el vídeo permanece 100% detenido durante los segundos de pausa)
    if (clip.isFreezeInsert && clip.drawingDataUrl) {
      videoEl.pause();
      const freezeImg = await loadDataUrlImage(clip.drawingDataUrl);
      const holdMs = Math.max(2, clip.freezeDuration || insertFreezeSeconds || 5) * 1000;
      const startPerf = performance.now();

      await new Promise<void>((res) => {
        const holdStep = () => {
          if (performance.now() - startPerf >= holdMs) {
            res();
            return;
          }
          if (freezeImg) {
            ctx.drawImage(freezeImg, 0, 0, width, height);
          } else {
            drawVideoFrameCropped(ctx, videoEl, width, height);
          }
          drawBanner();
          requestAnimationFrame(holdStep);
        };
        requestAnimationFrame(holdStep);
      });
      return;
    }

    // Caso 2: Corte de vídeo en movimiento (con soporte para pausar si incluye una Imagen Parada intermedia)
    const nestedFreezes = events.filter(
      (ev) =>
        ev.id !== clip.id &&
        ev.isFreezeInsert &&
        ev.drawingDataUrl &&
        (ev.freezeTimestamp ?? ev.startTime) >= clip.startTime &&
        (ev.freezeTimestamp ?? ev.startTime) <= clip.endTime
    );
    const usedNestedIds = new Set<string>();

    await new Promise<void>((res) => {
      videoEl.pause();
      videoEl.currentTime = clip.startTime;
      const onSeek = () => {
        videoEl.removeEventListener('seeked', onSeek);
        videoEl.play().catch(() => {});

        const step = async () => {
          if (videoEl.currentTime >= clip.endTime || videoEl.ended) {
            videoEl.pause();
            res();
            return;
          }

          const hitFreeze = nestedFreezes.find(
            (nf) =>
              !usedNestedIds.has(nf.id) &&
              Math.abs(videoEl.currentTime - (nf.freezeTimestamp ?? nf.startTime)) <= 0.25
          );

          if (hitFreeze && hitFreeze.drawingDataUrl) {
            usedNestedIds.add(hitFreeze.id);
            videoEl.pause();
            const fImg = await loadDataUrlImage(hitFreeze.drawingDataUrl);
            const holdMs = Math.max(2, hitFreeze.freezeDuration || 5) * 1000;
            const t0 = performance.now();
            await new Promise<void>((doneHold) => {
              const loopHold = () => {
                if (performance.now() - t0 >= holdMs) {
                  doneHold();
                  return;
                }
                if (fImg) {
                  ctx.drawImage(fImg, 0, 0, width, height);
                }
                drawBanner();
                requestAnimationFrame(loopHold);
              };
              requestAnimationFrame(loopHold);
            });
            videoEl.play().catch(() => {});
          }

          drawVideoFrameCropped(ctx, videoEl, width, height);
          const { updatedActions } = stepLivePlayerTracking(
            videoEl,
            drawingsRef.current,
            videoEl.currentTime
          );
          drawingsRef.current = updatedActions;
          ctx.save();
          ctx.scale(width / 1280, height / 720);
          renderDrawingActions(ctx, drawingsRef.current, {
            currentTime: videoEl.currentTime,
            selectedId: null,
            ignoreTimeVisibility: false,
            videoElement: videoEl,
            senecaLogoImg: senecaLogoRef.current,
          });
          ctx.restore();
          drawBanner();
          requestAnimationFrame(step);
        };

        requestAnimationFrame(step);
      };
      videoEl.addEventListener('seeked', onSeek);
    });
  };

  // Exportación real de clips de vídeo (puede exportar todos, solo un grupo clasificado o una lista de presentación)
  const recordClipSegment = async (clip: ClipEvent): Promise<Blob | null> => {
    const videoEl = videoRef.current;
    if (!videoEl || !activeVideo) return null;

    const width = exportResolution === '1080p' ? 1920 : exportResolution === '720p' ? 1280 : 854;
    const height = exportResolution === '1080p' ? 1080 : exportResolution === '720p' ? 720 : 480;
    const fps = exportFps === '60 fps' ? 60 : exportFps === '25 fps' ? 25 : 30;

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = width;
    exportCanvas.height = height;
    const ctx = exportCanvas.getContext('2d')!;

    const stream = exportCanvas.captureStream(fps);
    let mimeType = 'video/webm;codecs=vp9';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/mp4';

    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data);
    };

    recorder.start();
    await renderClipToExportCanvas(
      clip,
      ctx,
      width,
      height,
      `SÉNECA CF | ${clip.category.toUpperCase()} · ${clip.name.toUpperCase()}`
    );

    return new Promise((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(chunks, { type: mimeType }));
      };
      if (recorder.state === 'recording') recorder.stop();
    });
  };

  const handleDownloadMergedOrAll = async (
    mode: 'single_merged' | 'one_by_one',
    customClips?: ClipEvent[],
    customLabel?: string
  ) => {
    const targetClips =
      customClips ||
      (checkedClipIds.length > 0 ? events.filter((e) => checkedClipIds.includes(e.id)) : filteredEvents);

    if (targetClips.length === 0) {
      notify('Añade o selecciona al menos un corte antes de exportar');
      return;
    }

    const baseName = (
      customLabel ||
      exportFileName.trim() ||
      projectName ||
      'Analisis_Seneca_CF'
    ).replace(/\s+/g, '_');

    if (!activeVideo || !videoRef.current) {
      exportEventsToCSV(baseName, targetClips);
      return;
    }

    setIsExporting(true);
    try {
      if (mode === 'one_by_one') {
        for (let i = 0; i < targetClips.length; i++) {
          const ev = targetClips[i];
          setExportProgressText(`Exportando corte ${i + 1}/${targetClips.length}: ${ev.name}...`);
          const blob = await recordClipSegment(ev);
          if (blob) {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${baseName}_${i + 1}_${ev.category.replace(/\s+/g, '_')}_${ev.name.replace(/\s+/g, '_')}.webm`;
            a.click();
          }
        }
        notify('Cortes descargados uno a uno correctamente');
      } else {
        const width = exportResolution === '1080p' ? 1920 : exportResolution === '720p' ? 1280 : 854;
        const height = exportResolution === '1080p' ? 1080 : exportResolution === '720p' ? 720 : 480;
        const fps = exportFps === '60 fps' ? 60 : exportFps === '25 fps' ? 25 : 30;

        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = width;
        exportCanvas.height = height;
        const ctx = exportCanvas.getContext('2d')!;
        const stream = exportCanvas.captureStream(fps);
        let mimeType = 'video/webm;codecs=vp9';
        if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'video/webm';

        const recorder = new MediaRecorder(stream, { mimeType });
        const chunks: BlobPart[] = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunks.push(e.data);
        };

        recorder.start();

        for (let i = 0; i < targetClips.length; i++) {
          const clip = targetClips[i];
          setExportProgressText(`Uniendo corte ${i + 1}/${targetClips.length} (${clip.category}): ${clip.name}...`);
          await renderClipToExportCanvas(
            clip,
            ctx,
            width,
            height,
            `SÉNECA CF | [${i + 1}/${targetClips.length}] ${clip.category.toUpperCase()} - ${clip.name.toUpperCase()}`
          );
        }

        await new Promise<void>((res) => {
          recorder.onstop = () => {
            const mergedBlob = new Blob(chunks, { type: mimeType });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(mergedBlob);
            a.download = `${baseName}_AGRUPADO.webm`;
            a.click();
            res();
          };
          recorder.stop();
        });
        notify('Vídeo agrupado descargado con éxito');
      }
    } finally {
      setIsExporting(false);
      setExportProgressText('');
    }
  };

  // Exportación a CSV (Excel / PowerBI) y XML estándar Sportscode / Nacsport / LongoMatch
  const exportEventsToCSV = (baseName = 'Analisis_Seneca_CF', targetClips = events) => {
    const headers = [
      'ID',
      'Evento',
      'Categoria',
      'Equipo',
      'Posicion_Jugador',
      'Resultado_Acierto',
      'Zona',
      'Periodo',
      'Descriptores',
      'Inicio_Seg',
      'Fin_Seg',
      'Duracion_Seg',
      'Notas',
    ];
    const rows = targetClips.map((ev, idx) => {
      const out = getClipOutcome(ev.descriptors);
      const outText =
        out === 'positivo'
          ? 'Con Acierto (Éxito)'
          : out === 'negativo'
          ? 'No Acertada (Negativo)'
          : 'Sin marcar';
      return [
        idx + 1,
        `"${ev.name.replace(/"/g, '""')}"`,
        `"${ev.category}"`,
        `"${ev.team}"`,
        `"${ev.player || 'Sin posición marcada'}"`,
        `"${outText}"`,
        `"${ev.zone || ''}"`,
        `"${ev.half || ''}"`,
        `"${(ev.descriptors || []).join(', ')}"`,
        ev.startTime.toFixed(1),
        ev.endTime.toFixed(1),
        (ev.endTime - ev.startTime).toFixed(1),
        `"${(ev.notes || '').replace(/"/g, '""')}"`,
      ];
    });

    const posHeaders = [
      'MATRIZ_POSICION',
      'Con_Acierto_Exito',
      'No_Acertadas_Negativo',
      'Sin_Marcar',
      'Porcentaje_Acierto',
      'Total_Acciones',
    ];
    const posRows = allAvailablePlayers.map((pos) => {
      const pClips = targetClips.filter((e) => e.player === pos);
      const ok = pClips.filter((e) => getClipOutcome(e.descriptors) === 'positivo').length;
      const fail = pClips.filter((e) => getClipOutcome(e.descriptors) === 'negativo').length;
      const neu = pClips.length - ok - fail;
      const pct = ok + fail > 0 ? `${Math.round((ok / (ok + fail)) * 100)}%` : '-';
      return [`"${pos}"`, ok, fail, neu, `"${pct}"`, pClips.length];
    });

    const csvContent =
      'data:text/csv;charset=utf-8,\uFEFF' +
      [
        headers.join(';'),
        ...rows.map((r) => r.join(';')),
        '',
        posHeaders.join(';'),
        ...posRows.map((r) => r.join(';')),
      ].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `${baseName}_Matriz_Eventos_y_Posiciones.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    notify('Matriz de datos CSV (con posiciones y aciertos/no acertadas) descargada');
  };

  const exportEventsToNacsportXML = () => {
    const xmlInstances = events
      .map((ev, idx) => {
        const labelsXml = [
          `<label><group>Equipo</group><text>${ev.team}</text></label>`,
          ev.half ? `<label><group>Periodo</group><text>${ev.half}</text></label>` : '',
          ev.player ? `<label><group>Jugador</group><text>${ev.player}</text></label>` : '',
          ev.zone ? `<label><group>Zona</group><text>${ev.zone}</text></label>` : '',
          ...(ev.descriptors || []).map((d) => `<label><group>Descriptor</group><text>${d}</text></label>`),
        ]
          .filter(Boolean)
          .join('\n      ');

        return `  <instance>
    <ID>${idx + 1}</ID>
    <start>${ev.startTime.toFixed(2)}</start>
    <end>${ev.endTime.toFixed(2)}</end>
    <code>${ev.category}</code>
    ${labelsXml}
  </instance>`;
      })
      .join('\n');

    const xmlDoc = `<?xml version="1.0" encoding="UTF-8"?>
<file>
  <ALL_INSTANCES>
${xmlInstances}
  </ALL_INSTANCES>
</file>`;

    const blob = new Blob([xmlDoc], { type: 'application/xml' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${projectName.replace(/\s+/g, '_')}_Nacsport_XML.xml`;
    a.click();
    notify('Archivo XML compatible con Nacsport / Sportscode / LongoMatch descargado');
  };

  const handleClearProject = () => {
    if (!window.confirm('¿Seguro que quieres limpiar todos los eventos, capturas y dibujos del proyecto actual?')) {
      return;
    }
    setEvents([]);
    setCaptures([]);
    setDrawings([]);
    setMarkers({});
    setPointA(null);
    setPointB(null);
    setSelectedEventId(null);
    setSelectedDrawingId(null);
    localStorage.removeItem('seneca_cf_current_project');
    notify('Proyecto limpiado correctamente');
  };

  const handleInstallApp = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      setDeferredPrompt(null);
    } else {
      notify(
        'Para instalar como App de escritorio: usa el icono de instalar en la barra de direcciones de tu navegador.'
      );
    }
  };

  const totalEventsDuration = filteredEvents.reduce((acc, ev) => acc + Math.max(0, ev.endTime - ev.startTime), 0);
  const selectedEvent = events.find((e) => e.id === selectedEventId) || null;
  const activeTime = activeTab === 'sin_video' ? liveTimerSeconds : currentTime;
  const activeMatchPeriodInfo = getMatchPeriodClock(activeTime, markers);

  const currentPlayingEvent = events.find((ev) => activeTime >= ev.startTime && activeTime <= ev.endTime);

  const p1StartPct =
    markers.firstHalfStart !== undefined ? Math.min(100, (markers.firstHalfStart / maxTimelineDuration) * 100) : null;
  const p1EndPct =
    markers.firstHalfEnd !== undefined
      ? Math.min(100, (markers.firstHalfEnd / maxTimelineDuration) * 100)
      : markers.secondHalfStart !== undefined
      ? Math.min(100, (markers.secondHalfStart / maxTimelineDuration) * 100)
      : p1StartPct !== null
      ? Math.min(100, p1StartPct + 45)
      : null;

  const p2StartPct =
    markers.secondHalfStart !== undefined
      ? Math.min(100, (markers.secondHalfStart / maxTimelineDuration) * 100)
      : null;
  const p2EndPct =
    markers.matchEnd !== undefined
      ? Math.min(100, (markers.matchEnd / maxTimelineDuration) * 100)
      : p2StartPct !== null
      ? 100
      : null;

  const activePlaylist = playlists.find((p) => p.id === activePlaylistId) || playlists[0];
  const activePlaylistClips = useMemo(() => {
    if (!activePlaylist) return [];
    return activePlaylist.clipIds
      .map((id) => events.find((e) => e.id === id))
      .filter((e): e is ClipEvent => Boolean(e));
  }, [activePlaylist, events]);

  const renderNacsportBotonera = (isFs: boolean) => {
    const colClass =
      botoneraColumns === 2
        ? 'grid-cols-2'
        : botoneraColumns === 3
        ? 'grid-cols-2 sm:grid-cols-3'
        : botoneraColumns === 4
        ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4'
        : botoneraColumns === 6
        ? 'grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6'
        : 'grid-cols-2 sm:grid-cols-3 md:grid-cols-5';

    const btnPadding =
      botoneraButtonSize === 'lg'
        ? 'p-3.5 min-h-[72px]'
        : botoneraButtonSize === 'sm'
        ? 'p-1.5 min-h-[44px]'
        : 'p-2.5 min-h-[58px]';

    return (
      <div className={`space-y-3 ${isFs ? 'text-white' : 'text-gray-900'}`}>
        {/* BANNER IDENTIFICATIVO DE LA BOTONERA */}
        <div className={`flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded shadow-sm ${isFs ? 'bg-[#181d28] border border-gray-700' : 'bg-[#161a22] text-white'}`}>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 bg-[#cc2016] inline-block animate-pulse rounded-sm" />
            <span className="font-condensed font-extrabold text-sm tracking-wider uppercase text-[#f5b800]">
              BOTONERA TÁCTICA NACSPORT
            </span>
            <span className="text-gray-400 text-xs hidden sm:inline">·</span>
            <span className="text-xs text-gray-300 font-medium hidden sm:inline">
              Plantilla activa: <strong className="text-white">{botoneraTemplates.find((t) => t.id === activeTemplateId)?.name || 'Séneca Pro'}</strong>
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowBotoneraBuilderModal(true)}
              className="px-2.5 py-1 bg-[#f5b800] hover:bg-[#e0a800] text-gray-950 font-condensed font-extrabold text-xs uppercase rounded flex items-center gap-1 transition shadow"
              title="Añadir categorías, cambiar colores, tiempos y atajos"
            >
              <Sliders className="w-3.5 h-3.5 text-black" />
              <span>🛠 Crear / Editar Botonera</span>
            </button>

            {!isFs && (
              <button
                onClick={() => enterBotoneraFullscreen()}
                className="px-2.5 py-1 bg-[#cc2016] hover:bg-[#a81810] text-white font-condensed font-extrabold text-xs uppercase rounded flex items-center gap-1 transition shadow"
                title="Ver a Pantalla Completa (o pulsa tecla F)"
              >
                <Maximize2 className="w-3.5 h-3.5" />
                <span>⚡ Pantalla Completa (F)</span>
              </button>
            )}
          </div>
        </div>

        {/* FILA 1: EQUIPO, POSICIÓN/JUGADOR, ÉXITO/NEGATIVO, ZONA Y ACCESO A CONSTRUCTOR */}
        <div
          className={`p-2.5 rounded border flex flex-wrap items-center justify-between gap-2 ${
            isFs ? 'bg-[#151922] border-gray-700' : 'bg-white border-gray-300'
          }`}
        >
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {/* Selector de Equipo */}
            <div className="flex items-center gap-1">
              <button
                onClick={() => {
                  setSelectedTeamFilter('Séneca CF');
                  updateLastDirectTaggedClip({ team: 'Séneca CF' });
                }}
                className={`px-3 py-1 font-condensed font-bold uppercase rounded transition ${
                  selectedTeamFilter === 'Séneca CF'
                    ? 'bg-[#cc2016] text-white shadow'
                    : isFs
                    ? 'bg-gray-800 text-gray-300'
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                Séneca CF
              </button>
              <button
                onClick={() => {
                  setSelectedTeamFilter('Rival');
                  updateLastDirectTaggedClip({ team: 'Rival' });
                }}
                className={`px-3 py-1 font-condensed font-bold uppercase rounded transition ${
                  selectedTeamFilter === 'Rival'
                    ? 'bg-[#1666c0] text-white shadow'
                    : isFs
                    ? 'bg-gray-800 text-gray-300'
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                Rival ({rivalName})
              </button>
            </div>

            {/* Selector de Jugador / Posición */}
            <select
              value={selectedPlayerTag}
              onChange={(e) => {
                setSelectedPlayerTag(e.target.value);
                updateLastDirectTaggedClip({ player: e.target.value || undefined });
              }}
              className={`border rounded px-2.5 py-1 text-xs font-medium focus:outline-none focus:border-[#cc2016] ${
                isFs ? 'bg-[#1c2230] border-gray-700 text-white' : 'bg-white border-gray-300 text-gray-900'
              }`}
            >
              <option value="">-- Sin marcar posición --</option>
              {allAvailablePlayers.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>

            {/* Botones de Resultado Éxito / Negativo */}
            <button
              type="button"
              onClick={() => {
                const next =
                  getClipOutcome(activeDescriptors) === 'positivo'
                    ? applyOutcomeToDescriptors(activeDescriptors, 'neutro')
                    : applyOutcomeToDescriptors(activeDescriptors, 'positivo');
                setActiveDescriptors(next);
                updateLastDirectTaggedClip({ descriptors: next });
              }}
              className={`px-3 py-1 rounded font-condensed font-bold uppercase border transition flex items-center gap-1 ${
                getClipOutcome(activeDescriptors) === 'positivo'
                  ? 'bg-emerald-600 text-white border-emerald-700 ring-2 ring-emerald-400/50'
                  : isFs
                  ? 'bg-emerald-950/40 text-emerald-400 border-emerald-800 hover:bg-emerald-900/40'
                  : 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50'
              }`}
            >
              <Check className="w-3.5 h-3.5 stroke-[3]" />
              <span>✓ Éxito / Acierto</span>
            </button>

            <button
              type="button"
              onClick={() => {
                const next =
                  getClipOutcome(activeDescriptors) === 'negativo'
                    ? applyOutcomeToDescriptors(activeDescriptors, 'neutro')
                    : applyOutcomeToDescriptors(activeDescriptors, 'negativo');
                setActiveDescriptors(next);
                updateLastDirectTaggedClip({ descriptors: next });
              }}
              className={`px-3 py-1 rounded font-condensed font-bold uppercase border transition flex items-center gap-1 ${
                getClipOutcome(activeDescriptors) === 'negativo'
                  ? 'bg-[#cc2016] text-white border-red-800 ring-2 ring-red-400/50'
                  : isFs
                  ? 'bg-red-950/40 text-red-400 border-red-800 hover:bg-red-900/40'
                  : 'bg-white text-red-700 border-red-300 hover:bg-red-50'
              }`}
            >
              <X className="w-3.5 h-3.5 stroke-[3]" />
              <span>✕ Negativo / Fallo</span>
            </button>

            {/* Selector de Zona */}
            <select
              value={selectedPitchZone}
              onChange={(e) => {
                setSelectedPitchZone(e.target.value);
                updateLastDirectTaggedClip({ zone: e.target.value });
              }}
              className={`border rounded px-2.5 py-1 text-xs ${
                isFs ? 'bg-[#1c2230] border-gray-700 text-white' : 'bg-white border-gray-300 text-gray-900'
              }`}
            >
              {[
                'Carril Izq. Defensivo',
                'Zona Central Defensiva',
                'Carril Der. Defensivo',
                'Carril Izq. Medio',
                'Zona Media Centro',
                'Carril Der. Medio',
                'Carril Izq. Ofensivo',
                'Zona Central Ofensiva (Área)',
                'Carril Der. Ofensivo',
              ].map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </select>
          </div>

          {/* Selector de plantilla y acciones de botonera */}
          <div className="flex items-center gap-1.5 text-xs">
            <select
              value={activeTemplateId}
              onChange={(e) => {
                const t = botoneraTemplates.find((t) => t.id === e.target.value);
                if (t) handleApplyTemplate(t);
              }}
              className={`border rounded px-2 py-1 text-xs font-semibold ${
                isFs ? 'bg-[#1c2230] border-gray-700 text-[#f5b800]' : 'bg-gray-100 border-gray-300 text-gray-800'
              }`}
            >
              {botoneraTemplates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>

            <button
              onClick={() => setShowBotoneraBuilderModal(true)}
              className="px-2.5 py-1 bg-[#141414] hover:bg-gray-800 text-[#f5b800] rounded text-xs font-condensed font-bold uppercase tracking-wider flex items-center gap-1"
              title="Personalizar botones, colores, atajos y modos de la botonera"
            >
              <Sliders className="w-3 h-3" />
              <span>Editar Botonera</span>
            </button>

            {!isFs && (
              <button
                onClick={() => enterBotoneraFullscreen()}
                className="px-3 py-1 bg-[#cc2016] hover:bg-[#a81810] text-white rounded text-xs font-condensed font-bold uppercase tracking-wider flex items-center gap-1"
                title="Ver esta botonera a pantalla completa"
              >
                <Maximize2 className="w-3 h-3" />
                <span>Pantalla Completa</span>
              </button>
            )}
          </div>
        </div>

        {/* FILA 2: DESCRIPTORES TÁCTICOS EXTRA */}
        {showDescriptorsInBotonera && (
          <div className="flex flex-wrap items-center gap-1">
            <span
              className={`text-[11px] font-condensed font-bold uppercase mr-1 ${
                isFs ? 'text-gray-400' : 'text-gray-500'
              }`}
            >
              Descriptores:
            </span>
            {customDescriptors
              .filter((d) => d !== 'Éxito / Positivo' && d !== 'Pérdida / Fallo')
              .map((desc) => {
                const isOn = activeDescriptors.includes(desc);
                return (
                  <button
                    key={desc}
                    onClick={() => {
                      const next = isOn ? activeDescriptors.filter((d) => d !== desc) : [...activeDescriptors, desc];
                      setActiveDescriptors(next);
                      updateLastDirectTaggedClip({ descriptors: next });
                    }}
                    className={`px-2 py-0.5 text-[11px] rounded border transition ${
                      isOn
                        ? 'bg-[#15181d] text-[#f5b800] border-[#f5b800] font-bold shadow-sm'
                        : isFs
                        ? 'bg-gray-800/80 text-gray-300 border-gray-700 hover:bg-gray-700'
                        : 'bg-gray-100 text-gray-700 border-gray-200 hover:bg-gray-200'
                    }`}
                  >
                    {desc}
                  </button>
                );
              })}
            <button
              onClick={() => {
                setBuilderTab('descriptores');
                setShowBotoneraBuilderModal(true);
              }}
              className="text-[11px] text-gray-400 hover:text-[#f5b800] px-1.5 py-0.5 underline"
            >
              + Añadir descriptor
            </button>
          </div>
        )}

        {/* FILA 3: CUADRÍCULA PRINCIPAL DE BOTONES DE CATEGORÍA NACSPORT */}
        <div className={`grid ${colClass} gap-2`}>
          {tagCategories.map((cat) => {
            const isManualRecording = Boolean(activeManualRecordings[cat.id]);
            const isManualMode = cat.mode === 'manual';
            const catClipsCount = events.filter((e) => e.category === cat.name).length;

            return (
              <div
                key={cat.id}
                className={`relative rounded-md overflow-hidden transition-all duration-150 flex flex-col justify-between shadow ${btnPadding} ${
                  isManualRecording
                    ? 'ring-4 ring-red-500 ring-offset-2 ring-offset-black animate-pulse'
                    : 'hover:scale-[1.01] hover:shadow-lg'
                }`}
                style={{
                  backgroundColor: cat.color || '#cc2016',
                  color: '#ffffff',
                }}
              >
                {/* Header del botón: Tipo, Modo, y Atajo de teclado */}
                <div className="flex items-start justify-between gap-1 mb-1">
                  <span className="text-[9.5px] uppercase font-condensed tracking-wider px-1.5 py-0.2 rounded bg-black/35 text-white/90">
                    {cat.type}
                  </span>
                  <div className="flex items-center gap-1">
                    {isManualRecording ? (
                      <span className="bg-white text-red-700 text-[10px] font-bold px-1.5 py-0.2 rounded font-mono animate-bounce">
                        ● REC
                      </span>
                    ) : isManualMode ? (
                      <span className="text-[9px] bg-black/40 text-amber-300 font-bold px-1 py-0.2 rounded">
                        REC Manual
                      </span>
                    ) : (
                      <span className="text-[9px] bg-black/30 text-white/80 font-mono px-1 py-0.2 rounded">
                        -{cat.preRoll}s/+{cat.postRoll}s
                      </span>
                    )}
                    {cat.shortcut && (
                      <span className="bg-black/50 text-[#f5b800] text-[10px] font-mono font-bold px-1.5 py-0.2 rounded shadow-inner">
                        [{cat.shortcut}]
                      </span>
                    )}
                  </div>
                </div>

                {/* Centro: Nombre del Botón Nacsport */}
                <button
                  type="button"
                  onClick={() => handleQuickCategoryTag(cat)}
                  className="w-full text-left font-condensed font-extrabold uppercase text-sm sm:text-base leading-tight tracking-wide drop-shadow-sm flex-1 flex items-center my-0.5"
                >
                  {cat.name}
                </button>

                {/* Pie del botón: Contador de cortes y botón auxiliar manual */}
                <div className="flex items-center justify-between pt-1 border-t border-white/20 mt-1 text-[10px]">
                  <span className="font-mono text-white/90">
                    Cortes: <strong className="text-[#f5b800] font-bold">{catClipsCount}</strong>
                  </span>
                  <div className="flex items-center gap-1">
                    {isManualRecording ? (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleQuickCategoryTag(cat, 'manual');
                        }}
                        className="bg-black/70 hover:bg-black text-amber-300 px-2 py-0.5 rounded font-condensed font-bold uppercase text-[10px]"
                      >
                        Cerrar corte
                      </button>
                    ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleQuickCategoryTag(cat, isManualMode ? 'auto' : 'manual');
                        }}
                        className="bg-black/30 hover:bg-black/60 text-white/90 px-1.5 py-0.5 rounded text-[9.5px]"
                        title={isManualMode ? 'Corte automático de 5s' : 'Iniciar grabación manual'}
                      >
                        {isManualMode ? 'Cortar auto' : '● REC Manual'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* FILA 4 (OPCIONAL): DORSALES / JUGADORES + CAMPO DE 9 ZONAS */}
        {(showPlayersInBotonera || showPitchInBotonera) && (
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 pt-2 border-t border-gray-700/40">
            {showPitchInBotonera && (
              <div className="md:col-span-5 flex flex-col">
                <span
                  className={`text-xs font-condensed font-bold uppercase mb-1 flex items-center gap-1 ${
                    isFs ? 'text-gray-300' : 'text-gray-700'
                  }`}
                >
                  <MapPin className="w-3.5 h-3.5 text-[#cc2016]" />
                  Zona táctica: <strong className="text-[#f5b800]">{selectedPitchZone}</strong>
                </span>
                <div className="relative w-full h-[150px] bg-[#1a472a] rounded border border-gray-600 p-1.5 grid grid-cols-3 grid-rows-3 gap-1 shadow-inner">
                  {[
                    'Carril Izq. Defensivo',
                    'Carril Izq. Medio',
                    'Carril Izq. Ofensivo',
                    'Zona Central Defensiva',
                    'Zona Media Centro',
                    'Zona Central Ofensiva (Área)',
                    'Carril Der. Defensivo',
                    'Carril Der. Medio',
                    'Carril Der. Ofensivo',
                  ].map((zone) => (
                    <button
                      key={zone}
                      onClick={() => {
                        setSelectedPitchZone(zone);
                        updateLastDirectTaggedClip({ zone });
                      }}
                      className={`border rounded flex items-center justify-center p-0.5 text-center transition ${
                        selectedPitchZone === zone
                          ? 'bg-[#cc2016] text-white font-bold ring-2 ring-[#f5b800]'
                          : 'bg-black/25 hover:bg-white/20 text-white/90 text-[10px]'
                      }`}
                    >
                      <span className="text-[10px] leading-tight line-clamp-1">{zone}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {showPlayersInBotonera && (
              <div className={`${showPitchInBotonera ? 'md:col-span-7' : 'md:col-span-12'} flex flex-col`}>
                <span
                  className={`text-xs font-condensed font-bold uppercase mb-1 flex items-center gap-1 ${
                    isFs ? 'text-gray-300' : 'text-gray-700'
                  }`}
                >
                  <Users className="w-3.5 h-3.5 text-[#cc2016]" />
                  Plantilla / Dorsales rápidos:
                </span>
                <div className="flex flex-wrap gap-1 max-h-[150px] overflow-y-auto p-1 bg-black/20 rounded border border-gray-700/50">
                  <button
                    onClick={() => {
                      setSelectedPlayerTag('');
                      updateLastDirectTaggedClip({ player: undefined });
                    }}
                    className={`px-2 py-1 text-xs rounded border transition ${
                      selectedPlayerTag === ''
                        ? 'bg-[#cc2016] text-white font-bold'
                        : isFs
                        ? 'bg-gray-800 text-gray-300 border-gray-700'
                        : 'bg-gray-100 text-gray-800 border-gray-300'
                    }`}
                  >
                    Sin posición
                  </button>
                  {allAvailablePlayers.map((player) => (
                    <button
                      key={player}
                      onClick={() => {
                        const target = selectedPlayerTag === player ? '' : player;
                        setSelectedPlayerTag(target);
                        updateLastDirectTaggedClip({ player: target || undefined });
                      }}
                      className={`px-2 py-1 text-xs rounded border transition ${
                        selectedPlayerTag === player
                          ? 'bg-[#cc2016] text-white font-bold ring-2 ring-[#f5b800]'
                          : isFs
                          ? 'bg-gray-800 text-gray-300 border-gray-700 hover:bg-gray-700'
                          : 'bg-gray-100 text-gray-800 border-gray-300 hover:bg-gray-200'
                      }`}
                    >
                      {player}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      className={`min-h-screen flex flex-col select-none transition-colors duration-150 ${
        isBotoneraFullscreen
          ? 'fixed inset-0 z-40 bg-[#0b0d13] text-white w-screen h-screen overflow-hidden'
          : 'bg-[#f4f4f4] text-[#1a1a1a]'
      }`}
    >
      {/* =====================================================================
          BARRA SUPERIOR: PANTALLA COMPLETA O BARRA ESTÁNDAR
         ===================================================================== */}
      {isBotoneraFullscreen ? (
        <header className="h-[52px] bg-[#141720] text-white flex items-center justify-between px-3 border-b border-[#252936] shrink-0">
          <div className="flex items-center gap-3">
            <img
              src="/seneca-shield.jpg"
              alt="Séneca CF"
              className="h-8 w-8 object-contain rounded-sm bg-white p-0.5 shadow-sm"
            />
            <div className="flex flex-col leading-none">
              <div className="flex items-center gap-1.5">
                <span className="font-condensed font-extrabold tracking-wider text-[16px] text-[#f5b800]">
                  BOTONERA NACSPORT · PANTALLA COMPLETA
                </span>
                <span className="px-1.5 py-0.2 bg-[#cc2016] text-white text-[10px] font-condensed font-bold uppercase rounded">
                  {directOneClickMode ? '⚡ 1-Clic Directo' : '📝 Ventana'}
                </span>
              </div>
              <span className="font-condensed text-[10px] tracking-[0.14em] text-gray-400 uppercase">
                {projectName} · {rivalName}
              </span>
            </div>
          </div>

          {/* CENTRO: CRONO / CONTROLES DE VÍDEO */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 bg-[#1b202c] px-3 py-1 rounded border border-gray-700">
              <Clock className="w-4 h-4 text-[#f5b800]" />
              <span className="font-mono font-bold text-sm text-[#f5b800]">
                {formatTimecode(activeTime)}
              </span>
              {activeMatchPeriodInfo && (
                <span className="text-[11px] font-condensed font-bold uppercase text-white bg-[#cc2016] px-1.5 py-0.2 rounded">
                  {activeMatchPeriodInfo.periodLabel}
                </span>
              )}
            </div>

            {activeVideo && (
              <div className="flex items-center gap-1 bg-[#1b202c] px-2 py-1 rounded border border-gray-700">
                <button
                  onClick={togglePlay}
                  className="px-2.5 py-0.5 bg-[#cc2016] hover:bg-[#a81810] text-white font-condensed font-bold text-xs uppercase rounded flex items-center gap-1"
                >
                  {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3 fill-current" />}
                  <span>{isPlaying ? 'PAUSA' : 'PLAY'}</span>
                </button>
                <button
                  onClick={() => skipSeconds(-5)}
                  className="px-2 py-0.5 bg-gray-700 hover:bg-gray-600 text-[11px] font-semibold rounded text-white"
                >
                  -5s
                </button>
                <button
                  onClick={() => skipSeconds(5)}
                  className="px-2 py-0.5 bg-gray-700 hover:bg-gray-600 text-[11px] font-semibold rounded text-white"
                >
                  +5s
                </button>
              </div>
            )}

            {activeTab === 'sin_video' && (
              <div className="flex items-center gap-1 bg-[#1b202c] px-2 py-1 rounded border border-gray-700">
                <button
                  onClick={() => {
                    if (!liveTimerRunning && markers.firstHalfStart === undefined) {
                      setMarkers((prev) => ({ ...prev, firstHalfStart: Number(liveTimerSeconds.toFixed(1)) }));
                    }
                    setLiveTimerRunning((r) => !r);
                  }}
                  className={`px-2.5 py-0.5 font-condensed font-bold text-xs uppercase rounded ${
                    liveTimerRunning ? 'bg-amber-600' : 'bg-[#cc2016]'
                  }`}
                >
                  {liveTimerRunning ? 'PAUSAR' : 'INICIAR'}
                </button>
                <select
                  value={liveHalf}
                  onChange={(e) => setLiveHalf(e.target.value as any)}
                  className="bg-[#242b3b] text-[11px] font-bold px-1.5 py-0.5 rounded border border-gray-700 text-white"
                >
                  <option value="1ª Parte">1ª Parte</option>
                  <option value="2ª Parte">2ª Parte</option>
                </select>
              </div>
            )}
          </div>

          {/* DERECHA: CONMUTADOR DE DISPOSICIÓN, CREAR BOTONERA Y SALIR */}
          <div className="flex items-center gap-1.5">
            {activeVideo && (
              <div className="flex items-center bg-[#1b202c] p-0.5 rounded border border-gray-700">
                <button
                  onClick={() => setBotoneraFullscreenLayout('split_video')}
                  className={`px-2.5 py-1 text-xs font-condensed font-bold uppercase rounded flex items-center gap-1 transition ${
                    botoneraFullscreenLayout === 'split_video'
                      ? 'bg-[#cc2016] text-white shadow'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  <Tv className="w-3.5 h-3.5" />
                  <span>Vídeo + Botonera</span>
                </button>
                <button
                  onClick={() => setBotoneraFullscreenLayout('board_only')}
                  className={`px-2.5 py-1 text-xs font-condensed font-bold uppercase rounded flex items-center gap-1 transition ${
                    botoneraFullscreenLayout === 'board_only'
                      ? 'bg-[#cc2016] text-white shadow'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  <span>Solo Botonera 100%</span>
                </button>
              </div>
            )}

            <button
              onClick={() => setDirectOneClickMode((prev) => !prev)}
              className={`px-2.5 py-1 text-xs font-condensed font-bold uppercase rounded border transition flex items-center gap-1 ${
                directOneClickMode
                  ? 'bg-emerald-600/20 text-emerald-300 border-emerald-500'
                  : 'bg-amber-600/20 text-amber-300 border-amber-500'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>{directOneClickMode ? '⚡ 1-Clic Directo' : '📝 Ventana'}</span>
            </button>

            <button
              onClick={() => setShowBotoneraBuilderModal(true)}
              className="px-2.5 py-1 bg-[#1f2430] hover:bg-[#2b3242] border border-gray-700 text-[#f5b800] text-xs font-condensed font-bold uppercase rounded flex items-center gap-1"
            >
              <Sliders className="w-3.5 h-3.5" />
              <span>Crear / Editar</span>
            </button>

            <button
              onClick={exitBotoneraFullscreen}
              className="px-3 py-1 bg-red-950/60 hover:bg-red-800 border border-red-700 text-white font-condensed font-bold text-xs uppercase rounded flex items-center gap-1 transition"
            >
              <Minimize2 className="w-3.5 h-3.5" />
              <span>Salir [ESC]</span>
            </button>
          </div>
        </header>
      ) : (
        <>
          <header className="h-[52px] bg-[#161616] text-white flex items-center justify-between px-3 border-b border-[#2b2b2b] shrink-0">
            <div className="flex items-center h-full">
              <div className="flex items-center gap-2.5 pr-4 border-r border-[#333] h-[36px]">
                <img
                  src="/seneca-shield.jpg"
                  alt="Escudo Séneca CF"
                  className="h-9 w-9 object-contain rounded-sm bg-white p-0.5 shadow-sm"
                />
                <div className="flex flex-col leading-none">
                  <div className="flex items-center gap-1.5">
                    <span className="font-condensed font-extrabold tracking-wider text-[17px] text-[#f5b800]">
                      ANÁLISIS SÉNECA CF
                    </span>
                  </div>
                  <span className="font-condensed text-[11px] tracking-[0.16em] text-gray-300 uppercase">
                    DEPARTAMENTO DE VIDEOANÁLISIS
                  </span>
                </div>
              </div>

              <nav className="flex items-center h-full ml-3 gap-1">
                <button
                  onClick={() => setActiveTab('con_video')}
                  className={`h-full px-4 font-condensed font-extrabold text-[14px] tracking-wider uppercase transition-all flex items-center border-b-[3px] ${
                    activeTab === 'con_video'
                      ? 'bg-white text-[#cc2016] border-[#cc2016]'
                      : 'bg-[#262626] text-gray-300 border-transparent hover:bg-[#303030] hover:text-white'
                  }`}
                >
                  ⚡ BOTONERA NACSPORT (VÍDEO)
                </button>
                <button
                  onClick={() => setActiveTab('sin_video')}
                  className={`h-full px-4 font-condensed font-bold text-[14px] tracking-wider uppercase transition-all flex items-center border-b-[3px] ${
                    activeTab === 'sin_video'
                      ? 'bg-white text-[#141414] border-[#cc2016]'
                      : 'bg-[#262626] text-gray-300 border-transparent hover:bg-[#303030] hover:text-white'
                  }`}
                >
                  REGISTRO SIN VÍDEO (CAMPO)
                </button>
                <button
                  onClick={() => setActiveTab('editor')}
                  className={`h-full px-4 font-condensed font-bold text-[14px] tracking-wider uppercase transition-all flex items-center border-b-[3px] ${
                    activeTab === 'editor'
                      ? 'bg-white text-[#141414] border-[#cc2016]'
                      : 'bg-[#262626] text-gray-300 border-transparent hover:bg-[#303030] hover:text-white'
                  }`}
                >
                  SOLO LÍNEA DE TIEMPO
                </button>
              </nav>
            </div>

            <div className="flex items-center gap-2">
              {statusMessage && (
                <div className="hidden xl:flex items-center gap-1.5 bg-[#262626] border border-[#f5b800]/50 text-[#f5b800] px-2.5 py-1 rounded text-xs font-medium">
                  <Check className="w-3.5 h-3.5" />
                  <span>{statusMessage}</span>
                </div>
              )}

              {/* Botón Abrir Botonera a Pantalla Completa */}
              <button
                onClick={() => enterBotoneraFullscreen()}
                className="h-[34px] px-3.5 bg-[#cc2016] hover:bg-[#a81810] text-white rounded text-xs font-condensed font-extrabold uppercase tracking-wider flex items-center gap-1.5 transition shadow-md ring-2 ring-red-500/50"
                title="Abrir la Botonera Nacsport en Pantalla Completa (o pulsa tecla F)"
              >
                <Maximize2 className="w-4 h-4" />
                <span>⚡ BOTONERA PANTALLA COMPLETA</span>
              </button>

              {/* Botón Crear / Personalizar Botonera */}
              <button
                onClick={() => setShowBotoneraBuilderModal(true)}
                className="h-[34px] px-3 bg-[#f5b800] hover:bg-[#e0a800] text-gray-950 rounded text-xs font-condensed font-extrabold uppercase tracking-wider flex items-center gap-1.5 transition shadow-md"
                title="Crear y Personalizar Botonera como en Nacsport"
              >
                <Sliders className="w-4 h-4 text-black" />
                <span>🛠 CREAR BOTONERA</span>
              </button>

              {/* Botón Matriz de Datos Cruzados estilo Nacsport */}
              <button
                onClick={() => setShowMatrixModal(true)}
                className="h-[32px] px-2.5 bg-[#cc2016] hover:bg-[#a81810] text-white rounded text-xs font-condensed font-bold uppercase tracking-wider flex items-center gap-1.5 transition shadow-sm"
                title="Abrir Matriz de Datos y Cruce de Categorías estilo Nacsport"
              >
                <Grid className="w-3.5 h-3.5" />
                <span>Matriz Nacsport</span>
              </button>

              <button
                onClick={() => {
                  fetchProjectsFromSupabase();
                  setShowProjectsModal(true);
                }}
                className="h-[32px] px-2.5 bg-[#242424] hover:bg-[#323232] border border-[#3d3d3d] rounded text-xs flex items-center gap-1.5 text-gray-200 transition"
                title="Gestionar partidos y sincronización con Supabase"
              >
                {supabaseStatus === 'synced' ? (
                  <Cloud className="w-3.5 h-3.5 text-emerald-400" />
                ) : supabaseStatus === 'syncing' ? (
                  <RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                ) : (
                  <CloudOff className="w-3.5 h-3.5 text-amber-400" />
                )}
                <span className="font-medium truncate max-w-[150px]">{projectName}</span>
                <FolderOpen className="w-3.5 h-3.5 text-gray-400 ml-0.5" />
              </button>

              {supabaseStatus === 'local_only' && (
                <button
                  onClick={() => setShowSqlModal(true)}
                  className="h-[32px] px-2 bg-[#cc2016]/20 hover:bg-[#cc2016]/40 border border-[#cc2016] text-[#f5b800] rounded text-[11px] font-semibold flex items-center gap-1"
                >
                  <span>SQL Supabase</span>
                </button>
              )}

              <button
                onClick={handleUndo}
                className="w-[32px] h-[32px] flex items-center justify-center border border-[#444] bg-[#222] hover:bg-[#333] text-gray-200"
                title="Deshacer"
              >
                <Undo2 className="w-4 h-4" />
              </button>
              <button
                onClick={handleRedo}
                className="w-[32px] h-[32px] flex items-center justify-center border border-[#444] bg-[#222] hover:bg-[#333] text-gray-200"
                title="Rehacer"
              >
                <Redo2 className="w-4 h-4" />
              </button>
            </div>
          </header>

          {/* =====================================================================
              SEGUNDA BARRA (VERSIÓN GRATUITA, Limpiar proyecto, INSTALAR APP)
             ===================================================================== */}
          <div className="h-[46px] bg-[#1e1e1e] text-white flex items-center justify-between px-3 border-b-2 border-[#cc2016] shrink-0">
            <div className="flex items-center gap-2">
              <div className="px-4 py-1.5 border border-[#cc2016] bg-[#141414] font-condensed font-bold text-[14px] tracking-wider uppercase text-white flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#f5b800]"></span>
                VERSIÓN GRATUITA
              </div>
              {playingQueue && (
                <div className="flex items-center gap-2 bg-[#cc2016] text-white px-3 py-1 text-xs font-bold rounded animate-pulse">
                  <ListVideo className="w-3.5 h-3.5" />
                  <span>
                    Reproduciendo Grupo ({playingQueueIndex + 1}/{playingQueue.length}):{' '}
                    {playingQueue[playingQueueIndex]?.name}
                  </span>
                  <button
                    onClick={() => setPlayingQueue(null)}
                    className="ml-1 underline text-[11px] hover:text-amber-200"
                  >
                    Detener cola
                  </button>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleClearProject}
                className="px-3.5 py-1.5 bg-[#cc2016] hover:bg-[#a81810] text-white text-xs font-semibold transition"
              >
                Limpiar proyecto
              </button>
              <button
                onClick={handleInstallApp}
                className="px-3.5 py-1.5 bg-transparent hover:bg-[#2d2d2d] border border-gray-500 text-white font-condensed font-bold text-xs tracking-wider uppercase transition"
              >
                INSTALAR APP
              </button>
            </div>
          </div>
        </>
      )}

      {/* =====================================================================
          CUERPO PRINCIPAL DE LA APLICACIÓN
         ===================================================================== */}
      <div className={`flex-1 flex overflow-hidden ${isBotoneraFullscreen ? 'flex-col' : 'flex-col lg:flex-row'}`}>
        {/* COLUMNA IZQUIERDA / VISTA PRINCIPAL: Visor de Vídeo + Botonera + Línea de tiempo */}
        <div
          className={`flex-1 flex ${
            isBotoneraFullscreen
              ? botoneraFullscreenLayout === 'split_video'
                ? 'flex-col lg:flex-row min-h-0 bg-[#090b10] overflow-hidden'
                : 'flex-col min-h-0 bg-[#090b10] overflow-y-auto'
              : 'flex-col bg-[#f4f4f4] overflow-y-auto border-r border-gray-300'
          }`}
        >
          {activeTab !== 'sin_video' ? (
            <>
              {/* Contenedor Negro del Reproductor de Vídeo */}
              <div
                ref={videoContainerRef}
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDraggingOver(true);
                }}
                onDragLeave={() => setIsDraggingOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setIsDraggingOver(false);
                  handleFilesSelected(e.dataTransfer.files);
                }}
                className={`relative bg-black flex flex-col justify-between overflow-hidden ${
                  isBotoneraFullscreen
                    ? botoneraFullscreenLayout === 'board_only'
                      ? 'hidden'
                      : 'w-full lg:w-1/2 h-[340px] lg:h-full shrink-0 border-r border-gray-800'
                    : activeTab === 'con_video'
                    ? 'w-full h-[420px]'
                    : 'w-full h-[490px]'
                } ${isDraggingOver ? 'ring-4 ring-[#cc2016]' : ''}`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="video/*"
                  multiple
                  className="hidden"
                  onChange={(e) => handleFilesSelected(e.target.files)}
                />

                <div className="relative flex-1 min-h-0 w-full h-full overflow-hidden bg-black">
                  {!activeVideo && (
                    <div
                      className={`absolute inset-0 flex flex-col items-center justify-center text-center px-6 z-10 ${
                        drawingMode ? 'pointer-events-none opacity-35' : ''
                      }`}
                    >
                      <p className="text-gray-200 text-[15px] mb-4 max-w-xl font-normal">
                        Sube uno o varios vídeos, realiza cortes, asigna el nombre al evento y descárgalos a tu ordenador.
                      </p>
                      <div className="flex flex-wrap items-center justify-center gap-2.5 mb-3 pointer-events-auto">
                        <button
                          onClick={() => fileInputRef.current?.click()}
                          className="px-4 py-2 bg-[#cc2016] hover:bg-[#a81810] text-white font-condensed font-bold text-[14px] tracking-wider uppercase transition shadow"
                        >
                          SUBIR VÍDEO
                        </button>
                        <button
                          onClick={handleLoadDemoVideo}
                          disabled={isGeneratingDemo}
                          className="px-4 py-2 bg-white hover:bg-gray-100 text-[#141414] font-medium text-[13px] transition shadow disabled:opacity-60"
                        >
                          {isGeneratingDemo ? 'Cargando vídeo táctico...' : 'Usar el vídeo del visor'}
                        </button>
                        <button
                          onClick={() => setShowTutorialModal(true)}
                          className="px-3.5 py-2 bg-transparent hover:bg-white/10 border border-gray-500 text-gray-200 text-[13px] flex items-center gap-1.5 transition"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                          <span>Ver tutorial</span>
                        </button>
                      </div>
                      <p className="text-gray-400 text-xs">
                        También puedes arrastrarlo aquí. Puedes seleccionar varios archivos a la vez.
                      </p>
                    </div>
                  )}

                  <div
                    className="absolute inset-0 w-full h-full overflow-hidden transition-transform duration-150"
                    style={{ transform: `scale(${videoZoom / 100})` }}
                  >
                    {activeVideo && (
                      <video
                        ref={videoRef}
                        src={activeVideo.url}
                        className="object-fill block"
                        style={{
                          position: 'absolute',
                          left: `${
                            -(
                              videoCropBounds.left /
                              Math.max(0.2, videoCropBounds.right - videoCropBounds.left)
                            ) * 100
                          }%`,
                          top: `${
                            -(
                              videoCropBounds.top /
                              Math.max(0.2, videoCropBounds.bottom - videoCropBounds.top)
                            ) * 100
                          }%`,
                          width: `${
                            100 / Math.max(0.2, videoCropBounds.right - videoCropBounds.left)
                          }%`,
                          height: `${
                            100 / Math.max(0.2, videoCropBounds.bottom - videoCropBounds.top)
                          }%`,
                          maxWidth: 'none',
                          maxHeight: 'none',
                          objectFit: 'fill',
                          display: 'block',
                        }}
                        onTimeUpdate={handleTimeUpdate}
                        onLoadedMetadata={() => {
                          if (videoRef.current) {
                            const dur = videoRef.current.duration;
                            setDuration(isFinite(dur) ? dur : activeVideo.duration || 60);
                            refreshVideoCropBounds(videoRef.current, true);
                          }
                        }}
                        onLoadedData={() => {
                          if (videoRef.current) {
                            refreshVideoCropBounds(videoRef.current, true);
                          }
                        }}
                        onCanPlay={() => {
                          if (videoRef.current) {
                            refreshVideoCropBounds(videoRef.current, true);
                          }
                        }}
                        onSeeked={() => {
                          if (videoRef.current) {
                            refreshVideoCropBounds(videoRef.current, true);
                          }
                        }}
                        onPlay={() => {
                          setIsPlaying(true);
                          if (videoRef.current) {
                            refreshVideoCropBounds(videoRef.current, true);
                          }
                        }}
                        onPause={() => setIsPlaying(false)}
                        onClick={() => {
                          if (!drawingMode) togglePlay();
                        }}
                      />
                    )}

                    {/* Fotograma de Pizarra Táctica insertado en el vídeo (pausa activa o evento seleccionado) */}
                    {(activeFreezeOverlay?.dataUrl ||
                      (!drawingMode &&
                        !isPlaying &&
                        currentPlayingEvent?.isFreezeInsert &&
                        currentPlayingEvent?.drawingDataUrl &&
                        drawings.length === 0)) && (
                      <img
                        src={activeFreezeOverlay?.dataUrl || currentPlayingEvent?.drawingDataUrl}
                        alt="Pintado Táctico Insertado"
                        onClick={() => {
                          if (!drawingMode) togglePlay();
                        }}
                        className="absolute inset-0 w-full h-full object-fill z-10 cursor-pointer block"
                      />
                    )}

                    {/* Canvas para PINTADO DE ACCIONES + KLIPDRAW */}
                    <canvas
                      ref={overlayCanvasRef}
                      width={1280}
                      height={720}
                      onMouseDown={handleCanvasMouseDown}
                      onMouseMove={handleCanvasMouseMove}
                      onMouseUp={handleCanvasMouseUp}
                      onDoubleClick={handleCanvasDoubleClick}
                      className={`absolute inset-0 w-full h-full object-fill z-20 block ${
                        activeFreezeOverlay && !drawingMode ? 'opacity-0 pointer-events-none' : ''
                      } ${
                        drawingMode
                          ? isMoveMode
                            ? 'cursor-move pointer-events-auto'
                            : 'cursor-crosshair pointer-events-auto'
                          : 'pointer-events-none'
                      }`}
                    />
                  </div>

                  {/* BOTONES FLOTANTES SOBRE EL VÍDEO (Siempre visibles incluso en pantalla completa del reproductor) */}
                  <div className="absolute top-3 right-3 z-30 flex items-center gap-2 pointer-events-auto">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (document.fullscreenElement) {
                          document.exitFullscreen().catch(() => {});
                        }
                        enterBotoneraFullscreen();
                      }}
                      className="px-3.5 py-1.5 bg-[#cc2016] hover:bg-[#a81810] text-white text-xs font-condensed font-extrabold uppercase tracking-wider rounded shadow-2xl flex items-center gap-1.5 border border-white/30 backdrop-blur transition hover:scale-105"
                      title="Abrir la Botonera Nacsport en Pantalla Completa (o pulsa tecla F)"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                      <span>⚡ Botonera Pantalla Completa</span>
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowBotoneraBuilderModal(true);
                      }}
                      className="px-3 py-1.5 bg-[#f5b800] hover:bg-[#e0a800] text-gray-950 text-xs font-condensed font-extrabold uppercase tracking-wider rounded shadow-2xl flex items-center gap-1.5 border border-yellow-200 backdrop-blur transition hover:scale-105"
                      title="Crear y Personalizar Botonera como en Nacsport"
                    >
                      <Sliders className="w-3.5 h-3.5 text-black" />
                      <span>🛠 Crear Botonera</span>
                    </button>
                  </div>

                  {/* Indicador de Imagen Parada / Pausa Táctica Insertada en el Vídeo */}
                  {activeFreezeOverlay && (
                    <div className="absolute top-3 left-3 z-30 flex items-center gap-2.5 bg-[#15181d]/95 border-l-4 border-[#cc2016] text-white px-3 py-1.5 shadow-lg">
                      <span className="w-2.5 h-2.5 rounded-full bg-[#f5b800] animate-pulse" />
                      <div className="flex flex-col">
                        <span className="font-condensed font-bold text-xs uppercase tracking-wider text-[#f5b800]">
                          {activeFreezeOverlay.manualHold
                            ? 'IMAGEN PARADA · VÍDEO DETENIDO'
                            : `IMAGEN PARADA EN VÍDEO · ${activeFreezeOverlay.remaining.toFixed(1)} s`}
                        </span>
                        {!activeFreezeOverlay.manualHold ? (
                          <div className="w-36 h-1 bg-gray-700 rounded overflow-hidden mt-0.5">
                            <div
                              className="h-full bg-[#cc2016] transition-all duration-100"
                              style={{
                                width: `${Math.max(
                                  0,
                                  Math.min(100, (activeFreezeOverlay.remaining / activeFreezeOverlay.total) * 100)
                                )}%`,
                              }}
                            />
                          </div>
                        ) : (
                          <span className="text-[10px] text-gray-300 leading-tight">
                            El vídeo permanece parado mostrando la pizarra táctica
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => {
                          setActiveFreezeOverlay(null);
                          if (videoRef.current) {
                            videoRef.current.pause();
                            setIsPlaying(false);
                          }
                        }}
                        className="ml-1 px-2 py-0.5 bg-gray-700 hover:bg-gray-600 text-white font-condensed font-bold text-[11px] uppercase rounded-sm transition"
                        title="Quitar superposición manteniendo el vídeo en pausa"
                      >
                        Ver fotograma
                      </button>
                      <button
                        onClick={() => {
                          const advanceQueue = activeFreezeOverlay.advanceQueueAfter;
                          setActiveFreezeOverlay(null);
                          if (advanceQueue && playingQueue && playingQueue.length > 0) {
                            if (playingQueueIndex + 1 < playingQueue.length) {
                              const nextIdx = playingQueueIndex + 1;
                              const nextClip = playingQueue[nextIdx];
                              setPlayingQueueIndex(nextIdx);
                              activateClipPlayback(nextClip, { fromQueue: true });
                            } else {
                              if (videoRef.current) videoRef.current.pause();
                              setIsPlaying(false);
                              setPlayingQueue(null);
                              notify('Reproducción del grupo finalizada');
                            }
                            return;
                          }
                          if (videoRef.current && activeVideo) {
                            videoRef.current.currentTime = Math.min(
                              duration || 99999,
                              videoRef.current.currentTime + 0.25
                            );
                            videoRef.current.play().catch(() => {});
                            setIsPlaying(true);
                          }
                        }}
                        className="px-2 py-0.5 bg-[#cc2016] hover:bg-[#a81810] text-white font-condensed font-bold text-[11px] uppercase rounded-sm transition"
                      >
                        Reanudar vídeo
                      </button>
                    </div>
                  )}

                  {/* Rótulo Televisivo Superior Derecho cuando el vídeo pasa por una acción */}
                  {currentPlayingEvent && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      className="absolute top-3 right-3 z-30 flex items-stretch shadow-lg overflow-hidden border border-black/40 pointer-events-auto"
                    >
                      <div className="bg-[#15181d] text-white font-condensed font-bold text-base px-3 py-1.5 flex items-center">
                        {activeMatchPeriodInfo
                          ? `${activeMatchPeriodInfo.periodLabel} · ${activeMatchPeriodInfo.matchClock}`
                          : formatTimecode(currentPlayingEvent.startTime, false)}
                      </div>
                      <div
                        style={{ backgroundColor: currentPlayingEvent.color || '#cc2016' }}
                        className="text-white font-condensed font-bold text-base uppercase px-3.5 py-1.5 flex items-center tracking-wide"
                      >
                        {currentPlayingEvent.category}
                      </div>
                      <div className="bg-white/95 text-[#15181d] px-3 py-1.5 flex flex-col justify-center gap-1">
                        <div className="flex items-center gap-1.5">
                          <b className="text-xs font-bold leading-tight">
                            {currentPlayingEvent.name} ({currentPlayingEvent.team})
                          </b>
                          {getClipOutcome(currentPlayingEvent.descriptors) === 'positivo' && (
                            <span className="px-1.5 py-0.2 bg-emerald-600 text-white text-[10px] font-condensed font-bold uppercase rounded-sm">
                              ✓ CON ÉXITO / ACIERTO
                            </span>
                          )}
                          {getClipOutcome(currentPlayingEvent.descriptors) === 'negativo' && (
                            <span className="px-1.5 py-0.2 bg-[#cc2016] text-white text-[10px] font-condensed font-bold uppercase rounded-sm">
                              ✕ NEGATIVO / NO ACERTADA
                            </span>
                          )}
                        </div>

                        {/* Solo muestra texto resumen si el usuario ha marcado posición o descriptores */}
                        {(currentPlayingEvent.player || (currentPlayingEvent.descriptors || []).length > 0) && (
                          <span className="text-[10.5px] text-gray-700 font-medium leading-tight">
                            {[currentPlayingEvent.player, ...(currentPlayingEvent.descriptors || [])]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        )}

                        {/* Controles rápidos directos en el rótulo para marcar Posición y Éxito / Negativo */}
                        <div className="flex items-center gap-1 pt-0.5">
                          <select
                            value={currentPlayingEvent.player || ''}
                            onChange={(e) =>
                              updateExistingClip(currentPlayingEvent.id, {
                                player: e.target.value || undefined,
                              })
                            }
                            className="border border-gray-300 rounded px-1.5 py-0.5 text-[10.5px] bg-white text-gray-800 font-medium focus:outline-none focus:border-[#cc2016]"
                            title="Seleccionar posición para esta acción"
                          >
                            <option value="">-- Marcar posición --</option>
                            {allAvailablePlayers.map((p) => (
                              <option key={p} value={p}>
                                {p}
                              </option>
                            ))}
                          </select>

                          <button
                            type="button"
                            onClick={() => {
                              const currentOut = getClipOutcome(currentPlayingEvent.descriptors);
                              updateExistingClip(currentPlayingEvent.id, {
                                descriptors: applyOutcomeToDescriptors(
                                  currentPlayingEvent.descriptors,
                                  currentOut === 'positivo' ? 'neutro' : 'positivo'
                                ),
                              });
                            }}
                            className={`px-1.5 py-0.5 rounded text-[10px] font-condensed font-bold uppercase border transition ${
                              getClipOutcome(currentPlayingEvent.descriptors) === 'positivo'
                                ? 'bg-emerald-600 text-white border-emerald-700'
                                : 'bg-white text-emerald-700 border-gray-300 hover:bg-emerald-50'
                            }`}
                            title="Marcar si ha sido con éxito / acierto (clic de nuevo para quitar)"
                          >
                            ✓ Éxito
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              const currentOut = getClipOutcome(currentPlayingEvent.descriptors);
                              updateExistingClip(currentPlayingEvent.id, {
                                descriptors: applyOutcomeToDescriptors(
                                  currentPlayingEvent.descriptors,
                                  currentOut === 'negativo' ? 'neutro' : 'negativo'
                                ),
                              });
                            }}
                            className={`px-1.5 py-0.5 rounded text-[10px] font-condensed font-bold uppercase border transition ${
                              getClipOutcome(currentPlayingEvent.descriptors) === 'negativo'
                                ? 'bg-[#cc2016] text-white border-red-800'
                                : 'bg-white text-red-700 border-gray-300 hover:bg-red-50'
                            }`}
                            title="Marcar si ha sido negativo / no acertada (clic de nuevo para quitar)"
                          >
                            ✕ Negativo
                          </button>
                        </div>
                      </div>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          openEditClipModal(currentPlayingEvent);
                        }}
                        className="bg-[#15181d] hover:bg-[#cc2016] text-[#f5b800] hover:text-white px-2.5 flex items-center gap-1 font-condensed font-bold text-[11px] uppercase transition pointer-events-auto border-l border-white/15"
                        title="Abrir ventana para clasificar posición y si ha sido con éxito o negativo"
                      >
                        <Pencil className="w-3 h-3" />
                        <span>Editar</span>
                      </button>
                    </div>
                  )}

                  {drawingMode && (
                    <div className="absolute top-2.5 left-1/2 -translate-x-1/2 bg-[#15181d]/90 text-white px-3.5 py-1 rounded text-xs font-medium flex items-center gap-2 z-30 pointer-events-none border border-white/15">
                      <span className="w-2 h-2 rounded-full bg-[#cc2016]" />
                      {isMoveMode ? (
                        <span>Modo Mover: Haz clic y arrastra cualquier elemento pintado para recolocarlo</span>
                      ) : activeTool === 'zona_libre' || activeTool === 'conector' ? (
                        <span>
                          Haz clic en varios puntos del campo para trazar y haz <strong>doble clic</strong> para terminar
                        </span>
                      ) : (
                        <span>
                          KlipDraw / Pintado activo ({activeTool.replace('_', ' ')}): Arrastra o haz clic sobre el visor
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {/* Barra de controles dentro del visor de vídeo (abajo) */}
                <div className="h-[46px] bg-black/95 border-t border-[#262626] px-3 flex items-center justify-between gap-2 z-30 shrink-0 overflow-x-auto">
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={togglePlay}
                      className="px-3 py-1.5 bg-[#1b1b1b] hover:bg-[#2c2c2c] text-white font-condensed font-bold text-[13px] tracking-wider uppercase flex items-center gap-1.5"
                    >
                      {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                      <span>{isPlaying ? 'PAUSAR' : 'REPRODUCIR'}</span>
                    </button>

                    <button
                      onClick={() => skipSeconds(-10)}
                      className="px-2.5 py-1 bg-[#e6e6e6] hover:bg-white text-[#141414] font-medium text-xs"
                    >
                      -10 seg
                    </button>
                    <button
                      onClick={() => skipSeconds(-5)}
                      className="px-2.5 py-1 bg-[#e6e6e6] hover:bg-white text-[#141414] font-medium text-xs"
                    >
                      -5 seg
                    </button>
                    <button
                      onClick={() => skipSeconds(5)}
                      className="px-2.5 py-1 bg-[#e6e6e6] hover:bg-white text-[#141414] font-medium text-xs"
                    >
                      +5 seg
                    </button>
                    <button
                      onClick={() => skipSeconds(10)}
                      className="px-2.5 py-1 bg-[#e6e6e6] hover:bg-white text-[#141414] font-medium text-xs"
                    >
                      +10 seg
                    </button>

                    <button
                      onClick={() => {
                        if (videoRef.current) {
                          videoRef.current.muted = !isMuted;
                          setIsMuted(!isMuted);
                        }
                      }}
                      className="px-2.5 py-1.5 bg-[#1b1b1b] hover:bg-[#2c2c2c] text-white"
                      title="Silenciar / Activar audio"
                    >
                      {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                    </button>

                    {/* BOTONES DIRECTOS DE BOTONERA EN LA BARRA DEL REPRODUCTOR */}
                    <button
                      onClick={() => {
                        if (document.fullscreenElement) {
                          document.exitFullscreen().catch(() => {});
                        }
                        enterBotoneraFullscreen();
                      }}
                      className="px-3 py-1.5 bg-[#cc2016] hover:bg-[#a81810] text-white text-xs font-condensed font-extrabold uppercase tracking-wider flex items-center gap-1.5 shadow"
                      title="Abrir Botonera Nacsport en Pantalla Completa (o pulsa tecla F)"
                    >
                      <Maximize2 className="w-3.5 h-3.5" />
                      <span>⚡ Botonera Pantalla Completa</span>
                    </button>

                    <button
                      onClick={() => setShowBotoneraBuilderModal(true)}
                      className="px-3 py-1.5 bg-[#f5b800] hover:bg-[#e0a800] text-gray-950 text-xs font-condensed font-extrabold uppercase tracking-wider flex items-center gap-1.5 shadow"
                      title="Crear y Personalizar Botonera como en Nacsport"
                    >
                      <Sliders className="w-3.5 h-3.5 text-black" />
                      <span>🛠 Crear Botonera</span>
                    </button>

                    <button
                      onClick={handleToggleFullscreen}
                      className="px-2.5 py-1.5 bg-[#1b1b1b] hover:bg-[#2c2c2c] text-gray-300 text-xs flex items-center gap-1.5"
                      title="Pantalla completa únicamente del visor de vídeo"
                    >
                      <Maximize className="w-3.5 h-3.5" />
                      <span>Solo vídeo</span>
                    </button>

                    <div className="flex items-center bg-[#e6e6e6] text-[#141414] px-2 py-1 text-xs font-medium">
                      <span className="mr-1.5">Velocidad</span>
                      <select
                        value={playbackRate}
                        onChange={(e) => {
                          const rate = parseFloat(e.target.value);
                          setPlaybackRate(rate);
                          if (videoRef.current) videoRef.current.playbackRate = rate;
                        }}
                        className="bg-transparent font-bold focus:outline-none cursor-pointer"
                      >
                        <option value={0.25}>0.25</option>
                        <option value={0.5}>0.5</option>
                        <option value={0.75}>0.75</option>
                        <option value={1}>1</option>
                        <option value={1.25}>1.25</option>
                        <option value={1.5}>1.5</option>
                        <option value={2}>2</option>
                      </select>
                    </div>

                    <button
                      onClick={() => setShowTutorialModal(true)}
                      className="px-2.5 py-1 bg-[#e6e6e6] hover:bg-white text-[#141414] font-medium text-xs"
                    >
                      Tutorial
                    </button>

                    <button
                      onClick={() => setVideoZoom((z) => Math.max(50, z - 10))}
                      className="w-7 h-7 bg-[#e6e6e6] hover:bg-white text-[#141414] font-bold text-xs flex items-center justify-center"
                    >
                      -
                    </button>
                    <span className="px-2.5 py-1 bg-[#e6e6e6] text-[#141414] font-medium text-xs">
                      {videoZoom}%
                    </span>
                    <button
                      onClick={() => setVideoZoom((z) => Math.min(250, z + 10))}
                      className="w-7 h-7 bg-[#e6e6e6] hover:bg-white text-[#141414] font-bold text-xs flex items-center justify-center"
                    >
                      +
                    </button>

                    <button
                      onClick={() => {
                        if (!autoCropBlackBars) {
                          setAutoCropBlackBars(true);
                          setTimeout(() => refreshVideoCropBounds(videoRef.current, true), 30);
                          notify('Ajuste automático sin bandas negras activado');
                        } else if (videoRef.current) {
                          const det = detectVideoCropBounds(videoRef.current);
                          if (det) {
                            setVideoCropBounds(det);
                            setActiveVideoCropBounds(det);
                            notify('Encuadre ajustado al 100% del visor sin espacios en negro');
                          } else {
                            setAutoCropBlackBars(false);
                            const full = { left: 0, right: 1, top: 0, bottom: 1 };
                            setVideoCropBounds(full);
                            setActiveVideoCropBounds(full);
                            notify('Mostrando fotograma completo original');
                          }
                        }
                      }}
                      className={`px-2.5 py-1 text-xs font-semibold transition flex items-center gap-1 ${
                        autoCropBlackBars
                          ? 'bg-[#cc2016] text-white hover:bg-[#a81810]'
                          : 'bg-[#1b1b1b] text-gray-300 hover:bg-[#2c2c2c]'
                      }`}
                      title="Elimina automáticamente las franjas negras laterales y superiores/inferiores del vídeo"
                    >
                      <span>Sin bordes negros</span>
                    </button>
                  </div>
                </div>
              </div>

              {/* VISTA BOTONERA PANTALLA COMPLETA (SPLIT VIDEO O GIANT BOARD) */}
              {isBotoneraFullscreen && (
                <div
                  className={`flex-1 overflow-y-auto ${
                    botoneraFullscreenLayout === 'split_video'
                      ? 'w-full lg:w-1/2 h-full p-3 sm:p-4 bg-[#0d1017]'
                      : 'w-full h-full p-4 sm:p-6 bg-[#090b10]'
                  }`}
                >
                  {renderNacsportBotonera(true)}
                </div>
              )}

              {/* Botonera Nacsport siempre visible debajo del visor de vídeo */}
              {!isBotoneraFullscreen && (
                <div className="bg-white border-b border-gray-300 px-3 py-2.5">
                  {renderNacsportBotonera(false)}
                </div>
              )}
            </>
          ) : (
            /* ================= MODO REGISTRO SIN VÍDEO ================= */
            <div className={`p-4 border-b border-gray-300 ${isBotoneraFullscreen ? 'bg-[#090b10] flex-1 overflow-y-auto' : 'bg-white'}`}>
              <div className="flex flex-wrap items-center justify-between gap-3 bg-[#181818] text-white p-3 rounded mb-4 border-l-4 border-[#cc2016]">
                <div className="flex items-center gap-3">
                  <Clock className="w-6 h-6 text-[#f5b800]" />
                  <div>
                    <div className="font-condensed font-bold text-base tracking-wider uppercase text-[#f5b800]">
                      CRONÓMETRO DE PARTIDO EN DIRECTO (REGISTRO SIN VÍDEO)
                    </div>
                    <div className="text-xs text-gray-300">
                      Todas las acciones y los inicios de 1ª y 2ª parte quedan marcados abajo en la línea del tiempo
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <div className="font-mono text-2xl font-bold bg-black px-4 py-1.5 rounded border border-gray-700 text-[#f5b800]">
                    {formatTimecode(liveTimerSeconds)}
                  </div>
                  <button
                    onClick={() => {
                      if (!liveTimerRunning && markers.firstHalfStart === undefined) {
                        setMarkers((prev) => ({ ...prev, firstHalfStart: Number(liveTimerSeconds.toFixed(1)) }));
                      }
                      setLiveTimerRunning((r) => !r);
                    }}
                    className={`px-4 py-2 font-condensed font-bold text-sm uppercase tracking-wider rounded ${
                      liveTimerRunning ? 'bg-amber-600 hover:bg-amber-700' : 'bg-[#cc2016] hover:bg-[#a81810]'
                    }`}
                  >
                    {liveTimerRunning ? 'PAUSAR CRONO' : 'INICIAR CRONO'}
                  </button>
                  <button
                    onClick={() => {
                      setLiveTimerRunning(false);
                      setLiveTimerSeconds(0);
                    }}
                    className="px-3 py-2 bg-[#2c2c2c] hover:bg-[#3d3d3d] text-xs font-semibold rounded"
                  >
                    Reiniciar
                  </button>
                  <select
                    value={liveHalf}
                    onChange={(e) => {
                      const val = e.target.value as '1ª Parte' | '2ª Parte';
                      setLiveHalf(val);
                      if (val === '2ª Parte' && markers.secondHalfStart === undefined) {
                        setMarkers((prev) => ({ ...prev, secondHalfStart: Number(liveTimerSeconds.toFixed(1)) }));
                      }
                    }}
                    className="bg-[#2c2c2c] text-white text-xs font-bold px-2.5 py-2 rounded border border-gray-600"
                  >
                    <option value="1ª Parte">1ª Parte</option>
                    <option value="2ª Parte">2ª Parte</option>
                  </select>
                </div>
              </div>

              {renderNacsportBotonera(isBotoneraFullscreen)}
            </div>
          )}

          {/* =====================================================================
              SECCIÓN INFERIOR IZQUIERDA: LÍNEA DE TIEMPO COMPLETA
             ===================================================================== */}
          {!isBotoneraFullscreen && (
            <div className="p-3 flex-1 flex flex-col justify-between bg-[#f4f4f4]">
            <div>
              <div className="flex items-center justify-between mb-1.5 min-h-[24px]">
                <div className="flex items-center gap-2 text-xs">
                  {activeMatchPeriodInfo ? (
                    <span className="px-2.5 py-0.5 bg-white border border-[#cc2016] text-[#cc2016] font-condensed font-bold text-sm tracking-wide shadow-sm">
                      {activeMatchPeriodInfo.periodLabel} · MINUTO {activeMatchPeriodInfo.matchClock}
                    </span>
                  ) : (
                    <span className="text-[11px] text-gray-500">
                      Usa los botones <strong>Inicio primera parte</strong> / <strong>Inicio segunda parte</strong> para delimitar los periodos en la línea de tiempo.
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-3 text-[11px] text-gray-600">
                  <span className="flex items-center gap-1">
                    <i className="w-2.5 h-2.5 inline-block bg-[#1f6fd1]/30 border border-[#1f6fd1]" /> 1ª Parte
                  </span>
                  <span className="flex items-center gap-1">
                    <i className="w-2.5 h-2.5 inline-block bg-[#2f8a4a]/30 border border-[#2f8a4a]" /> 2ª Parte
                  </span>
                  <span className="flex items-center gap-1">
                    <i className="w-2.5 h-2.5 inline-block bg-[#cc2016]" /> Acciones ({filteredEvents.length})
                  </span>
                  <span className="flex items-center gap-1">
                    <i className="w-2.5 h-2.5 rounded-full inline-block bg-[#cc2016] border border-white shadow" /> Pintados ({drawings.length})
                  </span>
                  <button
                    onClick={() => setShowCategoryLanes((prev) => !prev)}
                    className={`px-2 py-0.5 border text-[11px] font-semibold flex items-center gap-1 transition ${
                      showCategoryLanes
                        ? 'bg-[#15181d] text-white border-[#15181d]'
                        : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
                    }`}
                  >
                    <Layers className="w-3 h-3" />
                    <span>Carriles de acciones</span>
                  </button>
                </div>
              </div>

              {/* PISTA PRINCIPAL DE LA LÍNEA DE TIEMPO */}
              <div className="relative pt-5 pb-3 overflow-x-auto">
                <div
                  ref={timelineRef}
                  style={{ width: `${timelineZoom * 100}%` }}
                  onClick={(e) => {
                    if (draggingHandle) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    const nextT = Number((clickRatio * maxTimelineDuration).toFixed(1));
                    if (activeTab === 'sin_video') {
                      setLiveTimerSeconds(nextT);
                    } else {
                      setCurrentTime(nextT);
                      if (videoRef.current && activeVideo) {
                        videoRef.current.currentTime = nextT;
                      }
                    }
                  }}
                  className="relative h-[62px] bg-white border border-gray-300 cursor-pointer select-none shadow-inner"
                >
                  {p1StartPct !== null && p1StartPct > 0 && (
                    <div
                      style={{ left: '0%', width: `${p1StartPct}%` }}
                      className="absolute inset-y-0 pointer-events-none z-[1] opacity-40"
                    >
                      <div
                        className="w-full h-full"
                        style={{
                          backgroundImage:
                            'repeating-linear-gradient(135deg, rgba(110,116,123,0.45) 0 4px, rgba(255,255,255,0.7) 4px 9px)',
                        }}
                      />
                    </div>
                  )}

                  {p1EndPct !== null && p2StartPct !== null && p2StartPct > p1EndPct && (
                    <div
                      style={{ left: `${p1EndPct}%`, width: `${p2StartPct - p1EndPct}%` }}
                      className="absolute inset-y-0 pointer-events-none z-[1] flex items-center justify-center"
                    >
                      <div
                        className="w-full h-full opacity-45"
                        style={{
                          backgroundImage:
                            'repeating-linear-gradient(135deg, rgba(110,116,123,0.45) 0 4px, rgba(255,255,255,0.7) 4px 9px)',
                        }}
                      />
                      <span className="absolute top-1 bg-gray-700 text-white font-condensed font-bold text-[10px] px-1.5 py-0.2 rounded-sm tracking-wider uppercase opacity-90">
                        DESCANSO
                      </span>
                    </div>
                  )}

                  {p1StartPct !== null && p1EndPct !== null && p1EndPct > p1StartPct && (
                    <div
                      style={{
                        left: `${p1StartPct}%`,
                        width: `${p1EndPct - p1StartPct}%`,
                        backgroundColor: 'rgba(31, 111, 209, 0.16)',
                      }}
                      className="absolute inset-y-0 border-x border-[#1f6fd1]/40 pointer-events-none z-[1]"
                    >
                      <span className="absolute top-1 left-1/2 -translate-x-1/2 font-condensed font-bold text-[12px] tracking-wider text-[#15181d] bg-white border border-gray-300 px-2 py-0 leading-4 shadow-sm whitespace-nowrap">
                        1ª PARTE
                      </span>
                    </div>
                  )}

                  {p2StartPct !== null && p2EndPct !== null && p2EndPct > p2StartPct && (
                    <div
                      style={{
                        left: `${p2StartPct}%`,
                        width: `${p2EndPct - p2StartPct}%`,
                        backgroundColor: 'rgba(47, 138, 74, 0.16)',
                      }}
                      className="absolute inset-y-0 border-x border-[#2f8a4a]/40 pointer-events-none z-[1]"
                    >
                      <span className="absolute top-1 left-1/2 -translate-x-1/2 font-condensed font-bold text-[12px] tracking-wider text-[#15181d] bg-white border border-gray-300 px-2 py-0 leading-4 shadow-sm whitespace-nowrap">
                        2ª PARTE
                      </span>
                    </div>
                  )}

                  {filteredEvents.map((ev, idx) => {
                    const leftPct = Math.min(99.5, (ev.startTime / maxTimelineDuration) * 100);
                    const widthPct = Math.max(0.8, ((ev.endTime - ev.startTime) / maxTimelineDuration) * 100);
                    const isSelected = selectedEventId === ev.id;
                    return (
                      <div
                        key={ev.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedEventId(ev.id);
                          if (activeTab === 'sin_video') {
                            setLiveTimerSeconds(ev.startTime);
                          } else if (ev.isFreezeInsert && ev.drawingDataUrl) {
                            activateClipPlayback(ev, { holdManual: true });
                          } else {
                            setActiveFreezeOverlay(null);
                            setCurrentTime(ev.startTime);
                            if (videoRef.current && activeVideo) {
                              videoRef.current.currentTime = ev.startTime;
                            }
                          }
                        }}
                        style={{
                          left: `${leftPct}%`,
                          width: `${widthPct}%`,
                          backgroundColor: `${ev.color || '#cc2016'}b8`,
                          borderColor: ev.color || '#cc2016',
                        }}
                        className={`group absolute top-[18px] bottom-[6px] border border-b-[3px] cursor-pointer z-[3] flex items-center justify-center overflow-visible transition ${
                          isSelected ? 'ring-2 ring-[#15181d] brightness-110 z-[5]' : 'hover:brightness-110'
                        }`}
                        title={`${idx + 1}. ${ev.name} (${ev.team}) | ${formatTimecode(ev.startTime)} - ${formatTimecode(ev.endTime)}`}
                      >
                        <div
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            setDraggingHandle({ type: 'eventStart', eventId: ev.id });
                          }}
                          className="absolute -left-[4px] -top-[2px] -bottom-[2px] w-[6px] bg-[#15181d] opacity-0 group-hover:opacity-80 hover:!opacity-100 hover:!bg-[#cc2016] cursor-ew-resize rounded-sm"
                        />

                        <span className="font-condensed font-bold text-[11px] uppercase tracking-wider text-white truncate px-1 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)] pointer-events-none">
                          {ev.name}
                        </span>

                        {(ev.isFreezeInsert || ev.drawingDataUrl) && (
                          <span
                            className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-[#cc2016] border border-white shadow"
                            title="Acción con Pintado Táctico"
                          />
                        )}

                        <span className="hidden group-hover:block absolute left-1/2 -bottom-[15px] -translate-x-1/2 bg-black/80 text-white text-[9.5px] font-semibold px-1.5 py-0.2 rounded whitespace-nowrap pointer-events-none z-20">
                          {(ev.endTime - ev.startTime).toFixed(1)}s
                        </span>

                        <div
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            setDraggingHandle({ type: 'eventEnd', eventId: ev.id });
                          }}
                          className="absolute -right-[4px] -top-[2px] -bottom-[2px] w-[6px] bg-[#15181d] opacity-0 group-hover:opacity-80 hover:!opacity-100 hover:!bg-[#cc2016] cursor-ew-resize rounded-sm"
                        />
                      </div>
                    );
                  })}

                  {drawings.map((d) => {
                    const leftPct = Math.min(99.5, (d.timestamp / maxTimelineDuration) * 100);
                    return (
                      <div
                        key={d.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedDrawingId(d.id);
                          setDrawingMode(true);
                          setCurrentTime(d.timestamp);
                          if (videoRef.current && activeVideo) {
                            videoRef.current.pause();
                            videoRef.current.currentTime = d.timestamp;
                          }
                        }}
                        style={{ left: `${leftPct}%` }}
                        className="absolute -top-[3px] -bottom-[3px] w-[3px] -ml-[1.5px] bg-[#cc2016] z-[5] cursor-pointer hover:scale-x-150 transition"
                        title={`Pintado (${d.tool.replace('_', ' ')}) en ${formatTimecode(d.timestamp)}`}
                      >
                        <span className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-[#cc2016] border border-white shadow" />
                      </div>
                    );
                  })}

                  {(
                    [
                      { key: 'firstHalfStart', short: 'INI 1ª P', full: 'Inicio primera parte' },
                      { key: 'firstHalfEnd', short: 'FIN 1ª P', full: 'Fin primera parte' },
                      { key: 'secondHalfStart', short: 'INI 2ª P', full: 'Inicio segunda parte' },
                      { key: 'matchEnd', short: 'FIN PARTIDO', full: 'Fin de partido' },
                    ] as const
                  ).map((mk) => {
                    const val = markers[mk.key];
                    if (val === undefined) return null;
                    const leftPct = Math.min(99.5, (val / maxTimelineDuration) * 100);
                    return (
                      <div
                        key={mk.key}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setDraggingHandle({ type: 'marker', key: mk.key });
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setCurrentTime(val);
                          if (videoRef.current && activeVideo) {
                            videoRef.current.currentTime = val;
                          }
                        }}
                        style={{ left: `${leftPct}%` }}
                        className="absolute -top-[6px] -bottom-[6px] w-[2px] bg-[#1c2420] shadow-[0_0_0_1px_rgba(255,255,255,0.5)] z-[6] cursor-ew-resize group"
                        title={`${mk.full} (${formatTimecode(val, false)}) — Arrastra para mover`}
                      >
                        <div className="absolute bottom-0.5 left-1/2 -translate-x-1/2 bg-[#1c2420] text-white font-condensed font-bold text-[10px] leading-tight px-1.5 py-0.5 rounded-sm whitespace-nowrap shadow">
                          {mk.short} · {formatTimecode(val, false)}
                        </div>
                      </div>
                    );
                  })}

                  {pointA !== null && (
                    <>
                      <div
                        style={{
                          left: `${Math.min(100, (pointA / maxTimelineDuration) * 100)}%`,
                          width:
                            pointB !== null
                              ? `${Math.max(0.4, ((pointB - pointA) / maxTimelineDuration) * 100)}%`
                              : '2px',
                        }}
                        className="absolute inset-y-0 bg-[#2f6b3c]/35 border-y-2 border-[#2f6b3c] pointer-events-none z-[4]"
                      />
                      <div
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          setDraggingHandle({ type: 'pointA' });
                        }}
                        style={{ left: `${Math.min(99.5, (pointA / maxTimelineDuration) * 100)}%` }}
                        className="absolute -top-1 -bottom-1 w-[7px] -ml-[7px] bg-[#15181d] rounded-l-sm cursor-ew-resize z-[7] flex items-center justify-center"
                      >
                        <div className="w-[2px] h-4 bg-white" />
                        <span className="absolute -top-4 left-1/2 -translate-x-1/2 bg-black/80 text-white text-[9.5px] px-1 rounded whitespace-nowrap pointer-events-none">
                          A: {formatTimecode(pointA, false)}
                        </span>
                      </div>
                    </>
                  )}

                  {pointB !== null && (
                    <div
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        setDraggingHandle({ type: 'pointB' });
                      }}
                      style={{ left: `${Math.min(99.5, (pointB / maxTimelineDuration) * 100)}%` }}
                      className="absolute -top-1 -bottom-1 w-[7px] bg-[#15181d] rounded-r-sm cursor-ew-resize z-[7] flex items-center justify-center"
                    >
                      <div className="w-[2px] h-4 bg-white" />
                      <span className="absolute -top-4 left-1/2 -translate-x-1/2 bg-black/80 text-white text-[9.5px] px-1 rounded whitespace-nowrap pointer-events-none">
                        B: {formatTimecode(pointB, false)}
                      </span>
                    </div>
                  )}

                  <div
                    onMouseDown={(e) => {
                      e.stopPropagation();
                      setDraggingHandle({ type: 'playhead' });
                    }}
                    style={{
                      left: `${Math.min(99.7, (activeTime / maxTimelineDuration) * 100)}%`,
                    }}
                    className="absolute -top-2.5 -bottom-1.5 w-[3px] bg-[#cc2016] shadow-[0_0_6px_rgba(204,32,22,0.8)] z-[8] cursor-ew-resize"
                  >
                    <div className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] border-t-[#cc2016]" />
                    <div className="absolute -top-6 left-1/2 -translate-x-1/2 bg-white border border-[#cc2016] text-[#cc2016] font-condensed font-bold text-[12px] leading-none px-1.5 py-0.5 whitespace-nowrap pointer-events-none shadow-sm">
                      {formatTimecode(activeTime)}
                    </div>
                  </div>
                </div>
              </div>

              {/* CARRILES DE LÍNEA DE TIEMPO POR CATEGORÍAS Y ACCIONES */}
              {showCategoryLanes && (
                <div className="mt-1 mb-2 bg-white border border-gray-300 overflow-hidden shadow-sm">
                  <div className="flex border-b border-gray-200 bg-gray-50 text-[10px] font-condensed font-bold uppercase text-gray-600">
                    <div className="w-[175px] shrink-0 px-2.5 py-1 border-r border-gray-200 flex items-center justify-between">
                      <span>CARRILES NACSPORT</span>
                      <span>VER GRUPO</span>
                    </div>
                    <div className="relative flex-1 h-[22px] overflow-hidden">
                      {p1StartPct !== null && p1EndPct !== null && (
                        <div
                          style={{ left: `${p1StartPct}%`, width: `${Math.max(0, p1EndPct - p1StartPct)}%` }}
                          className="absolute inset-y-0 bg-[#1f6fd1]/15 border-x border-[#1f6fd1]/40 flex items-center justify-center text-[#1f6fd1]"
                        >
                          1ª PARTE
                        </div>
                      )}
                      {p2StartPct !== null && p2EndPct !== null && (
                        <div
                          style={{ left: `${p2StartPct}%`, width: `${Math.max(0, p2EndPct - p2StartPct)}%` }}
                          className="absolute inset-y-0 bg-[#2f8a4a]/15 border-x border-[#2f8a4a]/40 flex items-center justify-center text-[#2f8a4a]"
                        >
                          2ª PARTE
                        </div>
                      )}
                      {[0, 0.25, 0.5, 0.75, 1].map((step) => (
                        <span
                          key={step}
                          style={{ left: `${step * 100}%` }}
                          className="absolute bottom-0.5 -translate-x-1/2 text-[9px] text-gray-400 font-mono"
                        >
                          {formatTimecode(step * maxTimelineDuration, false)}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="max-h-[155px] overflow-y-auto divide-y divide-gray-200">
                    {tagCategories.map((cat) => {
                      const catEvents = filteredEvents.filter((e) => e.category === cat.name);
                      return (
                        <div key={cat.id} className="flex items-center h-[28px] hover:bg-gray-50/80">
                          <div className="w-[185px] shrink-0 h-full px-2 border-r border-gray-200 flex items-center gap-1.5 text-xs">
                            <span
                              className="w-2.5 h-2.5 rounded-sm shrink-0"
                              style={{ backgroundColor: cat.color }}
                            />
                            <b
                              onClick={() => handleQuickCategoryTag(cat)}
                              className="truncate font-semibold text-[11px] text-gray-800 cursor-pointer hover:text-[#cc2016]"
                              title={`Clic para añadir un corte de ${cat.name} (eligiendo quién lo ha hecho y si es positivo o negativo)`}
                            >
                              {cat.name}
                            </b>
                            <button
                              onClick={() => handleQuickCategoryTag(cat)}
                              className="ml-auto px-1 py-0.2 bg-gray-100 hover:bg-[#cc2016] hover:text-white rounded text-[10px] font-bold text-gray-700 transition"
                              title={`Añadir acción de ${cat.name} (marcar quién lo ha hecho y positivo/negativo)`}
                            >
                              +
                            </button>
                            <span className="text-[10px] text-gray-400 font-mono">{catEvents.length}</span>
                            {catEvents.length > 0 && (
                              <button
                                onClick={() => startPlayingClipQueue(catEvents)}
                                className="p-0.5 bg-gray-100 hover:bg-[#cc2016] hover:text-white rounded text-gray-600 transition"
                                title={`Reproducir todos los cortes de ${cat.name} seguidos`}
                              >
                                <Play className="w-2.5 h-2.5 fill-current" />
                              </button>
                            )}
                          </div>

                          <div
                            onClick={(e) => {
                              const rect = e.currentTarget.getBoundingClientRect();
                              const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                              const nextT = Number((ratio * maxTimelineDuration).toFixed(1));
                              setCurrentTime(nextT);
                              if (videoRef.current && activeVideo) {
                                videoRef.current.currentTime = nextT;
                              }
                            }}
                            className="relative flex-1 h-full cursor-pointer overflow-hidden"
                          >
                            {catEvents.map((ev) => {
                              const leftPct = Math.min(99, (ev.startTime / maxTimelineDuration) * 100);
                              const widthPct = Math.max(1.2, ((ev.endTime - ev.startTime) / maxTimelineDuration) * 100);
                              const evOutcome = getClipOutcome(ev.descriptors);
                              return (
                                <div
                                  key={ev.id}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    activateClipPlayback(ev, { holdManual: true });
                                  }}
                                  onDoubleClick={(e) => {
                                    e.stopPropagation();
                                    openEditClipModal(ev);
                                  }}
                                  style={{
                                    left: `${leftPct}%`,
                                    width: `${widthPct}%`,
                                    backgroundColor: ev.color || cat.color,
                                  }}
                                  className={`absolute top-1 bottom-1 rounded-sm px-1 text-[10px] font-condensed font-bold text-white flex items-center gap-1 overflow-hidden shadow-sm cursor-pointer ${
                                    selectedEventId === ev.id ? 'ring-2 ring-black z-10' : 'hover:brightness-110'
                                  }`}
                                  title={`${ev.name} (${ev.team}${ev.player ? ` · ${ev.player}` : ''}) · ${
                                    evOutcome === 'positivo'
                                      ? 'POSITIVO'
                                      : evOutcome === 'negativo'
                                      ? 'NEGATIVO'
                                      : 'NEUTRO'
                                  } | Doble clic para editar`}
                                >
                                  <span className="truncate">
                                    {evOutcome === 'positivo' ? '✓ ' : evOutcome === 'negativo' ? '✕ ' : ''}
                                    {ev.player ? ev.player.split('.')[0] : ev.team === 'Rival' ? `RIV` : `SÉN`}
                                  </span>
                                </div>
                              );
                            })}

                            <div
                              style={{ left: `${Math.min(99.7, (activeTime / maxTimelineDuration) * 100)}%` }}
                              className="absolute inset-y-0 w-[2px] bg-[#cc2016] pointer-events-none z-10"
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Fila de Zoom x1 y enlace "Ocultar controles" */}
              <div className="flex items-center justify-between mt-1 mb-2">
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setTimelineZoom((z) => Math.max(1, z - 1))}
                    className="w-6 h-6 bg-white border border-gray-300 text-xs font-bold flex items-center justify-center hover:bg-gray-100"
                  >
                    -
                  </button>
                  <span className="text-xs font-semibold text-gray-700 px-1.5">Zoom x{timelineZoom}</span>
                  <button
                    onClick={() => setTimelineZoom((z) => Math.min(8, z + 1))}
                    className="w-6 h-6 bg-white border border-gray-300 text-xs font-bold flex items-center justify-center hover:bg-gray-100"
                  >
                    +
                  </button>
                </div>

                <button
                  onClick={() => setHideBottomControls((prev) => !prev)}
                  className="text-xs text-gray-500 hover:text-gray-800"
                >
                  {hideBottomControls ? 'Mostrar controles' : 'Ocultar controles'}
                </button>
              </div>

              {!hideBottomControls && (
                <div className="flex flex-wrap items-center gap-1.5 mb-2.5">
                  <button
                    onClick={handleUndo}
                    className="w-8 h-8 bg-white border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-100"
                    title="Deshacer"
                  >
                    <Undo2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={handleRedo}
                    className="w-8 h-8 bg-white border border-gray-300 flex items-center justify-center text-gray-600 hover:bg-gray-100"
                    title="Rehacer"
                  >
                    <Redo2 className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={handleSetPointA}
                    className="px-3.5 py-1.5 bg-[#cc2016] hover:bg-[#a81810] text-white font-condensed font-bold text-[13px] tracking-wider uppercase transition"
                  >
                    PUNTO A- INICIO {pointA !== null ? `(${formatTimecode(pointA, false)})` : ''}
                  </button>

                  <button
                    onClick={handleSetPointB}
                    className="px-3.5 py-1.5 bg-[#cc2016] hover:bg-[#a81810] text-white font-condensed font-bold text-[13px] tracking-wider uppercase transition"
                  >
                    PUNTO B- FIN {pointB !== null ? `(${formatTimecode(pointB, false)})` : ''}
                  </button>

                  <button
                    onClick={handleTogglePiP}
                    className={`px-3 py-1.5 border text-xs font-medium flex items-center gap-1.5 transition ${
                      abLoopActive || pipActive
                        ? 'bg-[#141414] text-[#f5b800] border-[#141414]'
                        : 'bg-white hover:bg-gray-100 text-gray-800 border-gray-300'
                    }`}
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>A/B en ventana</span>
                  </button>

                  <button
                    onClick={() => setHideMarkerButtons((prev) => !prev)}
                    className="px-3.5 py-1.5 bg-[#1666c0] hover:bg-[#1255a1] text-white text-xs font-semibold transition"
                  >
                    {hideMarkerButtons ? 'Mostrar' : 'Ocultar'}
                  </button>

                  {!hideMarkerButtons && (
                    <>
                      <button
                        onClick={() => setMatchMarker('firstHalfStart', 'Inicio primera parte')}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          clearMatchMarker('firstHalfStart', 'Inicio primera parte');
                        }}
                        className={`px-2.5 py-1.5 border text-xs transition ${
                          markers.firstHalfStart !== undefined
                            ? 'bg-[#1f6fd1] border-[#1f6fd1] text-white font-semibold shadow-sm'
                            : 'bg-white hover:bg-gray-100 border-gray-300 text-gray-700'
                        }`}
                      >
                        Inicio primera parte{' '}
                        {markers.firstHalfStart !== undefined && `(${formatTimecode(markers.firstHalfStart, false)})`}
                      </button>

                      <button
                        onClick={handleJump45Min}
                        className="px-2.5 py-1.5 bg-[#15181d] hover:bg-[#cc2016] border border-[#15181d] text-white text-xs font-semibold transition"
                      >
                        +45 min
                      </button>

                      <button
                        onClick={() => setMatchMarker('firstHalfEnd', 'Fin primera parte')}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          clearMatchMarker('firstHalfEnd', 'Fin primera parte');
                        }}
                        className={`px-2.5 py-1.5 border text-xs transition ${
                          markers.firstHalfEnd !== undefined
                            ? 'bg-[#1f6fd1] border-[#1f6fd1] text-white font-semibold shadow-sm'
                            : 'bg-white hover:bg-gray-100 border-gray-300 text-gray-700'
                        }`}
                      >
                        Fin primera parte{' '}
                        {markers.firstHalfEnd !== undefined && `(${formatTimecode(markers.firstHalfEnd, false)})`}
                      </button>

                      <button
                        onClick={() => setMatchMarker('secondHalfStart', 'Inicio segunda parte')}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          clearMatchMarker('secondHalfStart', 'Inicio segunda parte');
                        }}
                        className={`px-2.5 py-1.5 border text-xs transition ${
                          markers.secondHalfStart !== undefined
                            ? 'bg-[#2f8a4a] border-[#2f8a4a] text-white font-semibold shadow-sm'
                            : 'bg-white hover:bg-gray-100 border-gray-300 text-gray-700'
                        }`}
                      >
                        Inicio segunda parte{' '}
                        {markers.secondHalfStart !== undefined && `(${formatTimecode(markers.secondHalfStart, false)})`}
                      </button>

                      <button
                        onClick={handleJump45Min}
                        className="px-2.5 py-1.5 bg-[#15181d] hover:bg-[#cc2016] border border-[#15181d] text-white text-xs font-semibold transition"
                      >
                        +45 min
                      </button>

                      <button
                        onClick={() => setMatchMarker('matchEnd', 'Fin de partido')}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          clearMatchMarker('matchEnd', 'Fin de partido');
                        }}
                        className={`px-2.5 py-1.5 border text-xs transition ${
                          markers.matchEnd !== undefined
                            ? 'bg-[#15181d] border-[#15181d] text-[#f5b800] font-semibold shadow-sm'
                            : 'bg-white hover:bg-gray-100 border-gray-300 text-gray-700'
                        }`}
                      >
                        Fin de partido{' '}
                        {markers.matchEnd !== undefined && `(${formatTimecode(markers.matchEnd, false)})`}
                      </button>
                    </>
                  )}
                </div>
              )}

              {/* MODAL EMERGENTE DE CLASIFICACIÓN: ¿QUIÉN LO HA HECHO Y SI HA SIDO POSITIVO O NEGATIVO? */}
              {pendingClipRange && (
                <div className="fixed inset-0 bg-black/65 flex items-center justify-center p-4 z-50">
                  <div className="bg-white rounded-lg max-w-2xl w-full p-4 shadow-2xl border-t-4 border-[#cc2016] max-h-[92vh] overflow-y-auto">
                    <div className="flex items-center justify-between pb-2.5 border-b border-gray-200 mb-3">
                      <div className="flex items-center gap-2">
                        <span className="w-3 h-3 rounded-sm bg-[#cc2016]" />
                        <h3 className="font-condensed font-bold text-base uppercase text-gray-900">
                          {editingClipId
                            ? `EDITAR ACCIÓN (${formatTimecode(pendingClipRange.start)} - ${formatTimecode(
                                pendingClipRange.end
                              )})`
                            : `CLASIFICAR ACCIÓN (${formatTimecode(pendingClipRange.start)} - ${formatTimecode(
                                pendingClipRange.end
                              )})`}
                        </h3>
                      </div>
                      <button
                        onClick={() => {
                          setPendingClipRange(null);
                          setEditingClipId(null);
                        }}
                        className="text-gray-400 hover:text-gray-700 p-1"
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </div>

                    {/* 1. ¿CON ÉXITO / ACIERTO O NEGATIVO / NO ACERTADA? */}
                    <div className="mb-3.5 bg-gray-50 p-3 rounded border border-gray-200">
                      <label className="block font-condensed font-bold text-xs uppercase text-gray-800 mb-2">
                        1. ¿HA SIDO CON ÉXITO (ACIERTO) O NEGATIVO (NO ACERTADA)?
                      </label>
                      <div className="grid grid-cols-3 gap-2">
                        <button
                          type="button"
                          onClick={() =>
                            setNewClipDescriptors((prev) =>
                              applyOutcomeToDescriptors(
                                prev,
                                getClipOutcome(prev) === 'positivo' ? 'neutro' : 'positivo'
                              )
                            )
                          }
                          className={`py-2.5 px-3 rounded font-condensed font-bold text-sm uppercase flex items-center justify-center gap-1.5 border-2 transition shadow-sm ${
                            getClipOutcome(newClipDescriptors) === 'positivo'
                              ? 'bg-emerald-600 text-white border-emerald-700 ring-2 ring-emerald-300'
                              : 'bg-white text-emerald-800 border-emerald-300 hover:bg-emerald-50'
                          }`}
                        >
                          <Check className="w-4 h-4 stroke-[3]" />
                          <span>CON ÉXITO / ACIERTO</span>
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            setNewClipDescriptors((prev) =>
                              applyOutcomeToDescriptors(
                                prev,
                                getClipOutcome(prev) === 'negativo' ? 'neutro' : 'negativo'
                              )
                            )
                          }
                          className={`py-2.5 px-3 rounded font-condensed font-bold text-sm uppercase flex items-center justify-center gap-1.5 border-2 transition shadow-sm ${
                            getClipOutcome(newClipDescriptors) === 'negativo'
                              ? 'bg-[#cc2016] text-white border-red-800 ring-2 ring-red-300'
                              : 'bg-white text-red-700 border-red-300 hover:bg-red-50'
                          }`}
                        >
                          <X className="w-4 h-4 stroke-[3]" />
                          <span>NEGATIVO / NO ACERTADA</span>
                        </button>

                        <button
                          type="button"
                          onClick={() =>
                            setNewClipDescriptors((prev) => applyOutcomeToDescriptors(prev, 'neutro'))
                          }
                          className={`py-2.5 px-3 rounded font-condensed font-bold text-sm uppercase flex items-center justify-center gap-1.5 border-2 transition ${
                            getClipOutcome(newClipDescriptors) === 'neutro'
                              ? 'bg-gray-800 text-white border-gray-900'
                              : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-100'
                          }`}
                        >
                          <span>➖ SIN MARCAR</span>
                        </button>
                      </div>
                    </div>

                    {/* 2. POSICIÓN / JUGADOR Y EQUIPO */}
                    <div className="mb-3.5 bg-gray-50 p-3 rounded border border-gray-200">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <label className="font-condensed font-bold text-xs uppercase text-gray-800">
                          2. POSICIÓN / DEMARCACIÓN Y EQUIPO (SOLO SE MUESTRA SI LO MARCAS)
                        </label>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setNewClipTeam('Séneca CF')}
                            className={`px-3 py-1 rounded text-xs font-condensed font-bold uppercase transition ${
                              newClipTeam === 'Séneca CF'
                                ? 'bg-[#cc2016] text-white shadow-sm'
                                : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100'
                            }`}
                          >
                            Séneca CF
                          </button>
                          <button
                            type="button"
                            onClick={() => setNewClipTeam('Rival')}
                            className={`px-3 py-1 rounded text-xs font-condensed font-bold uppercase transition ${
                              newClipTeam === 'Rival'
                                ? 'bg-[#1666c0] text-white shadow-sm'
                                : 'bg-white border border-gray-300 text-gray-700 hover:bg-gray-100'
                            }`}
                          >
                            Rival ({rivalName})
                          </button>
                        </div>
                      </div>

                      <div className="mb-2">
                        <input
                          type="text"
                          value={newClipPlayer}
                          onChange={(e) => setNewClipPlayer(e.target.value)}
                          placeholder="Sin posición marcada (elige una posición abajo o escribe dorsal/nombre)"
                          className="w-full border border-gray-300 px-2.5 py-1.5 text-xs rounded bg-white focus:outline-none focus:border-[#cc2016] font-medium"
                        />
                      </div>

                      <div className="flex flex-wrap gap-1 max-h-[135px] overflow-y-auto">
                        <button
                          type="button"
                          onClick={() => setNewClipPlayer('')}
                          className={`px-2 py-1 text-[11px] rounded border transition ${
                            newClipPlayer === ''
                              ? 'bg-[#141414] text-[#f5b800] border-[#141414] font-bold'
                              : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
                          }`}
                        >
                          Sin marcar posición
                        </button>
                        {allAvailablePlayers.map((p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setNewClipPlayer((prev) => (prev === p ? '' : p))}
                            className={`px-2 py-1 text-[11px] rounded border transition ${
                              newClipPlayer === p
                                ? 'bg-[#141414] text-[#f5b800] border-[#141414] font-bold'
                                : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-100'
                            }`}
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* 3. CATEGORÍA Y DESCRIPTORES ADICIONALES */}
                    <div className="mb-3">
                      <label className="block font-condensed font-bold text-xs uppercase text-gray-700 mb-1.5">
                        3. CATEGORÍA DE LA ACCIÓN
                      </label>
                      <div className="flex flex-wrap gap-1 mb-2.5">
                        {tagCategories.map((cat) => (
                          <button
                            key={cat.id}
                            type="button"
                            onClick={() => {
                              setNewClipCategory(cat.name);
                              if (!newClipName || tagCategories.some((c) => c.name === newClipName)) {
                                setNewClipName(cat.name);
                              }
                            }}
                            style={{
                              backgroundColor: newClipCategory === cat.name ? cat.color : '#f3f4f6',
                              color: newClipCategory === cat.name ? '#fff' : '#1f2937',
                            }}
                            className="px-2 py-1 text-[11px] font-condensed font-bold uppercase rounded transition"
                          >
                            {cat.name}
                          </button>
                        ))}
                      </div>

                      <label className="block font-condensed font-bold text-xs uppercase text-gray-700 mb-1">
                        DESCRIPTORES TÁCTICOS EXTRA (OPCIONAL)
                      </label>
                      <div className="flex flex-wrap gap-1 mb-2.5">
                        {NACSPORT_DESCRIPTORS.filter(
                          (d) => d !== 'Éxito / Positivo' && d !== 'Pérdida / Fallo'
                        ).map((desc) => {
                          const isOn = newClipDescriptors.includes(desc);
                          return (
                            <button
                              key={desc}
                              type="button"
                              onClick={() =>
                                setNewClipDescriptors((prev) =>
                                  prev.includes(desc) ? prev.filter((d) => d !== desc) : [...prev, desc]
                                )
                              }
                              className={`px-2 py-0.5 text-[10.5px] rounded border transition ${
                                isOn
                                  ? 'bg-[#15181d] text-[#f5b800] border-[#15181d] font-semibold'
                                  : 'bg-gray-50 text-gray-600 border-gray-300'
                              }`}
                            >
                              {desc}
                            </button>
                          );
                        })}
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <input
                          type="text"
                          value={newClipName}
                          onChange={(e) => setNewClipName(e.target.value)}
                          placeholder="Título del corte (ej: Tiro cruzado)"
                          className="border border-gray-300 px-2.5 py-1.5 text-xs rounded focus:outline-none focus:border-[#cc2016]"
                        />
                        <input
                          type="text"
                          value={newClipNotes}
                          onChange={(e) => setNewClipNotes(e.target.value)}
                          placeholder="Notas tácticas opcionales..."
                          className="border border-gray-300 px-2.5 py-1.5 text-xs rounded focus:outline-none focus:border-[#cc2016]"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-end gap-2 pt-2.5 border-t border-gray-200">
                      <button
                        type="button"
                        onClick={() => {
                          setPendingClipRange(null);
                          setEditingClipId(null);
                        }}
                        className="px-3.5 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-condensed font-bold text-xs uppercase rounded"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        onClick={confirmSavePendingClip}
                        className="px-5 py-2 bg-[#cc2016] hover:bg-[#a81810] text-white font-condensed font-bold text-sm uppercase tracking-wider rounded shadow"
                      >
                        {editingClipId ? '✓ GUARDAR CAMBIOS' : '✓ GUARDAR ACCIÓN'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="pt-2 border-t border-gray-200 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-4">
                <span className="font-condensed font-bold text-[15px] text-gray-700">
                  {formatTimecode(activeTime)} / {formatTimecode(maxTimelineDuration, false)}
                </span>
                <span className="font-condensed font-bold text-xs uppercase tracking-wider text-gray-800">
                  DATOS DEL EVENTO
                </span>
              </div>

              {(selectedEvent || currentPlayingEvent) ? (() => {
                const activeEv = selectedEvent || currentPlayingEvent!;
                const activeOutcome = getClipOutcome(activeEv.descriptors);
                return (
                  <div className="flex flex-wrap items-center gap-1.5 text-xs bg-white px-2.5 py-1 border border-gray-300 rounded shadow-sm">
                    <span
                      className="w-2.5 h-2.5 rounded-full inline-block shrink-0"
                      style={{ backgroundColor: activeEv.color }}
                    />
                    <strong className="text-gray-900">{activeEv.name}</strong>
                    <span className="text-gray-500 text-[11px]">
                      ({formatTimecode(activeEv.startTime)} - {formatTimecode(activeEv.endTime)})
                    </span>

                    {/* Selector rápido de Equipo */}
                    <select
                      value={activeEv.team}
                      onChange={(e) =>
                        updateExistingClip(activeEv.id, {
                          team: e.target.value as 'Séneca CF' | 'Rival',
                        })
                      }
                      className="border border-gray-300 rounded px-1.5 py-0.5 text-[11px] font-semibold bg-gray-50"
                      title="Cambiar equipo que realiza la acción"
                    >
                      <option value="Séneca CF">Séneca CF</option>
                      <option value="Rival">Rival ({rivalName})</option>
                    </select>

                    {/* Selector rápido de Posición */}
                    <select
                      value={activeEv.player || ''}
                      onChange={(e) =>
                        updateExistingClip(activeEv.id, {
                          player: e.target.value || undefined,
                        })
                      }
                      className="border border-gray-300 rounded px-1.5 py-0.5 text-[11px] bg-gray-50 text-gray-800 font-medium"
                      title="Marcar posición en esta acción"
                    >
                      <option value="">-- Sin posición marcada --</option>
                      {activeEv.player &&
                        !allAvailablePlayers.includes(activeEv.player) && (
                          <option value={activeEv.player}>{activeEv.player}</option>
                        )}
                      {allAvailablePlayers.map((p) => (
                        <option key={p} value={p}>
                          {p}
                        </option>
                      ))}
                    </select>

                    {/* Botones rápidos Éxito (Acierto) / Negativo (No acertada) */}
                    <button
                      onClick={() =>
                        updateExistingClip(activeEv.id, {
                          descriptors: applyOutcomeToDescriptors(
                            activeEv.descriptors,
                            activeOutcome === 'positivo' ? 'neutro' : 'positivo'
                          ),
                        })
                      }
                      className={`px-2 py-0.5 rounded font-condensed font-bold text-[11px] uppercase border transition ${
                        activeOutcome === 'positivo'
                          ? 'bg-emerald-600 text-white border-emerald-700'
                          : 'bg-gray-50 text-emerald-700 border-gray-300 hover:bg-emerald-50'
                      }`}
                      title="Marcar o desmarcar Con Éxito / Acierto"
                    >
                      ✓ Con Éxito / Acierto
                    </button>
                    <button
                      onClick={() =>
                        updateExistingClip(activeEv.id, {
                          descriptors: applyOutcomeToDescriptors(
                            activeEv.descriptors,
                            activeOutcome === 'negativo' ? 'neutro' : 'negativo'
                          ),
                        })
                      }
                      className={`px-2 py-0.5 rounded font-condensed font-bold text-[11px] uppercase border transition ${
                        activeOutcome === 'negativo'
                          ? 'bg-[#cc2016] text-white border-red-800'
                          : 'bg-gray-50 text-red-700 border-gray-300 hover:bg-red-50'
                      }`}
                      title="Marcar o desmarcar Negativo / No Acertada"
                    >
                      ✕ Negativo / No Acertada
                    </button>

                    <button
                      onClick={() => openEditClipModal(activeEv)}
                      className="px-2 py-0.5 bg-[#15181d] hover:bg-[#cc2016] text-[#f5b800] hover:text-white rounded font-condensed font-bold text-[11px] uppercase flex items-center gap-1 transition"
                      title="Abrir ventana para editar posición, nombre y resultado"
                    >
                      <Pencil className="w-3 h-3" />
                      <span>Editar</span>
                    </button>
                  </div>
                );
              })() : (
                <span className="text-xs text-gray-400">
                  Selecciona o reproduce cualquier corte para marcar su Posición y si ha sido Con Éxito (Acierto) o Negativo (No Acertada)
                </span>
              )}
            </div>
          </div>
          )}
        </div>

        {/* =====================================================================
            COLUMNA DERECHA (VÍDEOS, EVENTOS AGRUPADOS Y LISTAS DE PRESENTACIÓN, EXPORTACIÓN, PINTADO + KLIPDRAW)
           ===================================================================== */}
        {!isBotoneraFullscreen && (
          <aside className="w-full lg:w-[400px] xl:w-[425px] bg-white flex flex-col shrink-0 overflow-y-auto max-h-[calc(100vh-98px)]">
          {/* 1. SECCIÓN VÍDEOS */}
          <div className="p-3 border-b border-gray-200">
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 bg-[#cc2016] inline-block" />
                <h2 className="font-condensed font-bold text-[15px] tracking-wider uppercase text-[#141414]">
                  VÍDEOS
                </h2>
              </div>
              <button
                onClick={() => setHideVideosPanel((prev) => !prev)}
                className="w-[84px] h-[28px] bg-[#1666c0] hover:bg-[#1255a1] text-white text-xs font-semibold transition flex items-center justify-center"
              >
                {hideVideosPanel ? 'Mostrar' : 'Ocultar'}
              </button>
            </div>

            {!hideVideosPanel && (
              <div>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="w-full py-2.5 px-3 bg-[#cc2016] hover:bg-[#a81810] text-white font-medium text-xs flex items-center justify-center gap-1.5 transition shadow-sm"
                >
                  <Plus className="w-4 h-4" />
                  <span>+ Añadir vídeo</span>
                </button>

                {videos.length > 0 && (
                  <div className="mt-2 space-y-1 max-h-[100px] overflow-y-auto">
                    {videos.map((v, idx) => (
                      <div
                        key={v.id}
                        onClick={() => setActiveVideoId(v.id)}
                        className={`flex items-center justify-between px-2.5 py-1.5 rounded text-xs cursor-pointer border transition ${
                          activeVideoId === v.id
                            ? 'bg-[#cc2016]/10 border-[#cc2016] text-[#141414] font-semibold'
                            : 'bg-gray-50 border-gray-200 text-gray-700 hover:bg-gray-100'
                        }`}
                      >
                        <div className="flex items-center gap-2 truncate">
                          <Film className="w-3.5 h-3.5 text-[#cc2016] shrink-0" />
                          <span className="truncate">
                            {idx + 1}. {v.name}
                          </span>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const remaining = videos.filter((item) => item.id !== v.id);
                            setVideos(remaining);
                            if (activeVideoId === v.id) {
                              setActiveVideoId(remaining[0]?.id || null);
                            }
                          }}
                          className="text-gray-400 hover:text-red-600 ml-2"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* =====================================================================
              2. SECCIÓN EVENTOS CON AGRUPACIÓN NACSPORT Y LISTAS DE PRESENTACIÓN
             ===================================================================== */}
          <div className="p-3 border-b border-gray-200 flex flex-col">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 bg-[#cc2016] inline-block" />
                <h2 className="font-condensed font-bold text-[15px] tracking-wider uppercase text-[#141414]">
                  EVENTOS Y AGRUPACIÓN
                </h2>
              </div>
              <button
                onClick={() => setShowMatrixModal(true)}
                className="px-2 py-0.5 bg-gray-100 hover:bg-[#15181d] hover:text-[#f5b800] border border-gray-300 text-[11px] font-condensed font-bold uppercase flex items-center gap-1 transition"
                title="Ver Matriz de Datos Cruzados (Categoría x Equipo / Parte)"
              >
                <Grid className="w-3 h-3" />
                <span>Matriz</span>
              </button>
            </div>

            {/* Sub-barra: Evento (Agrupados) | Listas (Playlists Nacsport) | Capturas | Limpiar | Ocultar */}
            <div className="flex items-center justify-between gap-1.5 mb-2">
              <div className="flex items-center gap-2.5 text-xs">
                <button
                  onClick={() => setEventsSubTab('evento')}
                  className={`pb-0.5 font-semibold transition ${
                    eventsSubTab === 'evento'
                      ? 'text-[#141414] border-b-2 border-[#cc2016]'
                      : 'text-gray-400 hover:text-gray-700'
                  }`}
                >
                  Evento ({filteredEvents.length})
                </button>
                <button
                  onClick={() => setEventsSubTab('listas')}
                  className={`pb-0.5 font-semibold transition flex items-center gap-1 ${
                    eventsSubTab === 'listas'
                      ? 'text-[#141414] border-b-2 border-[#cc2016]'
                      : 'text-gray-400 hover:text-gray-700'
                  }`}
                >
                  <span>Listas ({playlists.length})</span>
                </button>
                <button
                  onClick={() => setEventsSubTab('capturas')}
                  className={`pb-0.5 font-semibold transition ${
                    eventsSubTab === 'capturas'
                      ? 'text-[#141414] border-b-2 border-[#cc2016]'
                      : 'text-gray-400 hover:text-gray-700'
                  }`}
                >
                  Capturas ({captures.length})
                </button>
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    if (eventsSubTab === 'evento') {
                      setEvents([]);
                      pushHistory({ events: [] });
                      notify('Lista de eventos vaciada');
                    } else if (eventsSubTab === 'capturas') {
                      setCaptures([]);
                      pushHistory({ captures: [] });
                      notify('Lista de capturas vaciada');
                    }
                  }}
                  className="px-2.5 h-[28px] bg-[#cc2016] hover:bg-[#a81810] text-white text-xs font-semibold transition"
                >
                  Limpiar
                </button>
                <button
                  onClick={() => setHideEventsPanel((prev) => !prev)}
                  className="w-[78px] h-[28px] bg-[#1666c0] hover:bg-[#1255a1] text-white text-xs font-semibold transition flex items-center justify-center"
                >
                  {hideEventsPanel ? 'Mostrar' : 'Ocultar'}
                </button>
              </div>
            </div>

            {!hideEventsPanel && (
              <>
                {eventsSubTab === 'evento' && (
                  <>
                    {/* Controles de Agrupación según lo clasificado (Estilo Nacsport / LongoMatch) */}
                    <div className="bg-[#f7f7f7] border border-gray-200 p-2 rounded mb-2 space-y-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-condensed font-bold uppercase text-gray-700 flex items-center gap-1">
                          <FolderKanban className="w-3.5 h-3.5 text-[#cc2016]" />
                          Agrupar cortes por:
                        </span>
                        <select
                          value={eventsGroupBy}
                          onChange={(e) => setEventsGroupBy(e.target.value as any)}
                          className="border border-gray-300 bg-white px-2 py-1 text-xs font-semibold text-gray-900 rounded-none focus:outline-none focus:border-[#cc2016]"
                        >
                          <option value="category">Categoría / Acción clasificada</option>
                          <option value="player">Quién lo ha hecho (Jugador / Dorsal)</option>
                          <option value="outcome">Resultado (Positivo / Negativo)</option>
                          <option value="team">Equipo (Séneca CF / Rival)</option>
                          <option value="half">Periodo (1ª Parte / 2ª Parte)</option>
                          <option value="zone">Zona del Campo</option>
                          <option value="none">Sin agrupar (Orden cronológico)</option>
                        </select>
                      </div>

                      {/* Filtros combinados rápidos */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1">
                        <select
                          value={filterTeam}
                          onChange={(e) => setFilterTeam(e.target.value as any)}
                          className="border border-gray-300 bg-white px-1.5 py-1 text-[11px]"
                        >
                          <option value="ALL">Todos equipos</option>
                          <option value="Séneca CF">Séneca CF</option>
                          <option value="Rival">Rival</option>
                        </select>

                        <select
                          value={filterOutcome}
                          onChange={(e) => setFilterOutcome(e.target.value as any)}
                          className="border border-gray-300 bg-white px-1.5 py-1 text-[11px] font-semibold"
                        >
                          <option value="ALL">Positivo y Negativo</option>
                          <option value="positivo">✓ Solo Positivos</option>
                          <option value="negativo">✕ Solo Negativos</option>
                        </select>

                        <select
                          value={filterHalf}
                          onChange={(e) => setFilterHalf(e.target.value as any)}
                          className="border border-gray-300 bg-white px-1.5 py-1 text-[11px]"
                        >
                          <option value="ALL">Ambas partes</option>
                          <option value="1ª Parte">1ª Parte</option>
                          <option value="2ª Parte">2ª Parte</option>
                        </select>

                        <select
                          value={filterCategory}
                          onChange={(e) => setFilterCategory(e.target.value)}
                          className="border border-gray-300 bg-white px-1.5 py-1 text-[11px]"
                        >
                          <option value="ALL">Todas acciones</option>
                          {tagCategories.map((c) => (
                            <option key={c.id} value={c.name}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="flex items-center justify-between text-xs text-gray-700 mb-1.5">
                      <span>
                        Resultado: <strong className="font-bold text-black">{formatTimecode(totalEventsDuration)}</strong>
                      </span>
                      {filteredEvents.length > 0 && (
                        <button
                          onClick={() => startPlayingClipQueue(filteredEvents)}
                          className="text-[11px] font-condensed font-bold uppercase text-[#cc2016] hover:underline flex items-center gap-1"
                        >
                          <Play className="w-3 h-3 fill-current" />
                          <span>Reproducir todos ({filteredEvents.length})</span>
                        </button>
                      )}
                    </div>

                    {/* Barra de acciones en lote si hay casillas marcadas */}
                    {checkedClipIds.length > 0 && (
                      <div className="bg-[#15181d] text-white p-2 rounded mb-2 flex items-center justify-between gap-1 text-xs">
                        <span className="font-semibold">{checkedClipIds.length} seleccionados</span>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => {
                              const sel = events.filter((e) => checkedClipIds.includes(e.id));
                              startPlayingClipQueue(sel);
                            }}
                            className="px-2 py-1 bg-[#cc2016] text-white font-bold text-[10.5px] uppercase"
                          >
                            Ver
                          </button>
                          <button
                            onClick={() => {
                              const sel = events.filter((e) => checkedClipIds.includes(e.id));
                              addClipsToActivePlaylist(sel);
                              setCheckedClipIds([]);
                            }}
                            className="px-2 py-1 bg-[#1666c0] text-white font-bold text-[10.5px] uppercase"
                          >
                            + A Lista
                          </button>
                          <button
                            onClick={() => handleDownloadMergedOrAll('single_merged')}
                            className="px-2 py-1 bg-emerald-700 text-white font-bold text-[10.5px] uppercase"
                          >
                            Exportar
                          </button>
                          <button
                            onClick={() => setCheckedClipIds([])}
                            className="px-1.5 py-1 text-gray-300 hover:text-white"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Lista de Eventos Agrupados según Clasificación */}
                    <div className="overflow-y-auto space-y-2 pr-0.5 max-h-[250px] min-h-[110px]">
                      {filteredEvents.length === 0 ? (
                        <div className="h-[95px] border border-dashed border-gray-200 rounded flex flex-col items-center justify-center text-center p-2 text-gray-400 text-xs">
                          <span>Sin cortes en este filtro. Marca Punto A y Punto B o pulsa una acción.</span>
                        </div>
                      ) : (
                        groupedEvents.map((grp) => {
                          const isCollapsed = collapsedGroups[grp.groupTitle] || false;
                          const groupDur = grp.items.reduce(
                            (acc, item) => acc + Math.max(0, item.endTime - item.startTime),
                            0
                          );
                          return (
                            <div key={grp.groupTitle} className="border border-gray-200 rounded overflow-hidden">
                              {/* Cabecera del Grupo Clasificado con botones de Reproducir Grupo, Añadir a Lista y Exportar Grupo */}
                              <div
                                style={{ borderLeftColor: grp.color }}
                                className="border-l-4 bg-gray-100 px-2 py-1.5 flex items-center justify-between gap-1"
                              >
                                <button
                                  onClick={() =>
                                    setCollapsedGroups((prev) => ({
                                      ...prev,
                                      [grp.groupTitle]: !isCollapsed,
                                    }))
                                  }
                                  className="flex items-center gap-1 text-left min-w-0 flex-1"
                                >
                                  {isCollapsed ? (
                                    <ChevronRight className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                                  ) : (
                                    <ChevronDown className="w-3.5 h-3.5 text-gray-600 shrink-0" />
                                  )}
                                  <span className="font-condensed font-bold text-xs uppercase text-gray-900 truncate">
                                    {grp.groupTitle}
                                  </span>
                                  <span className="text-[10.5px] font-mono bg-white px-1.5 py-0.2 border border-gray-200 rounded text-gray-700 shrink-0">
                                    {grp.items.length} · {formatTimecode(groupDur, false)}
                                  </span>
                                </button>

                                <div className="flex items-center gap-1 shrink-0">
                                  <button
                                    onClick={() => startPlayingClipQueue(grp.items)}
                                    className="px-1.5 py-0.5 bg-[#15181d] hover:bg-[#cc2016] text-white text-[10px] font-condensed font-bold uppercase flex items-center gap-0.5 transition"
                                    title={`Reproducir seguidos los ${grp.items.length} cortes de "${grp.groupTitle}"`}
                                  >
                                    <Play className="w-2.5 h-2.5 fill-current" />
                                    <span>Ver grupo</span>
                                  </button>
                                  <button
                                    onClick={() => addClipsToActivePlaylist(grp.items)}
                                    className="px-1.5 py-0.5 bg-white hover:bg-gray-200 border border-gray-300 text-gray-800 text-[10px] font-condensed font-bold uppercase transition"
                                    title="Enviar todo este grupo a la Lista de Presentación activa"
                                  >
                                    + Lista
                                  </button>
                                  <button
                                    onClick={() =>
                                      handleDownloadMergedOrAll(
                                        'single_merged',
                                        grp.items,
                                        `Grupo_${grp.groupTitle}`
                                      )
                                    }
                                    className="px-1.5 py-0.5 bg-[#cc2016] hover:bg-[#a81810] text-white text-[10px] font-condensed font-bold uppercase transition"
                                    title={`Descargar todos los cortes de "${grp.groupTitle}" unidos en un solo vídeo`}
                                  >
                                    <Download className="w-2.5 h-2.5" />
                                  </button>
                                </div>
                              </div>

                              {/* Cortes dentro de este grupo */}
                              {!isCollapsed && (
                                <div className="divide-y divide-gray-100 bg-white">
                                  {grp.items.map((ev, index) => {
                                    const isChecked = checkedClipIds.includes(ev.id);
                                    const evOutcome = getClipOutcome(ev.descriptors);
                                    return (
                                      <div
                                        key={ev.id}
                                        onClick={() => {
                                          activateClipPlayback(ev, { holdManual: true });
                                        }}
                                        className={`p-1.5 text-xs cursor-pointer transition flex flex-col gap-1 ${
                                          selectedEventId === ev.id ? 'bg-amber-50/80' : 'hover:bg-gray-50'
                                        }`}
                                      >
                                        <div className="flex items-center justify-between">
                                          <div className="flex items-center gap-1.5 min-w-0 flex-1 pr-2">
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setCheckedClipIds((prev) =>
                                                  prev.includes(ev.id)
                                                    ? prev.filter((id) => id !== ev.id)
                                                    : [...prev, ev.id]
                                                );
                                              }}
                                              className="text-gray-400 hover:text-[#cc2016]"
                                            >
                                              {isChecked ? (
                                                <CheckSquare className="w-3.5 h-3.5 text-[#cc2016]" />
                                              ) : (
                                                <Square className="w-3.5 h-3.5" />
                                              )}
                                            </button>
                                            <div className="min-w-0 flex-1">
                                              <div className="font-semibold text-gray-900 truncate flex items-center gap-1">
                                                <span className="truncate">
                                                  {index + 1}. {ev.name}
                                                </span>
                                                {ev.half && (
                                                  <span className="text-[9.5px] px-1 bg-gray-100 text-gray-600 rounded shrink-0">
                                                    {ev.half}
                                                  </span>
                                                )}
                                                {evOutcome === 'positivo' && (
                                                  <span className="text-[9px] px-1.5 py-0.2 bg-emerald-600 text-white rounded font-condensed font-bold uppercase shrink-0">
                                                    ✓ Positivo
                                                  </span>
                                                )}
                                                {evOutcome === 'negativo' && (
                                                  <span className="text-[9px] px-1.5 py-0.2 bg-[#cc2016] text-white rounded font-condensed font-bold uppercase shrink-0">
                                                    ✕ Negativo
                                                  </span>
                                                )}
                                              </div>
                                              <div className="text-[10.5px] text-gray-500 flex flex-wrap items-center gap-1.5">
                                                <span className="font-mono text-[#cc2016] font-semibold">
                                                  {formatTimecode(ev.startTime)} - {formatTimecode(ev.endTime)}
                                                </span>
                                                <span>({(ev.endTime - ev.startTime).toFixed(1)}s)</span>
                                                <span>· {ev.team}</span>
                                              </div>
                                            </div>
                                          </div>

                                          <div className="flex items-center gap-0.5 shrink-0">
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                addClipsToActivePlaylist([ev]);
                                              }}
                                              className="p-1 text-gray-400 hover:text-[#1666c0]"
                                              title="Añadir a lista de presentación"
                                            >
                                              <Plus className="w-3.5 h-3.5" />
                                            </button>
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                openEditClipModal(ev);
                                              }}
                                              className="p-1 text-gray-500 hover:text-[#cc2016]"
                                              title="Editar quién lo ha hecho, si es positivo/negativo y categoría"
                                            >
                                              <Pencil className="w-3.5 h-3.5" />
                                            </button>
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                const filtered = events.filter((item) => item.id !== ev.id);
                                                setEvents(filtered);
                                                pushHistory({ events: filtered });
                                              }}
                                              className="p-1 text-gray-400 hover:text-red-600"
                                            >
                                              <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                          </div>
                                        </div>

                                        {/* Barra rápida en cada corte para marcar POSICIÓN y CON ACIERTO / NO ACERTADA */}
                                        <div
                                          className="flex flex-wrap items-center justify-between gap-1 pl-5 pt-0.5 border-t border-gray-100"
                                          onClick={(e) => e.stopPropagation()}
                                        >
                                          <select
                                            value={ev.player || ''}
                                            onChange={(e) =>
                                              updateExistingClip(ev.id, {
                                                player: e.target.value || undefined,
                                              })
                                            }
                                            className={`px-1.5 py-0.5 rounded text-[10.5px] border transition max-w-[165px] focus:outline-none ${
                                              ev.player
                                                ? 'bg-gray-100 text-gray-900 border-gray-300 font-semibold'
                                                : 'bg-amber-50 text-amber-900 border-amber-300 font-medium'
                                            }`}
                                            title="Elegir o cambiar la posición en este corte"
                                          >
                                            <option value="">-- Marcar posición --</option>
                                            {ev.player && !allAvailablePlayers.includes(ev.player) && (
                                              <option value={ev.player}>{ev.player}</option>
                                            )}
                                            {allAvailablePlayers.map((p) => (
                                              <option key={p} value={p}>
                                                {p}
                                              </option>
                                            ))}
                                          </select>

                                          <div className="flex items-center gap-1">
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                updateExistingClip(ev.id, {
                                                  descriptors: applyOutcomeToDescriptors(
                                                    ev.descriptors,
                                                    evOutcome === 'positivo' ? 'neutro' : 'positivo'
                                                  ),
                                                });
                                              }}
                                              className={`px-1.5 py-0.5 rounded text-[10px] font-condensed font-bold uppercase border transition ${
                                                evOutcome === 'positivo'
                                                  ? 'bg-emerald-600 text-white border-emerald-700'
                                                  : 'bg-white text-emerald-700 border-gray-300 hover:bg-emerald-50'
                                              }`}
                                              title="Marcar o desmarcar como Con Éxito / Acierto"
                                            >
                                              ✓ Acierto
                                            </button>
                                            <button
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                updateExistingClip(ev.id, {
                                                  descriptors: applyOutcomeToDescriptors(
                                                    ev.descriptors,
                                                    evOutcome === 'negativo' ? 'neutro' : 'negativo'
                                                  ),
                                                });
                                              }}
                                              className={`px-1.5 py-0.5 rounded text-[10px] font-condensed font-bold uppercase border transition ${
                                                evOutcome === 'negativo'
                                                  ? 'bg-[#cc2016] text-white border-red-800'
                                                  : 'bg-white text-red-700 border-gray-300 hover:bg-red-50'
                                              }`}
                                              title="Marcar o desmarcar como Negativo / No Acertada"
                                            >
                                              ✕ No Acertada
                                            </button>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </>
                )}

                {/* Sub-pestaña: LISTAS DE PRESENTACIÓN (PLAYLISTS NACSPORT PARA CHARLAS TÉCNICAS) */}
                {eventsSubTab === 'listas' && (
                  <div className="space-y-2">
                    <div className="flex items-center gap-1">
                      <select
                        value={activePlaylistId}
                        onChange={(e) => setActivePlaylistId(e.target.value)}
                        className="flex-1 border border-gray-300 bg-gray-50 px-2 py-1.5 text-xs font-semibold text-gray-900"
                      >
                        {playlists.map((pl) => (
                          <option key={pl.id} value={pl.id}>
                            {pl.name} ({pl.clipIds.length} cortes)
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-1">
                      <input
                        type="text"
                        value={newPlaylistName}
                        onChange={(e) => setNewPlaylistName(e.target.value)}
                        placeholder="Nueva lista (ej: Informe Rival, ABP...)"
                        className="flex-1 border border-gray-300 px-2 py-1 text-xs"
                      />
                      <button
                        onClick={() => {
                          if (!newPlaylistName.trim()) return;
                          const newPl: PresentationPlaylist = {
                            id: `pl-${Date.now()}`,
                            name: newPlaylistName.trim(),
                            clipIds: [],
                            color: '#cc2016',
                            createdAt: new Date().toISOString(),
                          };
                          setPlaylists([...playlists, newPl]);
                          setActivePlaylistId(newPl.id);
                          setNewPlaylistName('');
                          notify(`Lista "${newPl.name}" creada`);
                        }}
                        className="px-2.5 py-1 bg-[#15181d] text-white text-xs font-bold"
                      >
                        Crear
                      </button>
                    </div>

                    {activePlaylist && (
                      <div className="border border-gray-200 rounded p-2 bg-gray-50 space-y-2">
                        <div className="flex items-center justify-between">
                          <span className="font-condensed font-bold text-xs uppercase text-gray-900">
                            {activePlaylist.name} ({activePlaylistClips.length} cortes)
                          </span>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => startPlayingClipQueue(activePlaylistClips)}
                              disabled={activePlaylistClips.length === 0}
                              className="px-2 py-1 bg-[#cc2016] text-white text-[10.5px] font-condensed font-bold uppercase disabled:opacity-40 flex items-center gap-1"
                            >
                              <Play className="w-2.5 h-2.5 fill-current" />
                              <span>Reproducir Lista</span>
                            </button>
                            <button
                              onClick={() =>
                                handleDownloadMergedOrAll(
                                  'single_merged',
                                  activePlaylistClips,
                                  activePlaylist.name
                                )
                              }
                              disabled={activePlaylistClips.length === 0}
                              className="px-2 py-1 bg-[#15181d] text-white text-[10.5px] font-condensed font-bold uppercase disabled:opacity-40"
                            >
                              Exportar Vídeo
                            </button>
                          </div>
                        </div>

                        <div className="max-h-[160px] overflow-y-auto space-y-1">
                          {activePlaylistClips.length === 0 ? (
                            <p className="text-[11px] text-gray-400 text-center py-4">
                              Pulsa "+ Lista" en cualquier grupo o corte de la pestaña Evento para armar tu presentación.
                            </p>
                          ) : (
                            activePlaylistClips.map((ev, idx) => (
                              <div
                                key={ev.id}
                                onClick={() => {
                                  activateClipPlayback(ev, { holdManual: true });
                                }}
                                className="bg-white border border-gray-200 p-1.5 rounded text-xs flex items-center justify-between cursor-pointer hover:bg-amber-50"
                              >
                                <div className="truncate pr-2">
                                  <span className="font-bold text-[#cc2016] mr-1">{idx + 1}.</span>
                                  <span className="font-semibold">{ev.name}</span>
                                  <span className="text-[10px] text-gray-500 ml-1.5">
                                    ({formatTimecode(ev.startTime)} - {formatTimecode(ev.endTime)})
                                  </span>
                                </div>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setPlaylists((prev) =>
                                      prev.map((p) =>
                                        p.id === activePlaylist.id
                                          ? { ...p, clipIds: p.clipIds.filter((id) => id !== ev.id) }
                                          : p
                                      )
                                    );
                                  }}
                                  className="text-gray-400 hover:text-red-600"
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Sub-pestaña: CAPTURAS */}
                {eventsSubTab === 'capturas' && (
                  <div className="max-h-[210px] overflow-y-auto">
                    {captures.length === 0 ? (
                      <div className="h-[85px] border border-dashed border-gray-200 rounded flex flex-col items-center justify-center text-center p-2 text-gray-400 text-xs">
                        <span>No hay capturas guardadas todavía.</span>
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 gap-2">
                        {captures.map((cap) => (
                          <div key={cap.id} className="border border-gray-200 rounded overflow-hidden bg-gray-50">
                            <img src={cap.dataUrl} alt={cap.name} className="w-full h-16 object-cover" />
                            <div className="p-1 flex items-center justify-between text-[10px]">
                              <span className="truncate font-medium">{cap.name}</span>
                              <div className="flex items-center gap-1">
                                <a
                                  href={cap.dataUrl}
                                  download={`${cap.name.replace(/\s+/g, '_')}.png`}
                                  className="text-[#1666c0]"
                                >
                                  <Download className="w-3 h-3" />
                                </a>
                                <button
                                  onClick={() => setCaptures(captures.filter((c) => c.id !== cap.id))}
                                  className="text-gray-400 hover:text-red-600"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* 3. SECCIÓN EXPORTACIÓN */}
          <div className="p-3 border-b border-gray-200">
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 bg-[#cc2016] inline-block" />
                <h2 className="font-condensed font-bold text-[15px] tracking-wider uppercase text-[#141414]">
                  EXPORTACIÓN
                </h2>
              </div>
              <button
                onClick={() => setHideExportPanel((prev) => !prev)}
                className="w-[84px] h-[28px] bg-[#1666c0] hover:bg-[#1255a1] text-white text-xs font-semibold transition flex items-center justify-center"
              >
                {hideExportPanel ? 'Mostrar' : 'Ocultar'}
              </button>
            </div>

            {!hideExportPanel && (
              <div className="space-y-2">
                <div className="grid grid-cols-3 gap-2">
                  <select
                    value={exportResolution}
                    onChange={(e) => setExportResolution(e.target.value as any)}
                    className="border border-gray-300 bg-[#f2f2f2] px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none"
                  >
                    <option value="720p">720p</option>
                    <option value="1080p">1080p</option>
                    <option value="480p">480p</option>
                  </select>
                  <select
                    value={exportFps}
                    onChange={(e) => setExportFps(e.target.value as any)}
                    className="col-span-2 border border-gray-300 bg-[#f2f2f2] px-2.5 py-1.5 text-xs text-gray-800 focus:outline-none"
                  >
                    <option value="30 fps">30 fps</option>
                    <option value="60 fps">60 fps</option>
                    <option value="25 fps">25 fps</option>
                  </select>
                </div>

                <input
                  type="text"
                  value={exportFileName}
                  onChange={(e) => setExportFileName(e.target.value)}
                  placeholder="Pon el nombre del video"
                  className="w-full border border-gray-200 bg-[#f2f2f2] px-3 py-2 text-xs text-gray-800 focus:outline-none focus:border-gray-400"
                />

                {isExporting && (
                  <div className="text-xs text-[#cc2016] font-semibold animate-pulse py-1">
                    {exportProgressText || 'Procesando exportación de vídeo...'}
                  </div>
                )}

                <button
                  onClick={() => handleDownloadMergedOrAll('single_merged')}
                  disabled={isExporting}
                  className="w-full py-2.5 bg-[#141414] hover:bg-[#292929] text-white font-condensed font-bold text-[13px] tracking-wider uppercase transition disabled:opacity-50"
                >
                  DESCARGA EN UN VIDEO
                </button>

                <button
                  onClick={() => handleDownloadMergedOrAll('one_by_one')}
                  disabled={isExporting}
                  className="w-full py-2 bg-white hover:bg-gray-100 border border-gray-400 text-[#141414] text-xs font-medium transition disabled:opacity-50"
                >
                  Descargar uno a uno
                </button>

                {/* Botones de interoperabilidad profesional con Nacsport / LongoMatch / Excel */}
                <div className="grid grid-cols-2 gap-1.5 pt-1">
                  <button
                    onClick={() => exportEventsToCSV(exportFileName || projectName)}
                    className="py-1.5 px-2 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 text-emerald-900 text-[11px] font-semibold flex items-center justify-center gap-1 transition"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" />
                    <span>Exportar CSV Excel</span>
                  </button>
                  <button
                    onClick={exportEventsToNacsportXML}
                    className="py-1.5 px-2 bg-blue-50 hover:bg-blue-100 border border-blue-300 text-blue-900 text-[11px] font-semibold flex items-center justify-center gap-1 transition"
                    title="Exporta archivo XML estándar compatible con Nacsport, Sportscode y LongoMatch"
                  >
                    <Code className="w-3.5 h-3.5" />
                    <span>XML Nacsport</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* =====================================================================
              4. SECCIÓN PINTADO DE ACCIONES + KLIPDRAW PRO
             ===================================================================== */}
          <div className="p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 bg-[#cc2016] inline-block" />
                <h2 className="font-condensed font-bold text-[15px] tracking-wider uppercase text-[#141414]">
                  PINTADO DE ACCIONES
                </h2>
              </div>

              <div className="flex flex-col items-end gap-1">
                <button
                  onClick={() => {
                    resetTrackerState();
                    setDrawings([]);
                    setSelectedDrawingId(null);
                    setMultiPointDraft(null);
                    pushHistory({ drawings: [] });
                    notify('Todos los pintados han sido limpiados');
                  }}
                  className="w-[84px] h-[28px] bg-white hover:bg-gray-100 border border-gray-200 text-gray-800 text-xs font-medium flex items-center justify-center"
                >
                  Limpiar
                </button>
                <button
                  onClick={() => setHideDrawingPanel((prev) => !prev)}
                  className="w-[84px] h-[28px] bg-[#1666c0] hover:bg-[#1255a1] text-white text-xs font-semibold transition flex items-center justify-center"
                >
                  {hideDrawingPanel ? 'Mostrar' : 'Ocultar'}
                </button>
              </div>
            </div>

            {!hideDrawingPanel && (
              <div className="space-y-2.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => {
                      const next = !drawingMode;
                      setDrawingMode(next);
                      if (next && videoRef.current && !videoRef.current.paused) {
                        videoRef.current.pause();
                        setIsPlaying(false);
                      }
                    }}
                    className={`px-2.5 py-1.5 border text-xs font-medium transition ${
                      drawingMode
                        ? 'bg-[#cc2016] border-[#cc2016] text-white font-semibold'
                        : 'bg-white hover:bg-gray-50 border-gray-200 text-gray-800'
                    }`}
                  >
                    {drawingMode ? 'Dibujo: encendido' : 'Dibujo: apagado'}
                  </button>

                  <button
                    onClick={handleUndo}
                    className="px-2.5 py-1.5 bg-white hover:bg-gray-50 border border-gray-200 text-gray-800 text-xs font-medium"
                  >
                    Deshacer
                  </button>

                  <button
                    onClick={handleRedo}
                    className="px-2.5 py-1.5 bg-white hover:bg-gray-50 border border-gray-200 text-gray-800 text-xs font-medium"
                  >
                    Rehacer
                  </button>

                  <button
                    onClick={handleExportPNG}
                    className="px-2.5 py-1.5 bg-white hover:bg-gray-50 border border-gray-200 text-gray-800 text-xs font-medium flex items-center gap-1.5"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Exportar PNG</span>
                  </button>
                </div>

                {/* Opciones de inserción del dibujo: Imagen Parada (sin que corra el vídeo) vs Vídeo Corriendo */}
                <div className="p-2 bg-gray-50 border border-gray-200 space-y-1.5">
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => handleInsertPaintedFrameInVideo('imagen_parada')}
                      className={`flex-1 px-2.5 py-1.5 border text-xs font-semibold transition flex items-center justify-center gap-1.5 ${
                        drawings.length > 0
                          ? 'bg-[#cc2016] hover:bg-[#b01b12] border-[#cc2016] text-white shadow-sm'
                          : 'bg-[#15181d] hover:bg-[#252a32] border-[#15181d] text-white'
                      }`}
                      title="Congela el fotograma actual y mantiene el vídeo totalmente parado mostrando la imagen pintada"
                    >
                      <Pause className="w-3.5 h-3.5 fill-current shrink-0" />
                      <span>
                        Insertar imagen parada ({insertFreezeSeconds === 0 ? 'Pausa fija' : `${insertFreezeSeconds} s`})
                      </span>
                    </button>

                    <select
                      value={insertFreezeSeconds}
                      onChange={(e) => setInsertFreezeSeconds(Number(e.target.value))}
                      className="border border-gray-300 bg-white px-1.5 py-1.5 text-[11px] font-semibold text-gray-800 focus:outline-none"
                      title="Duración de la imagen parada en el vídeo"
                    >
                      <option value={0}>Pausa fija</option>
                      <option value={3}>3 s parada</option>
                      <option value={5}>5 s parada</option>
                      <option value={8}>8 s parada</option>
                      <option value={10}>10 s parada</option>
                    </select>
                  </div>

                  <button
                    onClick={() => handleInsertPaintedFrameInVideo('video_corriendo')}
                    className="w-full px-2.5 py-1.5 bg-white hover:bg-gray-100 border border-gray-300 text-gray-800 text-xs font-semibold transition flex items-center justify-center gap-1.5"
                    title="Inserta el dibujo mientras el vídeo sigue corriendo siguiendo a los jugadores marcados"
                  >
                    <Play className="w-3.5 h-3.5 fill-current text-[#cc2016] shrink-0" />
                    <span>
                      Insertar con vídeo corriendo ({visibleDuration === 0 ? 'Todo' : `${visibleDuration} s`})
                    </span>
                  </button>

                  <div className="flex items-center justify-between pt-1 border-t border-gray-200 text-[11px]">
                    <span className="text-gray-600 font-medium">
                      Conector / Foco en vídeo:
                    </span>
                    <button
                      onClick={() => {
                        const nextVal = !trackPlayersMode;
                        setTrackPlayersMode(nextVal);
                        if (selectedDrawingId) {
                          updateSelectedDrawingStyle({ trackPlayers: nextVal });
                        }
                        notify(
                          nextVal
                            ? 'Seguimiento de jugadores activado: el conector y el foco siguen a los jugadores'
                            : 'Seguimiento desactivado: el dibujo permanecerá en posición fija'
                        );
                      }}
                      className={`px-2 py-0.5 rounded-sm font-semibold border transition ${
                        trackPlayersMode
                          ? 'bg-emerald-600 border-emerald-700 text-white'
                          : 'bg-gray-200 border-gray-300 text-gray-700'
                      }`}
                      title="Activa o desactiva que el Conector, Foco, Radar, Orientación, etc. sigan automáticamente a los jugadores en el vídeo"
                    >
                      {trackPlayersMode ? 'Seguir jugadores: SÍ' : 'Posición fija'}
                    </button>
                  </div>
                </div>

                <div className="border border-gray-200 border-t-[3px] border-t-[#15181d] bg-white p-2.5 space-y-3">
                  <div className="grid grid-cols-5 gap-1.5">
                    <button
                      onClick={() => {
                        setDrawingMode(true);
                        setIsMoveMode((m) => !m);
                      }}
                      className={`min-h-[58px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11px] transition ${
                        isMoveMode && drawingMode
                          ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                          : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                      }`}
                    >
                      <Move className="w-5 h-5 stroke-[1.7]" />
                      <span>Mover</span>
                    </button>

                    <button
                      onClick={handleEditSelectedDrawing}
                      className="min-h-[58px] p-1.5 border border-gray-200 hover:border-gray-800 text-gray-800 bg-white flex flex-col items-center justify-center gap-1 text-[11px] transition"
                    >
                      <Pencil className="w-5 h-5 stroke-[1.7]" />
                      <span>Editar</span>
                    </button>

                    <button
                      onClick={handleDeleteSelectedDrawing}
                      className="min-h-[58px] p-1.5 border border-gray-200 hover:border-[#cc2016] hover:text-[#cc2016] text-gray-800 bg-white flex flex-col items-center justify-center gap-1 text-[11px] transition"
                    >
                      <Trash2 className="w-5 h-5 stroke-[1.7]" />
                      <span>Papelera</span>
                    </button>

                    <button
                      onClick={handleDuplicateSelectedDrawing}
                      className="min-h-[58px] p-1.5 border border-gray-200 hover:border-gray-800 text-gray-800 bg-white flex flex-col items-center justify-center gap-1 text-[11px] transition"
                    >
                      <Copy className="w-5 h-5 stroke-[1.7]" />
                      <span>Duplicar</span>
                    </button>

                    <button
                      onClick={handleRotateSelectedDrawing}
                      className="min-h-[58px] p-1.5 border border-gray-200 hover:border-gray-800 text-gray-800 bg-white flex flex-col items-center justify-center gap-1 text-[11px] transition"
                    >
                      <RotateCw className="w-5 h-5 stroke-[1.7]" />
                      <span>Rotar</span>
                    </button>

                    <button
                      onClick={handleBringToFront}
                      className="min-h-[58px] p-1.5 border border-gray-200 hover:border-gray-800 text-gray-800 bg-white flex flex-col items-center justify-center gap-1 text-[11px] transition"
                    >
                      <BringToFront className="w-5 h-5 stroke-[1.7]" />
                      <span>Delante</span>
                    </button>

                    <button
                      onClick={handleSendToBack}
                      className="min-h-[58px] p-1.5 border border-gray-200 hover:border-gray-800 text-gray-800 bg-white flex flex-col items-center justify-center gap-1 text-[11px] transition"
                    >
                      <SendToBack className="w-5 h-5 stroke-[1.7]" />
                      <span>Detrás</span>
                    </button>
                  </div>

                  {/* SECCIÓN: ■ FLECHAS */}
                  <div className="pt-2 border-t border-gray-200">
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className="w-1.5 h-1.5 bg-[#cc2016] inline-block" />
                      <span className="font-condensed font-bold text-xs tracking-wider uppercase text-[#15181d]">
                        FLECHAS
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <button
                        onClick={() => selectToolAndActivate('flecha_curva')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'flecha_curva' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M4 18C6 9 13 6 20 8" strokeLinecap="round" />
                          <path d="M16 4l4 4-4 3" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span>Curva</span>
                      </button>

                      <button
                        onClick={() => selectToolAndActivate('flecha_recta')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'flecha_recta' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M5 16L19 8" strokeLinecap="round" />
                          <path d="M14 7l5 1-2 5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span>Recta</span>
                      </button>

                      <button
                        onClick={() => selectToolAndActivate('flecha_libre')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'flecha_libre' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <path d="M3 15c3-5 6 5 9 0s5-5 8-2" strokeLinecap="round" />
                          <path d="M17 10l3 3-4 2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span>Libre</span>
                      </button>
                    </div>
                  </div>

                  {/* SECCIÓN: ■ TEXTOS */}
                  <div className="pt-2 border-t border-gray-200">
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className="w-1.5 h-1.5 bg-[#cc2016] inline-block" />
                      <span className="font-condensed font-bold text-xs tracking-wider uppercase text-[#15181d]">
                        TEXTOS
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-1.5">
                      <button
                        onClick={() => selectToolAndActivate('texto')}
                        className={`min-h-[58px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'texto' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <Type className="w-5 h-5 stroke-[1.8]" />
                        <span>Texto</span>
                      </button>

                      <button
                        onClick={() => selectToolAndActivate('etiqueta')}
                        className={`min-h-[58px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'etiqueta' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <Tag className="w-5 h-5 stroke-[1.8]" />
                        <span>Etiqueta</span>
                      </button>
                    </div>
                  </div>

                  {/* SECCIÓN: ■ ZONAS */}
                  <div className="pt-2 border-t border-gray-200">
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className="w-1.5 h-1.5 bg-[#cc2016] inline-block" />
                      <span className="font-condensed font-bold text-xs tracking-wider uppercase text-[#15181d]">
                        ZONAS
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <button
                        onClick={() => selectToolAndActivate('rectangulo')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'rectangulo' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <rect x="4" y="6" width="16" height="12" rx="1" />
                          <path d="M7 15l4-4 6 4" strokeOpacity="0.6" />
                        </svg>
                        <span>Recta.</span>
                      </button>

                      <button
                        onClick={() => selectToolAndActivate('circulo')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'circulo' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <circle cx="12" cy="12" r="7" />
                        </svg>
                        <span>Círculo</span>
                      </button>

                      <button
                        onClick={() => selectToolAndActivate('zona_elipse')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'zona_elipse' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                          <ellipse cx="12" cy="12" rx="8" ry="4.5" />
                          <path d="M12 7.5v9" strokeDasharray="2 2" />
                        </svg>
                        <span>Zona</span>
                      </button>

                      <button
                        onClick={() => selectToolAndActivate('triangulo')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'triangulo' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <Triangle className="w-5 h-5 stroke-[1.8]" />
                        <span>Triángulo</span>
                      </button>

                      <button
                        onClick={() => selectToolAndActivate('zona_libre')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'zona_libre' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <Hexagon className="w-5 h-5 stroke-[1.8]" />
                        <span>Zona libre</span>
                      </button>
                    </div>
                  </div>

                  {/* SECCIÓN: ■ VARIOS Y HERRAMIENTAS KLIPDRAW PRO */}
                  <div className="pt-2 border-t border-gray-200">
                    <div className="flex items-center gap-1.5 mb-2">
                      <span className="w-1.5 h-1.5 bg-[#cc2016] inline-block" />
                      <span className="font-condensed font-bold text-xs tracking-wider uppercase text-[#15181d]">
                        VARIOS + KLIPDRAW PRO
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <button
                        onClick={() => selectToolAndActivate('conector')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'conector' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <Share2 className="w-5 h-5 stroke-[1.8]" />
                        <span>Conector</span>
                      </button>

                      <button
                        onClick={() => selectToolAndActivate('foco')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'foco' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <Cone className="w-5 h-5 stroke-[1.8]" />
                        <span>Foco</span>
                      </button>

                      <button
                        onClick={() => selectToolAndActivate('orientacion')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'orientacion' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <Compass className="w-5 h-5 stroke-[1.8]" />
                        <span>Orientación</span>
                      </button>

                      {/* Herramientas específicas estilo KlipDraw */}
                      <button
                        onClick={() => selectToolAndActivate('klip_tracking')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11px] transition ${
                          activeTool === 'klip_tracking' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                        title="KlipDraw Tracking: Estela luminosa de movimiento con anillo de origen y destino"
                      >
                        <Footprints className="w-5 h-5 stroke-[1.8]" />
                        <span>Estela Klip</span>
                      </button>

                      <button
                        onClick={() => selectToolAndActivate('klip_radar')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11px] transition ${
                          activeTool === 'klip_radar' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                        title="KlipDraw Anillo 3D multicapa para resaltar al poseedor o jugador clave"
                      >
                        <Radar className="w-5 h-5 stroke-[1.8]" />
                        <span>Anillo 3D</span>
                      </button>

                      <button
                        onClick={() => selectToolAndActivate('klip_sombra')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11px] transition ${
                          activeTool === 'klip_sombra' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                        title="KlipDraw Sombra de Cobertura Defensiva (Cover Shadow)"
                      >
                        <ShieldAlert className="w-5 h-5 stroke-[1.8]" />
                        <span>Sombra Def.</span>
                      </button>

                      <button
                        onClick={() => selectToolAndActivate('lupa')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'lupa' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <Search className="w-5 h-5 stroke-[1.8]" />
                        <span>Lupa Zoom</span>
                      </button>

                      <button
                        onClick={() => selectToolAndActivate('distancia')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'distancia' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <Ruler className="w-5 h-5 stroke-[1.8]" />
                        <span>Distancia (m)</span>
                      </button>

                      <button
                        onClick={() => selectToolAndActivate('escudo_seneca')}
                        className={`min-h-[60px] p-1.5 border flex flex-col items-center justify-center gap-1 text-[11.5px] transition ${
                          activeTool === 'escudo_seneca' && drawingMode && !isMoveMode
                            ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5 shadow-[inset_0_-3px_0_#cc2016] font-semibold'
                            : 'border-gray-200 hover:border-gray-800 text-gray-800 bg-white'
                        }`}
                      >
                        <Shield className="w-5 h-5 stroke-[1.8]" />
                        <span>Escudo CF</span>
                      </button>
                    </div>

                    {multiPointDraft && (
                      <button
                        onClick={handleCanvasDoubleClick}
                        className="mt-2 w-full py-1.5 bg-[#cc2016] text-white text-xs font-bold uppercase rounded shadow"
                      >
                        Cerrar y terminar {multiPointDraft.tool === 'conector' ? 'Conector' : 'Zona libre'} (
                        {multiPointDraft.points.length} ptos)
                      </button>
                    )}
                  </div>

                  {/* SECCIÓN: ■ NÚMEROS Y JUGADORES */}
                  <div className="pt-2 border-t border-gray-200">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 bg-[#cc2016] inline-block" />
                        <span className="font-condensed font-bold text-xs tracking-wider uppercase text-[#15181d]">
                          NÚMEROS Y JUGADORES
                        </span>
                      </div>
                      <button
                        onClick={() => setShowNumbersPlayersSection((prev) => !prev)}
                        className="w-[84px] h-[28px] bg-[#1666c0] hover:bg-[#1255a1] text-white text-xs font-semibold transition flex items-center justify-center"
                      >
                        {showNumbersPlayersSection ? 'Ocultar' : 'Mostrar'}
                      </button>
                    </div>

                    {showNumbersPlayersSection && (
                      <div className="mt-2.5 space-y-2">
                        <div className="grid grid-cols-2 gap-1.5 max-h-[180px] overflow-y-auto">
                          {rosterPlayers.map((rp) => (
                            <button
                              key={rp.id}
                              onClick={() => {
                                setActiveRosterPlayer(rp);
                                selectToolAndActivate('jugador_ficha');
                              }}
                              className={`p-1.5 border text-center transition flex flex-col items-center justify-center ${
                                activeTool === 'jugador_ficha' && activeRosterPlayer?.id === rp.id
                                  ? 'border-[#cc2016] bg-[#cc2016]/10 shadow-[inset_0_-3px_0_#cc2016]'
                                  : 'border-gray-200 hover:border-gray-800 bg-white'
                              }`}
                            >
                              <b className="font-condensed text-base text-[#cc2016] leading-none">{rp.dorsal}</b>
                              <small className="text-[10px] font-semibold text-gray-600 uppercase truncate max-w-full mt-0.5">
                                {rp.name}
                              </small>
                            </button>
                          ))}
                        </div>

                        <div className="flex items-center gap-1 pt-1">
                          <input
                            type="text"
                            value={newPlayerDorsal}
                            onChange={(e) => setNewPlayerDorsal(e.target.value)}
                            placeholder="Nº"
                            className="w-12 border border-gray-300 px-1.5 py-1 text-xs text-center font-bold"
                          />
                          <input
                            type="text"
                            value={newPlayerName}
                            onChange={(e) => setNewPlayerName(e.target.value)}
                            placeholder="Nombre del jugador..."
                            className="flex-1 border border-gray-300 px-2 py-1 text-xs"
                          />
                          <button
                            onClick={() => {
                              if (!newPlayerDorsal.trim() && !newPlayerName.trim()) return;
                              const added: RosterPlayerItem = {
                                id: `rp-${Date.now()}`,
                                dorsal: newPlayerDorsal.trim() || String(rosterPlayers.length + 1),
                                name: (newPlayerName.trim() || 'JUGADOR').toUpperCase(),
                                team: 'Séneca CF',
                              };
                              setRosterPlayers([...rosterPlayers, added]);
                              setActiveRosterPlayer(added);
                              setNewPlayerDorsal('');
                              setNewPlayerName('');
                              selectToolAndActivate('jugador_ficha');
                            }}
                            className="px-2.5 py-1 bg-[#141414] text-white text-xs font-bold"
                          >
                            +
                          </button>
                        </div>

                        <button
                          onClick={() => selectToolAndActivate('balon')}
                          className={`w-full py-1.5 border text-xs font-semibold flex items-center justify-center gap-1.5 ${
                            activeTool === 'balon' && drawingMode
                              ? 'border-[#cc2016] text-[#cc2016] bg-[#cc2016]/5'
                              : 'border-gray-200 text-gray-700 bg-gray-50 hover:bg-gray-100'
                          }`}
                        >
                          <CircleDot className="w-3.5 h-3.5" />
                          <span>Colocar icono de Balón</span>
                        </button>
                      </div>
                    )}
                  </div>

                  {/* SECCIÓN: ■ ESTILO GENERAL */}
                  <div className="pt-2 border-t border-gray-200">
                    <div className="flex items-center justify-between mb-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 bg-[#cc2016] inline-block" />
                        <span className="font-condensed font-bold text-xs tracking-wider uppercase text-[#15181d]">
                          ESTILO GENERAL
                        </span>
                      </div>
                      <button
                        onClick={() => setHideGeneralStyleSection((prev) => !prev)}
                        className="w-[84px] h-[28px] bg-[#1666c0] hover:bg-[#1255a1] text-white text-xs font-semibold transition flex items-center justify-center"
                      >
                        {hideGeneralStyleSection ? 'Mostrar' : 'Ocultar'}
                      </button>
                    </div>

                    {!hideGeneralStyleSection && (
                      <div className="space-y-2.5 text-xs">
                        <div className="grid grid-cols-[96px_1fr] items-center gap-2">
                          <span className="text-gray-500">Color</span>
                          <input
                            type="color"
                            value={strokeColor}
                            onChange={(e) => {
                              setStrokeColor(e.target.value);
                              updateSelectedDrawingStyle({ color: e.target.value });
                            }}
                            className="w-full h-[30px] p-0.5 border border-gray-200 bg-white cursor-pointer"
                          />
                        </div>

                        <div className="grid grid-cols-[96px_1fr] items-center gap-2">
                          <span className="text-gray-500">Relleno</span>
                          <input
                            type="color"
                            value={fillColor}
                            onChange={(e) => {
                              setFillColor(e.target.value);
                              updateSelectedDrawingStyle({ fillColor: e.target.value });
                            }}
                            className="w-full h-[30px] p-0.5 border border-gray-200 bg-white cursor-pointer"
                          />
                        </div>

                        <div className="grid grid-cols-[96px_1fr] items-center gap-2">
                          <span className="text-gray-500">Grosor</span>
                          <input
                            type="range"
                            min={1}
                            max={14}
                            value={strokeWidth}
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              setStrokeWidth(val);
                              updateSelectedDrawingStyle({ lineWidth: val });
                            }}
                            className="w-full accent-[#d3291e] cursor-pointer"
                          />
                        </div>

                        <div className="grid grid-cols-[96px_1fr] items-center gap-2">
                          <span className="text-gray-500">Línea</span>
                          <div className="grid grid-cols-2 gap-1.5">
                            <button
                              onClick={() => {
                                setLineStyle('solid');
                                updateSelectedDrawingStyle({ lineStyle: 'solid' });
                              }}
                              className={`h-[30px] border flex items-center justify-center px-3 transition ${
                                lineStyle === 'solid'
                                  ? 'border-[#d3291e] text-[#d3291e] bg-white'
                                  : 'border-gray-200 text-gray-800 bg-white hover:border-gray-400'
                              }`}
                            >
                              <div className="w-8 h-[3px] bg-current rounded-full" />
                            </button>

                            <button
                              onClick={() => {
                                setLineStyle('dashed');
                                updateSelectedDrawingStyle({ lineStyle: 'dashed' });
                              }}
                              className={`h-[30px] border flex items-center justify-center px-3 transition ${
                                lineStyle === 'dashed'
                                  ? 'border-[#d3291e] text-[#d3291e] bg-white'
                                  : 'border-gray-200 text-gray-800 bg-white hover:border-gray-400'
                              }`}
                            >
                              <div className="w-8 border-b-[3px] border-dashed border-current" />
                            </button>
                          </div>
                        </div>

                        <div className="grid grid-cols-[96px_1fr] items-center gap-2">
                          <span className="text-gray-500">
                            Tamaño <strong className="text-gray-900">{shapeScale}%</strong>
                          </span>
                          <input
                            type="range"
                            min={50}
                            max={200}
                            step={5}
                            value={shapeScale}
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              setShapeScale(val);
                              updateSelectedDrawingStyle({ scale: val });
                            }}
                            className="w-full accent-[#d3291e] cursor-pointer"
                          />
                        </div>

                        <div className="grid grid-cols-[96px_1fr] items-center gap-2">
                          <span className="text-gray-500 leading-tight">
                            Transparencia <strong className="text-gray-900 block">{shapeOpacity}%</strong>
                          </span>
                          <input
                            type="range"
                            min={15}
                            max={100}
                            step={5}
                            value={shapeOpacity}
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              setShapeOpacity(val);
                              updateSelectedDrawingStyle({ opacity: val });
                            }}
                            className="w-full accent-[#d3291e] cursor-pointer"
                          />
                        </div>

                        <div className="grid grid-cols-[96px_1fr] items-center gap-2">
                          <span className="text-gray-500">Visible durante</span>
                          <select
                            value={visibleDuration}
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              setVisibleDuration(val);
                              updateSelectedDrawingStyle({ visibleDuration: val });
                            }}
                            className="w-full border border-gray-200 bg-white px-2 py-1.5 text-xs text-gray-800 focus:outline-none"
                          >
                            <option value={3}>3 s</option>
                            <option value={5}>5 s</option>
                            <option value={8}>8 s</option>
                            <option value={10}>10 s</option>
                            <option value={15}>15 s</option>
                            <option value={0}>Todo el vídeo</option>
                          </select>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </aside>
        )}
      </div>

      {/* =====================================================================
          PIE DE PÁGINA EN PANTALLA COMPLETA: TIRA DE EVENTOS RECIENTES EN DIRECTO
         ===================================================================== */}
      {isBotoneraFullscreen && (
        <footer className="h-[46px] bg-[#141720] border-t border-[#252936] px-3 flex items-center justify-between shrink-0 text-xs z-40">
          <div className="flex items-center gap-2 overflow-x-auto py-1 max-w-[85%]">
            <span className="font-condensed font-bold text-gray-400 uppercase text-[11px] shrink-0 flex items-center gap-1">
              <Activity className="w-3.5 h-3.5 text-[#f5b800]" />
              Últimos Registros ({events.length}):
            </span>
            {events.length === 0 ? (
              <span className="text-gray-500 text-[11px] italic">
                No hay acciones registradas aún. Haz clic en cualquier botón de la botonera o pulsa su tecla rápida.
              </span>
            ) : (
              events.slice(-6).reverse().map((ev) => {
                const outcome = getClipOutcome(ev.descriptors);
                return (
                  <div
                    key={ev.id}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded border text-[11px] shrink-0 bg-[#1c202c] ${
                      lastDirectTaggedClipId === ev.id
                        ? 'border-[#f5b800] ring-1 ring-[#f5b800]'
                        : 'border-gray-700'
                    }`}
                  >
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ backgroundColor: ev.color }}
                    />
                    <span className="font-bold text-white max-w-[120px] truncate">{ev.name}</span>
                    <span className="text-gray-400 font-mono text-[10px]">
                      {formatTimecode(ev.startTime)}
                    </span>
                    {ev.team && (
                      <span
                        className={`px-1 py-0.2 rounded text-[9px] font-bold ${
                          ev.team === 'Séneca CF' ? 'bg-[#cc2016] text-white' : 'bg-blue-600 text-white'
                        }`}
                      >
                        {ev.team === 'Séneca CF' ? 'SÉN' : 'RIV'}
                      </span>
                    )}
                    {ev.player && (
                      <span className="text-gray-300 text-[10px] font-medium truncate max-w-[80px]">
                        {ev.player}
                      </span>
                    )}
                    {outcome !== 'neutro' && (
                      <span
                        className={`px-1 py-0.2 rounded text-[9px] font-bold ${
                          outcome === 'positivo' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
                        }`}
                      >
                        {outcome === 'positivo' ? '✓' : '✕'}
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteClip(ev.id);
                      }}
                      className="ml-1 text-gray-400 hover:text-red-400 transition"
                      title="Eliminar este corte recién registrado"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => exitBotoneraFullscreen()}
              className="px-2.5 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white rounded text-[11px] font-condensed font-bold uppercase transition flex items-center gap-1"
              title="Salir del modo pantalla completa (o pulsa tecla ESC)"
            >
              <Minimize2 className="w-3 h-3" />
              <span>Salir (ESC)</span>
            </button>
          </div>
        </footer>
      )}

      {/* =====================================================================
          MODAL: MATRIZ DE DATOS NACSPORT (POSICIONES, ACIERTO / NO ACERTADAS Y CATEGORÍAS)
         ===================================================================== */}
      {showMatrixModal && (
        <div className="fixed inset-0 bg-black/65 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-6xl w-full p-5 shadow-2xl border-t-4 border-[#cc2016] max-h-[92vh] flex flex-col">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-gray-200 mb-3 shrink-0">
              <div className="flex items-center gap-2.5">
                <img src="/seneca-shield.jpg" alt="Séneca CF" className="w-8 h-8 object-contain" />
                <div>
                  <h3 className="font-condensed font-bold text-lg uppercase text-gray-900">
                    MATRIZ DE DATOS NACSPORT - POSICIONES (CON ACIERTO / NO ACERTADAS) Y CATEGORÍAS
                  </h3>
                  <p className="text-xs text-gray-500">
                    Haz clic en cualquier número o posición para reproducir al instante los cortes con acierto, no acertados o por demarcación
                  </p>
                </div>
              </div>
              <button onClick={() => setShowMatrixModal(false)} className="text-gray-400 hover:text-gray-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Pestañas de vista de la Matriz */}
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3 shrink-0">
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => setMatrixViewMode('completa')}
                  className={`px-3 py-1.5 rounded text-xs font-condensed font-bold uppercase transition ${
                    matrixViewMode === 'completa'
                      ? 'bg-[#cc2016] text-white shadow-sm'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Vista Completa (Posiciones + Categorías)
                </button>
                <button
                  onClick={() => setMatrixViewMode('posiciones')}
                  className={`px-3 py-1.5 rounded text-xs font-condensed font-bold uppercase transition ${
                    matrixViewMode === 'posiciones'
                      ? 'bg-[#cc2016] text-white shadow-sm'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Matriz por Posiciones (✓ Acierto / ✕ No Acertadas)
                </button>
                <button
                  onClick={() => setMatrixViewMode('categorias')}
                  className={`px-3 py-1.5 rounded text-xs font-condensed font-bold uppercase transition ${
                    matrixViewMode === 'categorias'
                      ? 'bg-[#cc2016] text-white shadow-sm'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Matriz por Categorías
                </button>
                <button
                  onClick={() => setMatrixViewMode('cruce')}
                  className={`px-3 py-1.5 rounded text-xs font-condensed font-bold uppercase transition ${
                    matrixViewMode === 'cruce'
                      ? 'bg-[#cc2016] text-white shadow-sm'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Cruce Categoría × Posición
                </button>
              </div>

              {/* Resumen global rápido */}
              <div className="flex items-center gap-2 text-xs">
                <span className="px-2.5 py-1 rounded bg-emerald-50 border border-emerald-200 text-emerald-800 font-bold">
                  ✓ Con Acierto: {events.filter((e) => getClipOutcome(e.descriptors) === 'positivo').length}
                </span>
                <span className="px-2.5 py-1 rounded bg-red-50 border border-red-200 text-red-800 font-bold">
                  ✕ No Acertadas: {events.filter((e) => getClipOutcome(e.descriptors) === 'negativo').length}
                </span>
                <span className="px-2.5 py-1 rounded bg-gray-100 border border-gray-300 text-gray-700 font-bold">
                  Total Cortes: {events.length}
                </span>
              </div>
            </div>

            <div className="overflow-auto flex-1 space-y-5 pr-1">
              {/* =================================================================
                  BLOQUE 1: MATRIZ POR POSICIONES (CON ACIERTO vs NO ACERTADAS)
                 ================================================================= */}
              {(matrixViewMode === 'completa' || matrixViewMode === 'posiciones') && (() => {
                const extraPositionsInEvents = Array.from(
                  new Set(
                    events
                      .map((e) => (e.player || '').trim())
                      .filter((p) => p !== '' && !allAvailablePlayers.includes(p))
                  )
                );
                const positionRows = [...allAvailablePlayers, ...extraPositionsInEvents];
                const unassignedClips = events.filter((e) => !e.player || !e.player.trim());

                const renderOutcomePlayCell = (clips: ClipEvent[], badgeColor: string, labelPrefix?: string) => (
                  <td className="p-2 border border-gray-200 text-center">
                    {clips.length > 0 ? (
                      <button
                        onClick={() => {
                          setShowMatrixModal(false);
                          startPlayingClipQueue(clips);
                        }}
                        style={{ backgroundColor: badgeColor }}
                        className="px-3 py-1 rounded text-white font-bold hover:opacity-90 transition inline-flex items-center gap-1 shadow-sm"
                        title="Haz clic para reproducir estos cortes en vídeo"
                      >
                        <Play className="w-3 h-3 fill-current" />
                        <span>
                          {labelPrefix ? `${labelPrefix} ` : ''}
                          {clips.length}
                        </span>
                      </button>
                    ) : (
                      <span className="text-gray-300">0</span>
                    )}
                  </td>
                );

                return (
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="font-condensed font-bold text-sm uppercase tracking-wider text-gray-900 flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-sm bg-[#cc2016]" />
                        <span>MATRIZ POR POSICIONES — ACCIONES CON ACIERTO (ÉXITO) Y NO ACERTADAS (NEGATIVO)</span>
                      </h4>
                      <span className="text-[11px] text-gray-500">
                        Pulsa en ✓ Con Acierto o ✕ No Acertadas de cualquier posición para ver sus cortes
                      </span>
                    </div>

                    <table className="w-full border-collapse text-xs">
                      <thead>
                        <tr className="bg-[#15181d] text-white font-condensed uppercase text-sm tracking-wider">
                          <th className="p-2.5 text-left border border-gray-700">Posición / Demarcación</th>
                          <th className="p-2.5 text-center border border-gray-700 bg-emerald-700">
                            ✓ Con Acierto (Éxito)
                          </th>
                          <th className="p-2.5 text-center border border-gray-700 bg-[#cc2016]">
                            ✕ No Acertadas (Negativo)
                          </th>
                          <th className="p-2.5 text-center border border-gray-700 bg-gray-700">
                            ➖ Sin marcar
                          </th>
                          <th className="p-2.5 text-center border border-gray-700 bg-[#1f2937]">
                            % Acierto
                          </th>
                          <th className="p-2.5 text-left border border-gray-700">
                            Desglose por Acción / Categoría (✓ Acierto / ✕ No Acertada)
                          </th>
                          <th className="p-2.5 text-center border border-gray-700">TOTAL POSICIÓN</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {positionRows.map((pos) => {
                          const allPos = events.filter((e) => (e.player || '').trim() === pos);
                          const aciertos = allPos.filter((e) => getClipOutcome(e.descriptors) === 'positivo');
                          const noAcertadas = allPos.filter((e) => getClipOutcome(e.descriptors) === 'negativo');
                          const sinMarcar = allPos.filter((e) => getClipOutcome(e.descriptors) === 'neutro');
                          const evaluatedTotal = aciertos.length + noAcertadas.length;
                          const pctAcierto =
                            evaluatedTotal > 0 ? Math.round((aciertos.length / evaluatedTotal) * 100) : null;

                          // Agrupar por categoría dentro de esta posición
                          const catsWithClips = tagCategories
                            .map((cat) => {
                              const catClips = allPos.filter((e) => e.category === cat.name);
                              const catOk = catClips.filter((e) => getClipOutcome(e.descriptors) === 'positivo');
                              const catFail = catClips.filter((e) => getClipOutcome(e.descriptors) === 'negativo');
                              return { cat, catClips, catOk, catFail };
                            })
                            .filter((item) => item.catClips.length > 0);

                          return (
                            <tr
                              key={pos}
                              className={`hover:bg-gray-50 ${allPos.length > 0 ? 'bg-white' : 'bg-gray-50/40'}`}
                            >
                              <td className="p-2 border border-gray-200 font-bold text-gray-900 whitespace-nowrap">
                                <div className="flex items-center gap-1.5">
                                  <Users className="w-3.5 h-3.5 text-[#cc2016] shrink-0" />
                                  <span>{pos}</span>
                                </div>
                              </td>
                              {renderOutcomePlayCell(aciertos, '#15803d', '✓')}
                              {renderOutcomePlayCell(noAcertadas, '#cc2016', '✕')}
                              {renderOutcomePlayCell(sinMarcar, '#4b5563')}
                              <td className="p-2 border border-gray-200 text-center font-bold">
                                {pctAcierto !== null ? (
                                  <span
                                    className={`px-2 py-0.5 rounded text-[11px] inline-block ${
                                      pctAcierto >= 60
                                        ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                                        : pctAcierto >= 40
                                        ? 'bg-amber-100 text-amber-900 border border-amber-300'
                                        : 'bg-red-100 text-red-900 border border-red-300'
                                    }`}
                                  >
                                    {pctAcierto}% ({aciertos.length}/{evaluatedTotal})
                                  </span>
                                ) : (
                                  <span className="text-gray-300">—</span>
                                )}
                              </td>
                              <td className="p-2 border border-gray-200">
                                {catsWithClips.length > 0 ? (
                                  <div className="flex flex-wrap gap-1">
                                    {catsWithClips.map(({ cat, catClips, catOk, catFail }) => (
                                      <button
                                        key={cat.id}
                                        onClick={() => {
                                          setShowMatrixModal(false);
                                          startPlayingClipQueue(catClips);
                                        }}
                                        className="px-2 py-0.5 rounded border border-gray-300 bg-gray-50 hover:bg-gray-100 text-[11px] flex items-center gap-1 transition"
                                        title={`Reproducir ${cat.name} de ${pos}`}
                                      >
                                        <span
                                          className="w-2 h-2 rounded-full shrink-0"
                                          style={{ backgroundColor: cat.color }}
                                        />
                                        <span className="font-semibold text-gray-800">{cat.name}:</span>
                                        {catOk.length > 0 && (
                                          <span className="text-emerald-700 font-bold">✓{catOk.length}</span>
                                        )}
                                        {catFail.length > 0 && (
                                          <span className="text-red-700 font-bold">✕{catFail.length}</span>
                                        )}
                                        {catOk.length === 0 && catFail.length === 0 && (
                                          <span className="text-gray-600 font-bold">{catClips.length}</span>
                                        )}
                                      </button>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="text-gray-300 text-[11px]">Sin acciones registradas</span>
                                )}
                              </td>
                              <td className="p-2 border border-gray-200 text-center bg-gray-50">
                                {allPos.length > 0 ? (
                                  <div className="flex items-center justify-center gap-1">
                                    <button
                                      onClick={() => {
                                        setShowMatrixModal(false);
                                        startPlayingClipQueue(allPos);
                                      }}
                                      className="px-2.5 py-1 bg-[#15181d] text-[#f5b800] font-bold rounded flex items-center gap-1"
                                      title={`Reproducir todos los cortes de ${pos}`}
                                    >
                                      <Play className="w-3 h-3 fill-current" />
                                      <span>{allPos.length}</span>
                                    </button>
                                    <button
                                      onClick={() => addClipsToActivePlaylist(allPos)}
                                      className="px-2 py-1 bg-white border border-gray-300 text-gray-700 rounded text-[10px] font-bold hover:bg-gray-100"
                                      title="Enviar cortes de esta posición a Lista de Presentación"
                                    >
                                      + Lista
                                    </button>
                                  </div>
                                ) : (
                                  <span className="text-gray-300">0</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}

                        {/* Fila para cortes sin posición marcada (si existen) */}
                        {unassignedClips.length > 0 && (() => {
                          const aciertos = unassignedClips.filter((e) => getClipOutcome(e.descriptors) === 'positivo');
                          const noAcertadas = unassignedClips.filter((e) => getClipOutcome(e.descriptors) === 'negativo');
                          const sinMarcar = unassignedClips.filter((e) => getClipOutcome(e.descriptors) === 'neutro');
                          const evaluatedTotal = aciertos.length + noAcertadas.length;
                          const pctAcierto =
                            evaluatedTotal > 0 ? Math.round((aciertos.length / evaluatedTotal) * 100) : null;

                          return (
                            <tr className="bg-amber-50/60 hover:bg-amber-50">
                              <td className="p-2 border border-gray-200 font-bold text-amber-900">
                                -- Sin posición marcada --
                              </td>
                              {renderOutcomePlayCell(aciertos, '#15803d', '✓')}
                              {renderOutcomePlayCell(noAcertadas, '#cc2016', '✕')}
                              {renderOutcomePlayCell(sinMarcar, '#4b5563')}
                              <td className="p-2 border border-gray-200 text-center font-bold">
                                {pctAcierto !== null ? `${pctAcierto}%` : '—'}
                              </td>
                              <td className="p-2 border border-gray-200">
                                <div className="flex flex-wrap gap-1">
                                  {unassignedClips.map((clip) => (
                                    <button
                                      key={clip.id}
                                      onClick={() => {
                                        setShowMatrixModal(false);
                                        openEditClipModal(clip);
                                      }}
                                      className="px-2 py-0.5 bg-white border border-amber-300 rounded text-[10.5px] text-amber-900 hover:bg-amber-100 font-medium flex items-center gap-1"
                                      title="Haz clic para marcar la posición y si fue con acierto o no acertada"
                                    >
                                      <Pencil className="w-2.5 h-2.5 text-[#cc2016]" />
                                      <span>
                                        {clip.name} ({formatTimecode(clip.startTime)}) · Marcar posición
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              </td>
                              <td className="p-2 border border-gray-200 text-center">
                                <button
                                  onClick={() => {
                                    setShowMatrixModal(false);
                                    startPlayingClipQueue(unassignedClips);
                                  }}
                                  className="px-2.5 py-1 bg-[#15181d] text-[#f5b800] font-bold rounded inline-flex items-center gap-1"
                                >
                                  <Play className="w-3 h-3 fill-current" />
                                  <span>{unassignedClips.length}</span>
                                </button>
                              </td>
                            </tr>
                          );
                        })()}
                      </tbody>
                    </table>
                  </div>
                );
              })()}

              {/* =================================================================
                  BLOQUE 2: MATRIZ POR CATEGORÍAS (CON COLUMNA DE POSICIONES Y ACIERTO/FALLO)
                 ================================================================= */}
              {(matrixViewMode === 'completa' || matrixViewMode === 'categorias') && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-condensed font-bold text-sm uppercase tracking-wider text-gray-900 flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-sm bg-[#1666c0]" />
                      <span>MATRIZ POR CATEGORÍAS / ACCIONES Y POSICIONES INTERVINIENTES</span>
                    </h4>
                  </div>

                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="bg-[#15181d] text-white font-condensed uppercase text-sm tracking-wider">
                        <th className="p-2.5 text-left border border-gray-700">Categoría / Acción</th>
                        <th className="p-2.5 text-center border border-gray-700 bg-[#cc2016]">Séneca CF (1ª P)</th>
                        <th className="p-2.5 text-center border border-gray-700 bg-[#a81810]">Séneca CF (2ª P)</th>
                        <th className="p-2.5 text-center border border-gray-700 bg-[#1666c0]">Rival (1ª P)</th>
                        <th className="p-2.5 text-center border border-gray-700 bg-[#114f96]">Rival (2ª P)</th>
                        <th className="p-2.5 text-center border border-gray-700 bg-emerald-800">✓ Con Acierto</th>
                        <th className="p-2.5 text-center border border-gray-700 bg-red-800">✕ No Acertadas</th>
                        <th className="p-2.5 text-left border border-gray-700">
                          Posiciones en esta Acción (✓ Acierto / ✕ No Acertada)
                        </th>
                        <th className="p-2.5 text-center border border-gray-700">TOTAL GRUPO</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-200">
                      {tagCategories.map((cat) => {
                        const allCat = events.filter((e) => e.category === cat.name);
                        const sen1 = allCat.filter(
                          (e) => e.team === 'Séneca CF' && (e.half || '1ª Parte') === '1ª Parte'
                        );
                        const sen2 = allCat.filter((e) => e.team === 'Séneca CF' && e.half === '2ª Parte');
                        const riv1 = allCat.filter(
                          (e) => e.team === 'Rival' && (e.half || '1ª Parte') === '1ª Parte'
                        );
                        const riv2 = allCat.filter((e) => e.team === 'Rival' && e.half === '2ª Parte');
                        const exito = allCat.filter((e) => getClipOutcome(e.descriptors) === 'positivo');
                        const fallo = allCat.filter((e) => getClipOutcome(e.descriptors) === 'negativo');

                        // Resumen por posición dentro de esta categoría
                        const posMap = new Map<
                          string,
                          { clips: ClipEvent[]; ok: number; fail: number; neutral: number }
                        >();
                        allCat.forEach((ev) => {
                          const key = (ev.player || '').trim() || 'Sin posición';
                          const current = posMap.get(key) || { clips: [], ok: 0, fail: 0, neutral: 0 };
                          current.clips.push(ev);
                          const out = getClipOutcome(ev.descriptors);
                          if (out === 'positivo') current.ok += 1;
                          else if (out === 'negativo') current.fail += 1;
                          else current.neutral += 1;
                          posMap.set(key, current);
                        });

                        const renderCell = (clips: ClipEvent[], badgeColor: string) => (
                          <td className="p-2 border border-gray-200 text-center">
                            {clips.length > 0 ? (
                              <button
                                onClick={() => {
                                  setShowMatrixModal(false);
                                  startPlayingClipQueue(clips);
                                }}
                                style={{ backgroundColor: badgeColor }}
                                className="px-3 py-1 rounded text-white font-bold hover:opacity-90 transition inline-flex items-center gap-1 shadow-sm"
                                title="Haz clic para reproducir este grupo de cortes"
                              >
                                <Play className="w-3 h-3 fill-current" />
                                <span>{clips.length}</span>
                              </button>
                            ) : (
                              <span className="text-gray-300">0</span>
                            )}
                          </td>
                        );

                        return (
                          <tr key={cat.id} className="hover:bg-gray-50">
                            <td className="p-2 border border-gray-200 font-semibold flex items-center gap-2 whitespace-nowrap">
                              <span
                                className="w-3 h-3 rounded-sm shrink-0"
                                style={{ backgroundColor: cat.color }}
                              />
                              <span>{cat.name}</span>
                            </td>
                            {renderCell(sen1, '#cc2016')}
                            {renderCell(sen2, '#a81810')}
                            {renderCell(riv1, '#1666c0')}
                            {renderCell(riv2, '#114f96')}
                            {renderCell(exito, '#15803d')}
                            {renderCell(fallo, '#b91c1c')}
                            <td className="p-2 border border-gray-200">
                              {posMap.size > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {Array.from(posMap.entries()).map(([posName, info]) => (
                                    <button
                                      key={posName}
                                      onClick={() => {
                                        setShowMatrixModal(false);
                                        startPlayingClipQueue(info.clips);
                                      }}
                                      className={`px-2 py-0.5 rounded border text-[10.5px] flex items-center gap-1 transition ${
                                        posName === 'Sin posición'
                                          ? 'bg-amber-50 border-amber-300 text-amber-900 hover:bg-amber-100'
                                          : 'bg-gray-50 border-gray-300 text-gray-800 hover:bg-gray-100'
                                      }`}
                                      title={`Reproducir cortes de ${posName} en ${cat.name}`}
                                    >
                                      <span className="font-semibold">{posName}:</span>
                                      {info.ok > 0 && (
                                        <span className="px-1 rounded bg-emerald-600 text-white font-bold text-[9.5px]">
                                          ✓{info.ok}
                                        </span>
                                      )}
                                      {info.fail > 0 && (
                                        <span className="px-1 rounded bg-[#cc2016] text-white font-bold text-[9.5px]">
                                          ✕{info.fail}
                                        </span>
                                      )}
                                      {info.neutral > 0 && (
                                        <span className="px-1 rounded bg-gray-400 text-white font-bold text-[9.5px]">
                                          {info.neutral}
                                        </span>
                                      )}
                                    </button>
                                  ))}
                                </div>
                              ) : (
                                <span className="text-gray-300">—</span>
                              )}
                            </td>
                            <td className="p-2 border border-gray-200 text-center bg-gray-50">
                              {allCat.length > 0 ? (
                                <div className="flex items-center justify-center gap-1">
                                  <button
                                    onClick={() => {
                                      setShowMatrixModal(false);
                                      startPlayingClipQueue(allCat);
                                    }}
                                    className="px-2.5 py-1 bg-[#15181d] text-[#f5b800] font-bold rounded flex items-center gap-1"
                                  >
                                    <Play className="w-3 h-3 fill-current" />
                                    <span>{allCat.length}</span>
                                  </button>
                                  <button
                                    onClick={() => addClipsToActivePlaylist(allCat)}
                                    className="px-2 py-1 bg-white border border-gray-300 text-gray-700 rounded text-[10px] font-bold hover:bg-gray-100"
                                    title="Enviar grupo a Lista de Presentación"
                                  >
                                    + Lista
                                  </button>
                                </div>
                              ) : (
                                <span className="text-gray-400">0</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* =================================================================
                  BLOQUE 3: CRUCE CATEGORÍA × POSICIÓN (ACIERTO / NO ACERTADAS EN CADA CELDA)
                 ================================================================= */}
              {matrixViewMode === 'cruce' && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h4 className="font-condensed font-bold text-sm uppercase tracking-wider text-gray-900 flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-sm bg-emerald-700" />
                      <span>CRUCE CATEGORÍA × POSICIÓN (✓ CON ACIERTO / ✕ NO ACERTADAS)</span>
                    </h4>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full border-collapse text-[11px]">
                      <thead>
                        <tr className="bg-[#15181d] text-white font-condensed uppercase tracking-wider">
                          <th className="p-2 text-left border border-gray-700 sticky left-0 bg-[#15181d] z-10">
                            Categoría \ Posición
                          </th>
                          {allAvailablePlayers.map((pos) => (
                            <th key={pos} className="p-1.5 text-center border border-gray-700 min-w-[82px]">
                              {pos}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-200">
                        {tagCategories.map((cat) => (
                          <tr key={cat.id} className="hover:bg-gray-50">
                            <td className="p-2 border border-gray-200 font-semibold whitespace-nowrap sticky left-0 bg-white z-10 flex items-center gap-1.5">
                              <span
                                className="w-2.5 h-2.5 rounded-sm shrink-0"
                                style={{ backgroundColor: cat.color }}
                              />
                              <span>{cat.name}</span>
                            </td>
                            {allAvailablePlayers.map((pos) => {
                              const cellClips = events.filter(
                                (e) => e.category === cat.name && (e.player || '').trim() === pos
                              );
                              const okClips = cellClips.filter(
                                (e) => getClipOutcome(e.descriptors) === 'positivo'
                              );
                              const failClips = cellClips.filter(
                                (e) => getClipOutcome(e.descriptors) === 'negativo'
                              );

                              return (
                                <td key={pos} className="p-1.5 border border-gray-200 text-center">
                                  {cellClips.length > 0 ? (
                                    <div className="flex items-center justify-center gap-1 flex-wrap">
                                      {okClips.length > 0 && (
                                        <button
                                          onClick={() => {
                                            setShowMatrixModal(false);
                                            startPlayingClipQueue(okClips);
                                          }}
                                          className="px-1.5 py-0.5 rounded bg-emerald-600 text-white font-bold text-[10px] hover:bg-emerald-700"
                                          title={`Reproducir ${okClips.length} con acierto de ${pos} en ${cat.name}`}
                                        >
                                          ✓{okClips.length}
                                        </button>
                                      )}
                                      {failClips.length > 0 && (
                                        <button
                                          onClick={() => {
                                            setShowMatrixModal(false);
                                            startPlayingClipQueue(failClips);
                                          }}
                                          className="px-1.5 py-0.5 rounded bg-[#cc2016] text-white font-bold text-[10px] hover:bg-red-800"
                                          title={`Reproducir ${failClips.length} no acertadas de ${pos} en ${cat.name}`}
                                        >
                                          ✕{failClips.length}
                                        </button>
                                      )}
                                      {okClips.length === 0 && failClips.length === 0 && (
                                        <button
                                          onClick={() => {
                                            setShowMatrixModal(false);
                                            startPlayingClipQueue(cellClips);
                                          }}
                                          className="px-1.5 py-0.5 rounded bg-gray-600 text-white font-bold text-[10px]"
                                        >
                                          {cellClips.length}
                                        </button>
                                      )}
                                    </div>
                                  ) : (
                                    <span className="text-gray-200">·</span>
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-gray-200 mt-3 flex flex-wrap items-center justify-between gap-2 shrink-0">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => exportEventsToCSV(projectName)}
                  className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold rounded flex items-center gap-1.5"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" />
                  <span>Descargar Matriz CSV (Excel con Posiciones y Acierto)</span>
                </button>
                <button
                  onClick={exportEventsToNacsportXML}
                  className="px-3 py-1.5 bg-[#1666c0] hover:bg-[#1255a1] text-white text-xs font-bold rounded flex items-center gap-1.5"
                >
                  <Code className="w-3.5 h-3.5" />
                  <span>Exportar XML Nacsport / Sportscode</span>
                </button>
              </div>
              <button
                onClick={() => setShowMatrixModal(false)}
                className="px-4 py-1.5 bg-gray-800 text-white text-xs font-bold rounded"
              >
                Cerrar Matriz
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODAL: CONSTRUCTOR Y EDITOR DE BOTONERA NACSPORT
         ===================================================================== */}
      {showBotoneraBuilderModal && (
        <div className="fixed inset-0 bg-black/75 flex items-center justify-center p-3 sm:p-4 z-50">
          <div className="bg-[#141822] text-white rounded-lg max-w-4xl w-full p-5 shadow-2xl border-t-4 border-[#cc2016] max-h-[92vh] flex flex-col">
            {/* CABECERA DEL CONSTRUCTOR */}
            <div className="flex items-center justify-between pb-3 border-b border-gray-700 shrink-0">
              <div className="flex items-center gap-2.5">
                <Sliders className="w-6 h-6 text-[#f5b800]" />
                <div>
                  <h3 className="font-condensed font-bold text-lg uppercase text-white tracking-wide">
                    CONSTRUCTOR DE BOTONERA NACSPORT (SÉNECA CF)
                  </h3>
                  <p className="text-xs text-gray-400">
                    Crea y personaliza botones tácticos, atajos de teclado, modos manual/automático y descriptores
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => enterBotoneraFullscreen()}
                  className="px-3 py-1 bg-[#cc2016] hover:bg-[#a81810] text-white text-xs font-condensed font-bold uppercase rounded flex items-center gap-1"
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                  <span>Probar en Pantalla Completa</span>
                </button>
                <button
                  onClick={() => setShowBotoneraBuilderModal(false)}
                  className="text-gray-400 hover:text-white p-1"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* PESTAÑAS DEL CONSTRUCTOR */}
            <div className="flex items-center gap-1 border-b border-gray-700 pt-3 pb-2 shrink-0">
              <button
                onClick={() => setBuilderTab('categorias')}
                className={`px-3 py-1.5 font-condensed font-bold text-xs uppercase rounded transition ${
                  builderTab === 'categorias'
                    ? 'bg-[#cc2016] text-white'
                    : 'bg-[#1c2230] text-gray-300 hover:bg-[#252c3d]'
                }`}
              >
                1. Botones de Categoría ({tagCategories.length})
              </button>
              <button
                onClick={() => setBuilderTab('descriptores')}
                className={`px-3 py-1.5 font-condensed font-bold text-xs uppercase rounded transition ${
                  builderTab === 'descriptores'
                    ? 'bg-[#cc2016] text-white'
                    : 'bg-[#1c2230] text-gray-300 hover:bg-[#252c3d]'
                }`}
              >
                2. Descriptores ({customDescriptors.length})
              </button>
              <button
                onClick={() => setBuilderTab('diseno')}
                className={`px-3 py-1.5 font-condensed font-bold text-xs uppercase rounded transition ${
                  builderTab === 'diseno'
                    ? 'bg-[#cc2016] text-white'
                    : 'bg-[#1c2230] text-gray-300 hover:bg-[#252c3d]'
                }`}
              >
                3. Diseño y Comportamiento
              </button>
              <button
                onClick={() => setBuilderTab('plantillas')}
                className={`px-3 py-1.5 font-condensed font-bold text-xs uppercase rounded transition ${
                  builderTab === 'plantillas'
                    ? 'bg-[#cc2016] text-white'
                    : 'bg-[#1c2230] text-gray-300 hover:bg-[#252c3d]'
                }`}
              >
                4. Plantillas de Botonera ({botoneraTemplates.length})
              </button>
            </div>

            {/* CONTENIDO DE PESTAÑAS */}
            <div className="flex-1 overflow-y-auto py-3 space-y-4">
              {/* TAB 1: CATEGORÍAS */}
              {builderTab === 'categorias' && (
                <div className="space-y-4">
                  {/* FORMULARIO AÑADIR NUEVO BOTÓN */}
                  <div className="bg-[#1a202c] p-3.5 rounded border border-gray-700">
                    <span className="font-condensed font-bold text-xs uppercase text-[#f5b800] block mb-2">
                      + CREAR NUEVO BOTÓN DE ACCIÓN / CATEGORÍA
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 mb-2.5">
                      <div>
                        <label className="text-[11px] text-gray-400 block mb-1">Nombre de la Categoría</label>
                        <input
                          type="text"
                          value={newCatName}
                          onChange={(e) => setNewCatName(e.target.value)}
                          placeholder="Ej: Salida de 3, Pase Filtrado..."
                          className="w-full bg-[#11141c] border border-gray-700 rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#cc2016]"
                        />
                      </div>

                      <div>
                        <label className="text-[11px] text-gray-400 block mb-1">Fase / Tipo Táctico</label>
                        <select
                          value={newCatType}
                          onChange={(e) => setNewCatType(e.target.value as any)}
                          className="w-full bg-[#11141c] border border-gray-700 rounded px-2.5 py-1.5 text-xs text-white focus:outline-none"
                        >
                          <option value="Ataque">Ataque</option>
                          <option value="Defensa">Defensa</option>
                          <option value="Transición">Transición</option>
                          <option value="ABP">Balón Parado (ABP)</option>
                          <option value="Resultado">Resultado</option>
                        </select>
                      </div>

                      <div>
                        <label className="text-[11px] text-gray-400 block mb-1">Modo de Grabación</label>
                        <select
                          value={newCatMode}
                          onChange={(e) => setNewCatMode(e.target.value as any)}
                          className="w-full bg-[#11141c] border border-gray-700 rounded px-2.5 py-1.5 text-xs text-white focus:outline-none"
                        >
                          <option value="auto">Automático (-Pre / +Post)</option>
                          <option value="manual">Manual (1º Clic Inicia, 2º Clic Cierra)</option>
                        </select>
                      </div>

                      <div>
                        <label className="text-[11px] text-gray-400 block mb-1">Tecla Rápida / Atajo</label>
                        <input
                          type="text"
                          maxLength={3}
                          value={newCatShortcut}
                          onChange={(e) => setNewCatShortcut(e.target.value.toUpperCase())}
                          placeholder={`Auto (${tagCategories.length < 9 ? tagCategories.length + 1 : '0'})`}
                          className="w-full bg-[#11141c] border border-gray-700 rounded px-2.5 py-1.5 text-xs text-center font-mono font-bold text-[#f5b800] focus:outline-none focus:border-[#cc2016]"
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                      {newCatMode === 'auto' ? (
                        <div className="flex items-center gap-3 text-xs">
                          <div className="flex items-center gap-1.5">
                            <span className="text-gray-400">Pre-roll (-s):</span>
                            <input
                              type="number"
                              min={1}
                              max={30}
                              value={newCatPreRoll}
                              onChange={(e) => setNewCatPreRoll(Number(e.target.value))}
                              className="w-14 bg-[#11141c] border border-gray-700 rounded px-2 py-1 text-center font-bold text-white text-xs"
                            />
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-gray-400">Post-roll (+s):</span>
                            <input
                              type="number"
                              min={1}
                              max={30}
                              value={newCatPostRoll}
                              onChange={(e) => setNewCatPostRoll(Number(e.target.value))}
                              className="w-14 bg-[#11141c] border border-gray-700 rounded px-2 py-1 text-center font-bold text-white text-xs"
                            />
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-amber-300">
                          ● Modo manual: Al pulsar graba en directo hasta que vuelvas a pulsar el botón o su atajo.
                        </span>
                      )}

                      <div className="flex items-center gap-2">
                        <span className="text-[11px] text-gray-400">Color:</span>
                        <input
                          type="color"
                          value={newCatColor}
                          onChange={(e) => setNewCatColor(e.target.value)}
                          className="w-8 h-8 rounded border border-gray-600 bg-transparent cursor-pointer p-0.5"
                        />
                        <div className="flex items-center gap-1">
                          {['#cc2016', '#e65100', '#f5b800', '#2e7d32', '#1565c0', '#00838f', '#4527a0', '#6a1b9a'].map(
                            (c) => (
                              <button
                                key={c}
                                type="button"
                                onClick={() => setNewCatColor(c)}
                                style={{ backgroundColor: c }}
                                className={`w-5 h-5 rounded-full border ${
                                  newCatColor === c ? 'ring-2 ring-white scale-110' : 'border-gray-700'
                                }`}
                              />
                            )
                          )}
                        </div>

                        <button
                          onClick={handleAddNewCategory}
                          className="ml-2 px-4 py-1.5 bg-[#cc2016] hover:bg-[#a81810] text-white font-condensed font-bold text-xs uppercase rounded shadow"
                        >
                          + Añadir Botón
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* LISTA DE BOTONES DE CATEGORÍA EXISTENTES */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-condensed font-bold text-xs uppercase text-gray-300">
                        BOTONES ACTIVOS EN LA BOTONERA ({tagCategories.length})
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => {
                            if (window.confirm('¿Restaurar las 10 categorías por defecto?')) {
                              setTagCategories(DEFAULT_TAG_CATEGORIES);
                              notify('Categorías restauradas por defecto');
                            }
                          }}
                          className="text-[11px] text-gray-400 hover:text-white underline"
                        >
                          Restaurar por defecto
                        </button>
                        <button
                          onClick={() => {
                            if (window.confirm('¿Vaciar todos los botones de la botonera para empezar desde cero?')) {
                              setTagCategories([]);
                              notify('Botonera vaciada. Añade tus propios botones arriba');
                            }
                          }}
                          className="text-[11px] text-red-400 hover:text-red-300 underline"
                        >
                          Vaciar botonera
                        </button>
                      </div>
                    </div>

                    <div className="space-y-1.5 max-h-[340px] overflow-y-auto pr-1">
                      {tagCategories.map((cat, idx) => (
                        <div
                          key={cat.id}
                          className="bg-[#1a202c] p-2.5 rounded border border-gray-700 flex flex-wrap items-center justify-between gap-2 text-xs"
                        >
                          <div className="flex items-center gap-2.5 flex-1 min-w-[200px]">
                            <input
                              type="color"
                              value={cat.color}
                              onChange={(e) => {
                                const col = e.target.value;
                                setTagCategories((prev) =>
                                  prev.map((c) => (c.id === cat.id ? { ...c, color: col } : c))
                                );
                              }}
                              className="w-6 h-6 rounded border border-gray-600 bg-transparent cursor-pointer p-0.5 shrink-0"
                            />
                            <input
                              type="text"
                              value={cat.name}
                              onChange={(e) => {
                                const val = e.target.value;
                                setTagCategories((prev) =>
                                  prev.map((c) => (c.id === cat.id ? { ...c, name: val } : c))
                                );
                              }}
                              className="bg-[#11141c] border border-gray-700 rounded px-2 py-1 text-xs text-white font-bold flex-1"
                            />
                            <span className="px-1.5 py-0.5 bg-black/40 rounded text-[10px] text-gray-400 shrink-0 uppercase">
                              {cat.type}
                            </span>
                          </div>

                          <div className="flex items-center gap-2">
                            {/* Toggle modo auto / manual */}
                            <button
                              onClick={() => {
                                const nextMode = cat.mode === 'manual' ? 'auto' : 'manual';
                                setTagCategories((prev) =>
                                  prev.map((c) => (c.id === cat.id ? { ...c, mode: nextMode } : c))
                                );
                              }}
                              className={`px-2 py-0.5 rounded text-[10.5px] font-bold border transition ${
                                cat.mode === 'manual'
                                  ? 'bg-amber-900/40 text-amber-300 border-amber-600'
                                  : 'bg-gray-800 text-gray-300 border-gray-700'
                              }`}
                            >
                              {cat.mode === 'manual' ? 'REC Manual' : 'Corte Auto'}
                            </button>

                            {cat.mode !== 'manual' && (
                              <div className="flex items-center gap-1 text-[11px] text-gray-400">
                                <span>-{cat.preRoll}s</span>
                                <span>/+{cat.postRoll}s</span>
                              </div>
                            )}

                            {/* Shortcut input */}
                            <input
                              type="text"
                              maxLength={3}
                              value={cat.shortcut || ''}
                              onChange={(e) => {
                                const s = e.target.value.toUpperCase();
                                setTagCategories((prev) =>
                                  prev.map((c) => (c.id === cat.id ? { ...c, shortcut: s } : c))
                                );
                              }}
                              placeholder="Atajo"
                              className="w-12 bg-[#11141c] border border-gray-700 rounded px-1.5 py-0.5 text-center font-mono font-bold text-[#f5b800] text-xs"
                            />

                            {/* Reordenar */}
                            <button
                              disabled={idx === 0}
                              onClick={() => handleMoveCategory(idx, 'up')}
                              className="p-1 hover:text-[#f5b800] disabled:opacity-30"
                              title="Subir posición"
                            >
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              disabled={idx === tagCategories.length - 1}
                              onClick={() => handleMoveCategory(idx, 'down')}
                              className="p-1 hover:text-[#f5b800] disabled:opacity-30"
                              title="Bajar posición"
                            >
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>

                            {/* Eliminar */}
                            <button
                              onClick={() => handleDeleteCategory(cat.id)}
                              className="p-1 text-red-400 hover:text-red-300"
                              title="Eliminar este botón"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 2: DESCRIPTORES */}
              {builderTab === 'descriptores' && (
                <div className="space-y-4">
                  <div className="bg-[#1a202c] p-3.5 rounded border border-gray-700">
                    <span className="font-condensed font-bold text-xs uppercase text-[#f5b800] block mb-2">
                      + AÑADIR NUEVO DESCRIPTOR PERSONALIZADO
                    </span>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={newDescriptorInput}
                        onChange={(e) => setNewDescriptorInput(e.target.value)}
                        placeholder="Ej: Pase Filtrado, Desmarque de Ruptura, Balón Largo..."
                        className="flex-1 bg-[#11141c] border border-gray-700 rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#cc2016]"
                      />
                      <button
                        onClick={() => {
                          if (!newDescriptorInput.trim()) return;
                          if (customDescriptors.includes(newDescriptorInput.trim())) {
                            notify('Este descriptor ya existe');
                            return;
                          }
                          setCustomDescriptors([...customDescriptors, newDescriptorInput.trim()]);
                          setNewDescriptorInput('');
                          notify('Descriptor añadido con éxito');
                        }}
                        className="px-4 py-1.5 bg-[#cc2016] hover:bg-[#a81810] text-white font-condensed font-bold text-xs uppercase rounded"
                      >
                        + Añadir Descriptor
                      </button>
                    </div>
                  </div>

                  <div>
                    <span className="font-condensed font-bold text-xs uppercase text-gray-300 block mb-2">
                      DESCRIPTORES EN LA BOTONERA ({customDescriptors.length})
                    </span>
                    <div className="flex flex-wrap gap-2 max-h-[300px] overflow-y-auto p-2 bg-[#1a202c] rounded border border-gray-700">
                      {customDescriptors.map((desc) => (
                        <div
                          key={desc}
                          className="flex items-center gap-1.5 px-2.5 py-1 bg-[#11141c] rounded border border-gray-700 text-xs text-white"
                        >
                          <span>{desc}</span>
                          <button
                            onClick={() => {
                              setCustomDescriptors(customDescriptors.filter((d) => d !== desc));
                            }}
                            className="text-gray-400 hover:text-red-400 ml-1"
                          >
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 3: DISEÑO Y COMPORTAMIENTO */}
              {builderTab === 'diseno' && (
                <div className="space-y-4 text-xs">
                  <div className="bg-[#1a202c] p-4 rounded border border-gray-700 space-y-3">
                    <span className="font-condensed font-bold text-sm uppercase text-[#f5b800] block">
                      CONFIGURACIÓN VISUAL DE LA BOTONERA
                    </span>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="text-gray-400 block mb-1.5 font-bold">Número de Columnas</label>
                        <div className="flex items-center gap-2">
                          {[2, 3, 4, 5, 6].map((num) => (
                            <button
                              key={num}
                              onClick={() => setBotoneraColumns(num)}
                              className={`px-3 py-1.5 rounded font-bold transition ${
                                botoneraColumns === num
                                  ? 'bg-[#cc2016] text-white'
                                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                              }`}
                            >
                              {num} col
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <label className="text-gray-400 block mb-1.5 font-bold">Tamaño de los Botones</label>
                        <div className="flex items-center gap-2">
                          {[
                            { key: 'sm', label: 'Compacto' },
                            { key: 'md', label: 'Estándar' },
                            { key: 'lg', label: 'Grande (Táctil)' },
                          ].map((s) => (
                            <button
                              key={s.key}
                              onClick={() => setBotoneraButtonSize(s.key as any)}
                              className={`px-3 py-1.5 rounded font-bold transition ${
                                botoneraButtonSize === s.key
                                  ? 'bg-[#cc2016] text-white'
                                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                              }`}
                            >
                              {s.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    <div className="pt-3 border-t border-gray-700 space-y-2">
                      <span className="text-gray-400 block font-bold">Bloques Visibles en la Botonera:</span>
                      <div className="flex flex-wrap items-center gap-4">
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={showPitchInBotonera}
                            onChange={(e) => setShowPitchInBotonera(e.target.checked)}
                            className="rounded accent-[#cc2016]"
                          />
                          <span>Mostrar Mapa de 9 Zonas Tácticas</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={showPlayersInBotonera}
                            onChange={(e) => setShowPlayersInBotonera(e.target.checked)}
                            className="rounded accent-[#cc2016]"
                          />
                          <span>Mostrar Dorsales / Jugadores Rápidos</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={showDescriptorsInBotonera}
                            onChange={(e) => setShowDescriptorsInBotonera(e.target.checked)}
                            className="rounded accent-[#cc2016]"
                          />
                          <span>Mostrar Tira de Descriptores Extra</span>
                        </label>
                      </div>
                    </div>

                    <div className="pt-3 border-t border-gray-700 space-y-2">
                      <span className="text-gray-400 block font-bold">Modo de Marcaje:</span>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => setDirectOneClickMode(true)}
                          className={`p-3 rounded border flex-1 text-left transition ${
                            directOneClickMode
                              ? 'bg-emerald-950/50 border-emerald-500 text-emerald-300'
                              : 'bg-gray-800/40 border-gray-700 text-gray-400'
                          }`}
                        >
                          <b className="block text-sm">⚡ Modo Directo 1-Clic (Recomendado Nacsport Live)</b>
                          <span className="text-[11px] opacity-80 block mt-1">
                            Al hacer clic en una categoría se registra el corte al instante sin pausar el partido.
                          </span>
                        </button>
                        <button
                          onClick={() => setDirectOneClickMode(false)}
                          className={`p-3 rounded border flex-1 text-left transition ${
                            !directOneClickMode
                              ? 'bg-amber-950/50 border-amber-500 text-amber-300'
                              : 'bg-gray-800/40 border-gray-700 text-gray-400'
                          }`}
                        >
                          <b className="block text-sm">📝 Modo con Ventana de Clasificación</b>
                          <span className="text-[11px] opacity-80 block mt-1">
                            Pausa el vídeo al pulsar para elegir jugador, éxito/fallo y notas tácticas detalladas.
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* TAB 4: PLANTILLAS */}
              {builderTab === 'plantillas' && (
                <div className="space-y-4">
                  <div className="bg-[#1a202c] p-3.5 rounded border border-gray-700">
                    <span className="font-condensed font-bold text-xs uppercase text-[#f5b800] block mb-2">
                      GUARDAR BOTONERA ACTUAL COMO NUEVA PLANTILLA
                    </span>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={newTemplateNameInput}
                        onChange={(e) => setNewTemplateNameInput(e.target.value)}
                        placeholder="Nombre de la nueva plantilla (ej: Botonera Juvenil DH, Botonera ABP...)"
                        className="flex-1 bg-[#11141c] border border-gray-700 rounded px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-[#cc2016]"
                      />
                      <button
                        onClick={() => handleSaveCurrentAsTemplate(newTemplateNameInput)}
                        className="px-4 py-1.5 bg-[#cc2016] hover:bg-[#a81810] text-white font-condensed font-bold text-xs uppercase rounded"
                      >
                        Guardar Plantilla
                      </button>
                    </div>
                  </div>

                  <div>
                    <span className="font-condensed font-bold text-xs uppercase text-gray-300 block mb-2">
                      PLANTILLAS DISPONIBLES ({botoneraTemplates.length})
                    </span>
                    <div className="space-y-2">
                      {botoneraTemplates.map((tpl) => (
                        <div
                          key={tpl.id}
                          className={`p-3 rounded border flex items-center justify-between gap-3 ${
                            activeTemplateId === tpl.id
                              ? 'bg-[#1b2333] border-[#cc2016]'
                              : 'bg-[#1a202c] border-gray-700'
                          }`}
                        >
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="font-condensed font-bold text-sm text-white uppercase">{tpl.name}</span>
                              {activeTemplateId === tpl.id && (
                                <span className="px-2 py-0.2 bg-[#cc2016] text-white text-[10px] font-bold rounded">
                                  ACTIVA
                                </span>
                              )}
                            </div>
                            <span className="text-xs text-gray-400 block mt-0.5">
                              {tpl.description || `${tpl.categories.length} categorías tácticas`}
                            </span>
                          </div>

                          <div className="flex items-center gap-2">
                            {activeTemplateId !== tpl.id && (
                              <button
                                onClick={() => handleApplyTemplate(tpl)}
                                className="px-3 py-1 bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold rounded"
                              >
                                Cargar
                              </button>
                            )}
                            <button
                              onClick={() => handleDeleteTemplate(tpl.id)}
                              disabled={botoneraTemplates.length <= 1}
                              className="p-1 text-red-400 hover:text-red-300 disabled:opacity-30"
                              title="Eliminar plantilla"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* PIE DEL MODAL */}
            <div className="pt-3 border-t border-gray-700 flex items-center justify-between shrink-0">
              <span className="text-xs text-gray-400">
                Las botoneras se guardan automáticamente y sincronizan con tus proyectos.
              </span>
              <button
                onClick={() => setShowBotoneraBuilderModal(false)}
                className="px-5 py-1.5 bg-[#cc2016] hover:bg-[#a81810] text-white font-condensed font-bold text-xs uppercase rounded"
              >
                Cerrar Constructor
              </button>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          MODALES DE PROYECTOS SUPABASE, SQL Y TUTORIAL
         ===================================================================== */}
      {showProjectsModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-2xl w-full p-5 shadow-2xl border-t-4 border-[#cc2016]">
            <div className="flex items-center justify-between pb-3 border-b border-gray-200 mb-4">
              <div className="flex items-center gap-2.5">
                <img src="/seneca-shield.jpg" alt="Séneca CF" className="w-8 h-8 object-contain" />
                <div>
                  <h3 className="font-condensed font-bold text-lg uppercase text-gray-900">
                    PROYECTOS Y PARTIDOS - ANÁLISIS SÉNECA CF (SUPABASE CLOUD)
                  </h3>
                  <p className="text-xs text-gray-500">
                    Conectado a: <code className="text-[#cc2016]">aojlwavrjxxpzupwchxr.supabase.co</code>
                  </p>
                </div>
              </div>
              <button onClick={() => setShowProjectsModal(false)} className="text-gray-400 hover:text-gray-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="bg-gray-50 p-3 rounded border border-gray-200 mb-4">
              <div className="text-xs font-bold uppercase text-gray-700 mb-2">Partido / Proyecto Actual</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2">
                <div>
                  <label className="text-[11px] text-gray-500 block">Nombre del Proyecto</label>
                  <input
                    type="text"
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-gray-500 block">Club Rival</label>
                  <input
                    type="text"
                    value={rivalName}
                    onChange={(e) => setRivalName(e.target.value)}
                    className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-xs"
                  />
                </div>
                <div>
                  <label className="text-[11px] text-gray-500 block">Competición / Categoría</label>
                  <input
                    type="text"
                    value={competition}
                    onChange={(e) => setCompetition(e.target.value)}
                    className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-xs"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <button
                  onClick={() => {
                    const newId = `seneca-${Date.now()}`;
                    setProjectId(newId);
                    setProjectName(`Séneca CF vs Nuevo Rival (${new Date().toLocaleDateString()})`);
                    setEvents([]);
                    setCaptures([]);
                    setDrawings([]);
                    setMarkers({});
                    notify('Nuevo proyecto de partido creado');
                  }}
                  className="px-3 py-1.5 bg-[#141414] hover:bg-gray-800 text-[#f5b800] text-xs font-semibold rounded flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Crear Nuevo Partido</span>
                </button>

                <button
                  onClick={async () => {
                    await fetchProjectsFromSupabase();
                    notify('Sincronizado con Supabase');
                  }}
                  className="px-3 py-1.5 bg-[#cc2016] hover:bg-[#a81810] text-white text-xs font-semibold rounded flex items-center gap-1"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Guardar y Sincronizar Ahora</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showSqlModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-2xl w-full p-5 shadow-2xl border-t-4 border-[#cc2016]">
            <div className="flex items-center justify-between pb-3 border-b border-gray-200 mb-3">
              <h3 className="font-condensed font-bold text-lg uppercase text-gray-900">
                CONFIGURACIÓN DE TABLA EN SUPABASE (aojlwavrjxxpzupwchxr)
              </h3>
              <button onClick={() => setShowSqlModal(false)} className="text-gray-400 hover:text-gray-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <pre className="bg-[#141414] text-emerald-400 p-3 rounded text-[11px] overflow-x-auto font-mono mb-3">
{`CREATE TABLE IF NOT EXISTS public.seneca_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  rival TEXT DEFAULT '',
  competition TEXT DEFAULT '',
  match_date DATE DEFAULT CURRENT_DATE,
  active_module TEXT DEFAULT 'editor',
  events JSONB DEFAULT '[]'::jsonb,
  captures JSONB DEFAULT '[]'::jsonb,
  drawings JSONB DEFAULT '[]'::jsonb,
  markers JSONB DEFAULT '{}'::jsonb,
  tag_categories JSONB DEFAULT '[]'::jsonb,
  playlists JSONB DEFAULT '[]'::jsonb,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.seneca_projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Acceso total para Analisis Seneca CF" ON public.seneca_projects;
CREATE POLICY "Acceso total para Analisis Seneca CF"
  ON public.seneca_projects FOR ALL TO anon, authenticated
  USING (true) WITH CHECK (true);`}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  navigator.clipboard.writeText(
                    `CREATE TABLE IF NOT EXISTS public.seneca_projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, rival TEXT DEFAULT '', competition TEXT DEFAULT '', match_date DATE DEFAULT CURRENT_DATE, active_module TEXT DEFAULT 'editor', events JSONB DEFAULT '[]'::jsonb, captures JSONB DEFAULT '[]'::jsonb, drawings JSONB DEFAULT '[]'::jsonb, markers JSONB DEFAULT '{}'::jsonb, tag_categories JSONB DEFAULT '[]'::jsonb, playlists JSONB DEFAULT '[]'::jsonb, updated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW()); ALTER TABLE public.seneca_projects ENABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS "Acceso total para Analisis Seneca CF" ON public.seneca_projects; CREATE POLICY "Acceso total para Analisis Seneca CF" ON public.seneca_projects FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);`
                  );
                  notify('Código SQL copiado al portapapeles');
                }}
                className="px-4 py-1.5 bg-[#cc2016] text-white text-xs font-bold rounded"
              >
                Copiar SQL
              </button>
            </div>
          </div>
        </div>
      )}

      {showTutorialModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg max-w-xl w-full p-5 shadow-2xl border-t-4 border-[#cc2016]">
            <div className="flex items-center justify-between pb-3 border-b border-gray-200 mb-3">
              <div className="flex items-center gap-2">
                <HelpCircle className="w-5 h-5 text-[#cc2016]" />
                <h3 className="font-condensed font-bold text-lg uppercase text-gray-900">
                  GUÍA RÁPIDA - FUNCIONES NACSPORT Y KLIPDRAW EN ANÁLISIS SÉNECA CF
                </h3>
              </div>
              <button onClick={() => setShowTutorialModal(false)} className="text-gray-400 hover:text-gray-700">
                <X className="w-5 h-5" />
              </button>
            </div>
            <ul className="space-y-2.5 text-xs text-gray-700 leading-relaxed mb-4">
              <li>
                <strong>1. Agrupación de Cortes según lo Clasificado (Nacsport):</strong> En el panel derecho de{' '}
                <strong>EVENTOS Y AGRUPACIÓN</strong> puedes agrupar automáticamente todos tus cortes por{' '}
                <strong>Categoría/Acción, Equipo, Periodo (1ª/2ª Parte), Jugador o Zona del Campo</strong>. Cada grupo
                tiene su propio botón <strong>"Ver grupo"</strong> (para reproducir todos los cortes de esa categoría
                seguidos), <strong>"+ Lista"</strong> y botón de <strong>descarga del grupo en un solo vídeo</strong>.
              </li>
              <li>
                <strong>2. Matriz de Datos Cruzados (Matriz Nacsport):</strong> Pulsa el botón rojo{' '}
                <strong>Matriz Nacsport</strong> en la barra superior para ver la tabla cruzada de todas las categorías
                por equipo y parte; haciendo clic en cualquier número se reproducen esos cortes al instante.
              </li>
              <li>
                <strong>3. Listas de Presentación (Playlists):</strong> En la pestaña <strong>Listas</strong> puedes
                crear listas para la charla del entrenador (ej. <em>Charla Equipo</em>, <em>Informe Defensivo</em>) y
                exportarlas como vídeo único.
              </li>
              <li>
                <strong>4. Herramientas KlipDraw Pro:</strong> En Pintado de Acciones dispones de{' '}
                <strong>Estela Klip</strong> (rastro luminoso de movimiento con anillos), <strong>Anillo 3D</strong> y{' '}
                <strong>Sombra Defensiva (Cover Shadow)</strong>.
              </li>
            </ul>
            <div className="flex justify-end">
              <button
                onClick={() => setShowTutorialModal(false)}
                className="px-4 py-1.5 bg-[#cc2016] text-white font-condensed font-bold text-xs uppercase rounded"
              >
                Entendido
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
