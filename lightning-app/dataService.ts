// --- Configuration ---
export const REGION = {
  west: -10.0,
  north: 65.0,
  east: 33.0,
  south: 33.0,
};

// Lightning Server V2 - Cloud Run deployment
// Use localhost:3001 for local development
const USE_LOCAL = false; // Set to true for local development
export const SERVER_URL = USE_LOCAL 
  ? "http://127.0.0.1:3001" 
  : "https://lightning-server-v2-935480850831.europe-west3.run.app";

// Bands available in the new backend
export const BANDS = [
  { id: 'lightning', label: 'Lightning' },
  // { id: 'sat_ch0', label: 'VIS (Ch0)' },
  // { id: 'sat_ch1', label: 'IR (Ch1)' },
];

// Keep CHANNELS as alias for backward compatibility
export const CHANNELS = BANDS;

export interface Timestep {
  timestamp: string;      // YYYYMMDDHHMM format
  datetime: string;       // ISO format
  dateFolder: string;     // YYYY-MM-DD format
  label: string;          // Display label (HH:MM)
  fullDate: Date;         // Date object
  availableBands?: string[]; // Which bands are available
}

// Parse timestamp to Date object
const parseTimestamp = (timestamp: string): Date => {
  const year = timestamp.substring(0, 4);
  const month = timestamp.substring(4, 6);
  const day = timestamp.substring(6, 8);
  const hour = timestamp.substring(8, 10);
  const minute = timestamp.substring(10, 12);
  return new Date(`${year}-${month}-${day}T${hour}:${minute}:00Z`);
};

// Format timestamp for display
const formatLabel = (timestamp: string): string => {
  const hour = timestamp.substring(8, 10);
  const minute = timestamp.substring(10, 12);
  return `${hour}:${minute}`;
};

// Get date folder from timestamp
const getDateFolder = (timestamp: string): string => {
  return `${timestamp.substring(0, 4)}-${timestamp.substring(4, 6)}-${timestamp.substring(6, 8)}`;
};

// Fetch available timesteps from the new backend
export const scanAvailableTimesteps = async (maxTimesteps: number = 18): Promise<Timestep[]> => {
  try {
    // Use the /available endpoint from the new backend
    const response = await fetch(`${SERVER_URL}/available?days=2`);
    
    if (!response.ok) {
      console.error('Failed to fetch available timesteps from server');
      return [];
    }
    
    const data = await response.json();
    
    if (!data.timestamps || data.timestamps.length === 0) {
      console.log('No timestamps available from server');
      return [];
    }
    
    // Convert to our Timestep format
    const timesteps: Timestep[] = data.timestamps.map((ts: any) => ({
      timestamp: ts.timestamp,
      datetime: ts.datetime,
      dateFolder: ts.date_folder || getDateFolder(ts.timestamp),
      label: formatLabel(ts.timestamp),
      fullDate: parseTimestamp(ts.timestamp),
      availableBands: ts.available_bands || [],
    }));
    
    // Sort by date and take the last maxTimesteps
    return timesteps
      .sort((a, b) => a.fullDate.getTime() - b.fullDate.getTime())
      .slice(-maxTimesteps);
    
  } catch (error) {
    console.error('Error fetching available timesteps:', error);
    return [];
  }
};

// Generate tile URL for the new backend
export const getTileUrl = (timestamp: string, band: string): string => {
  return `${SERVER_URL}/tiles/{z}/{x}/{y}.png?band=${band}&time=${timestamp}`;
};

// Generate WebP tile URL (optimized)
export const getTileUrlWebP = (timestamp: string, band: string): string => {
  return `${SERVER_URL}/tiles/{z}/{x}/{y}.webp?band=${band}&time=${timestamp}`;
};

// Generate animated WebP URL for the viewport
export const getAnimationUrl = (
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  zoom: number,
  band: string,
  startTime: string,
  endTime: string,
  stepMinutes: number = 10
): string => {
  return `${SERVER_URL}/animation.webp?min_x=${minX}&max_x=${maxX}&min_y=${minY}&max_y=${maxY}&zoom=${zoom}&band=${band}&start_time=${startTime}&end_time=${endTime}&step_minutes=${stepMinutes}`;
};

// Fetch bounds for a specific band and time
export const fetchBounds = async (timestamp: string, band: string): Promise<[number, number, number, number] | null> => {
  try {
    const response = await fetch(`${SERVER_URL}/bounds?band=${band}&time=${timestamp}`);
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json();
    return data.bounds as [number, number, number, number]; // [west, south, east, north]
  } catch (error) {
    console.error('Error fetching bounds:', error);
    return null;
  }
};

// Fetch TileJSON for map integration
export const fetchTileJSON = async (timestamp: string, band: string): Promise<any | null> => {
  try {
    const response = await fetch(`${SERVER_URL}/tilejson?band=${band}&time=${timestamp}`);
    
    if (!response.ok) {
      return null;
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error fetching TileJSON:', error);
    return null;
  }
};

// Point forecast - the new backend needs this endpoint added
// For now, we'll need to either add this endpoint or use a workaround
export const fetchPointForecast = async (
  lat: number, 
  lon: number, 
  band: string
): Promise<any | null> => {
  try {
    // The new backend may not have this endpoint yet
    // We'll try to call it, and if it fails, we'll handle gracefully
    const response = await fetch(
      `${SERVER_URL}/point?lat=${lat}&lon=${lon}&band=${band}`
    );
    
    if (!response.ok) {
      console.warn('Point forecast endpoint not available');
      return null;
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error fetching point forecast:', error);
    return null;
  }
};

// Legacy exports for backward compatibility
export const BASE_BUCKET_URL = "https://storage.googleapis.com/inference_result/forecasts";