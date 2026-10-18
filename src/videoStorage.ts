import { VideoFileItem } from './supabaseClient';

const DB_NAME = 'SenecaCF_MediaDB';
const DB_VERSION = 1;
const STORE_VIDEOS = 'match_videos';

interface StoredVideoRecord {
  id: string;
  projectId: string;
  name: string;
  blob: Blob;
  duration: number;
  size: number;
  isDemo?: boolean;
  createdAt: string;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB no está disponible en este entorno'));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_VIDEOS)) {
        const store = db.createObjectStore(STORE_VIDEOS, { keyPath: 'id' });
        store.createIndex('projectId', 'projectId', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Guarda un archivo o Blob de vídeo asociado a un partido (projectId) en IndexedDB
 */
export async function saveVideoFile(
  projectId: string,
  blob: Blob,
  meta: { id: string; name: string; duration?: number; size?: number; isDemo?: boolean }
): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VIDEOS, 'readwrite');
      const store = tx.objectStore(STORE_VIDEOS);

      const record: StoredVideoRecord = {
        id: meta.id,
        projectId,
        name: meta.name,
        blob,
        duration: meta.duration || 0,
        size: meta.size || blob.size,
        isDemo: !!meta.isDemo,
        createdAt: new Date().toISOString(),
      };

      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Error guardando vídeo en IndexedDB:', err);
    throw err;
  }
}

/**
 * Recupera todos los vídeos guardados para un partido (projectId) y genera URLs vivas
 */
export async function getVideosForProject(projectId: string): Promise<VideoFileItem[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VIDEOS, 'readonly');
      const store = tx.objectStore(STORE_VIDEOS);
      const index = store.index('projectId');
      const request = index.getAll(IDBKeyRange.only(projectId));

      request.onsuccess = () => {
        const records: StoredVideoRecord[] = request.result || [];
        const videoItems: VideoFileItem[] = records.map((rec) => {
          let url = '';
          try {
            url = URL.createObjectURL(rec.blob);
          } catch (e) {
            console.warn('Error creando Blob URL para vídeo guardado:', e);
          }
          return {
            id: rec.id,
            name: rec.name,
            url,
            duration: rec.duration || 0,
            size: rec.size || rec.blob.size,
            isDemo: rec.isDemo,
          };
        });
        resolve(videoItems);
      };

      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Error recuperando vídeos desde IndexedDB:', err);
    return [];
  }
}

/**
 * Elimina un vídeo individual por su ID
 */
export async function deleteVideoFile(videoId: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VIDEOS, 'readwrite');
      const store = tx.objectStore(STORE_VIDEOS);
      const request = store.delete(videoId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Error eliminando vídeo en IndexedDB:', err);
    throw err;
  }
}

/**
 * Elimina todos los vídeos asociados a un partido (projectId)
 */
export async function deleteVideosForProject(projectId: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VIDEOS, 'readwrite');
      const store = tx.objectStore(STORE_VIDEOS);
      const index = store.index('projectId');
      const request = index.getAllKeys(IDBKeyRange.only(projectId));

      request.onsuccess = () => {
        const keys = request.result || [];
        if (keys.length === 0) {
          resolve();
          return;
        }
        let completed = 0;
        keys.forEach((key) => {
          const delReq = store.delete(key);
          delReq.onsuccess = () => {
            completed++;
            if (completed === keys.length) resolve();
          };
          delReq.onerror = () => reject(delReq.error);
        });
      };

      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Error eliminando vídeos del proyecto en IndexedDB:', err);
    throw err;
  }
}

/**
 * Retorna un mapa resumen de vídeos guardados por partido { [projectId]: { count: number, videoNames: string[] } }
 */
export async function getProjectsVideoSummary(): Promise<Record<string, { count: number; videoNames: string[] }>> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_VIDEOS, 'readonly');
      const store = tx.objectStore(STORE_VIDEOS);
      const request = store.getAll();

      request.onsuccess = () => {
        const records: StoredVideoRecord[] = request.result || [];
        const summary: Record<string, { count: number; videoNames: string[] }> = {};
        for (const rec of records) {
          if (!summary[rec.projectId]) {
            summary[rec.projectId] = { count: 0, videoNames: [] };
          }
          summary[rec.projectId].count++;
          summary[rec.projectId].videoNames.push(rec.name);
        }
        resolve(summary);
      };

      request.onerror = () => reject(request.error);
    });
  } catch {
    return {};
  }
}

/**
 * Libera de memoria los Blob URLs cuando se cambia de vídeo o partido
 */
export function revokeProjectBlobUrls(videos: VideoFileItem[]): void {
  for (const v of videos) {
    if (v.url && v.url.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(v.url);
      } catch {
        // Ignorar si ya fue revocada
      }
    }
  }
}
