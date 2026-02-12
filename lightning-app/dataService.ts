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

// Helper to parse timesteps - matches any channel (lightning, sat_ch0, sat_ch1, etc.)
const parseTimestep = (item: any, dateFolder: string): Timestep | null => {
  const match = item.name.match(/forecast_(\d{12})_[\w-]+\.tiff$/);
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