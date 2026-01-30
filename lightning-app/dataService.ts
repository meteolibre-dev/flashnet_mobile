import * as FileSystem from 'expo-file-system/legacy';

// --- Configuration ---
export const REGION = {
  west: -10.0,
  north: 65.0,
  east: 33.0,
  south: 33.0,
};

export const BASE_BUCKET_URL = "https://storage.googleapis.com/inference_result/forecasts";

export const SERVER_URL = "https://lightning-server-935480850831.europe-west3.run.app";

export const CHANNELS = [
  { id: 'lightning', label: 'Lightning' },
  { id: 'sat_ch0', label: 'VIS (Ch0)' },
  { id: 'sat_ch1', label: 'IR (Ch1)' },
];

export interface Timestep {
  dateFolder: string;
  filenameTime: string;
  label: string;
  fullDate: Date;
}

export interface PrefetchedData {
  url: string;
  coordinates: any;
  localUri?: string;
}

// Helper to parse timesteps
const parseTimestep = (item: any, dateFolder: string): Timestep | null => {
  const match = item.name.match(/forecast_(\d{12})_lightning\.tiff$/);
  if (match) {
    const filenameTime = match[1];
    const year = filenameTime.substring(0, 4);
    const month = filenameTime.substring(4, 6);
    const day = filenameTime.substring(6, 8);
    const hour = filenameTime.substring(8, 10);
    const minute = filenameTime.substring(10, 12);

    const fullDate = new Date(`${year}-${month}-${day}T${hour}:${minute}:00Z`);

    return {
      dateFolder,
      filenameTime,
      label: `${hour}h${minute}`,
      fullDate
    };
  }
  return null;
};

export const scanAvailableTimesteps = async (maxTimesteps: number = 18): Promise<Timestep[]> => {
  const availableTimesteps: Timestep[] = [];
  const now = new Date();

  const datesToCheck = [];
  for (let i = 0; i < 2; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    datesToCheck.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
  }

  for (const dateFolder of datesToCheck) {
    const listUrl = `https://storage.googleapis.com/storage/v1/b/inference_result/o?prefix=forecasts/${dateFolder}/`;
    try {
      const response = await fetch(listUrl);
      if (response.ok) {
        const data = await response.json();
        if (data.items) {
          for (const item of data.items) {
            const parsed = parseTimestep(item, dateFolder);
            if (parsed && !availableTimesteps.find(s => s.filenameTime === parsed.filenameTime)) {
              availableTimesteps.push(parsed);
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error listing files for ${dateFolder}:`, error);
    }
  }

  return availableTimesteps.sort((a, b) => a.fullDate.getTime() - b.fullDate.getTime()).slice(-maxTimesteps);
};

export const fetchMetadata = async (tiffUrl: string) => {
  const metaUrl = `${SERVER_URL}/metadata?url=${encodeURIComponent(tiffUrl)}`;
  try {
    const metaRes = await fetch(metaUrl);
    if (metaRes.ok) {
      return await metaRes.json();
    }
  } catch (e) {
    console.warn('Metadata fetch failed', e);
  }
  return null;
};

export const ensureDirectoryExists = async () => {
  const cacheDir = `${FileSystem.cacheDirectory}forecasts/`;
  try {
    const dirInfo = await FileSystem.getInfoAsync(cacheDir);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(cacheDir, { intermediates: true });
    }
  } catch (e) {
    console.warn('Failed to ensure directory exists', e);
  }
};

export const downloadImage = async (imageUrl: string, localPath: string) => {
  try {
    await ensureDirectoryExists();
    const fileInfo = await FileSystem.getInfoAsync(localPath);
    if (!fileInfo.exists) {
      const result = await FileSystem.downloadAsync(imageUrl, localPath);
      if (result.status !== 200) {
        console.warn(`Download failed for ${localPath}: Status ${result.status}`);
        await FileSystem.deleteAsync(localPath, { idempotent: true });
        return null;
      }
    }

    // Verify file size
    const verifiedInfo = await FileSystem.getInfoAsync(localPath);
    if (verifiedInfo.exists && verifiedInfo.size < 100) {
      console.warn(`File too small for ${localPath}: ${verifiedInfo.size} bytes`);
      await FileSystem.deleteAsync(localPath, { idempotent: true });
      return null;
    }

    return localPath;
  } catch (e) {
    console.warn('Download failed', e);
    return null;
  }
};

export const downloadAllFrames = async (
  steps: Timestep[],
  channelId: string,
  existingData: Record<string, PrefetchedData>,
  onProgress: (progress: number) => void,
  isCancelled: () => boolean,
  isWeb: boolean
) => {
  // Ensure cache directory exists for native
  if (!isWeb) {
    await ensureDirectoryExists();
  }

  const total = steps.length;
  let loadedCount = 0;

  // Parallel limit
  const LIMIT = 4;
  const queue = [...steps];

  const worker = async () => {
    while (queue.length > 0 && !isCancelled()) {
      const step = queue.shift();
      if (!step) return;

      const cacheKey = `${step.filenameTime}_${channelId}`;
      const existing = existingData[cacheKey];

      // Check cache first
      if (existing?.localUri && !isWeb) {
        const fileInfo = await FileSystem.getInfoAsync(existing.localUri);
        if (fileInfo.exists) {
           loadedCount++;
           onProgress(loadedCount / total);
           return;
        }
      }

      const tiffUrl = `${BASE_BUCKET_URL}/${step.dateFolder}/forecast_${step.filenameTime}_${channelId}.tiff`;
      const imageUrl = `${SERVER_URL}/image?url=${encodeURIComponent(tiffUrl)}&channel=${channelId}`;

      // 1. Metadata
      let coordinates = existing?.coordinates;
      if (!coordinates) {
        const meta = await fetchMetadata(tiffUrl);
        if (meta) coordinates = meta.coordinates;
      }

      // 2. Image
      let finalUri = existing?.localUri;
      if (!finalUri || isWeb) {
        if (isWeb) {
           // For web, we just fetch the URL and preload into browser cache
           await new Promise<void>((resolve) => {
             const img = new (typeof window !== 'undefined' ? window.Image : (global as any).Image)();
             img.onload = () => resolve();
             img.onerror = () => resolve(); // Resolve anyway to keep going
             img.src = imageUrl;
           });
           finalUri = imageUrl;
        } else {
           const localPath = `${FileSystem.cacheDirectory}forecasts/${step.filenameTime}_${channelId}.png`;
           const downloaded = await downloadImage(imageUrl, localPath);
           if (downloaded) finalUri = downloaded;
        }
      }

      if (coordinates && finalUri) {
        // Update store (passed by reference or handled via callback?)
        // Since we can't update React state from here easily without a callback,
        // we might just return the updated data map.
        // But for the progress callback, we need to report.

        // NOTE: We are mutating the passed 'existingData' object which is a Ref in the caller.
        existingData[cacheKey] = {
            url: imageUrl,
            coordinates,
            localUri: finalUri
        };
      }

      loadedCount++;
      onProgress(loadedCount / total);
    }
  };

  const workers = Array(Math.min(LIMIT, total)).fill(null).map(() => worker());
  await Promise.all(workers);

  return existingData;
};