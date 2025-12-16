# Project Status: Lightning Weather App

## Summary of Accomplishments (as of Dec 16, 2025)

1.  **Debugged Georeferencing**: We identified that the source TIF lightning data was appearing ~1000km North of reality and suffering from projection distortion (linear stretching vs. Mercator map).
2.  **Implemented Server-Side Processing**: Instead of parsing TIFs in the browser (which caused the errors), we switched to pre-processing the data using `gdal`.
    *   **Reprojection**: We used `gdalwarp` to force the data into **Web Mercator (EPSG:3857)**, resolving the "Africa vs. Europe" distortion.
    *   **Conversion**: We converted the TIFs to transparent **PNGs** with a Yellow-to-Red color map.
    *   **Batch Processing**: We ran a script to convert all 22 timestamped TIF files to this corrected PNG format.
3.  **Refactored Application**:
    *   Rewrote `App.tsx` to remove the complex `geotiff.js` logic.
    *   The app now simply overlays the pre-processed PNG images onto the MapLibre map.
    *   Hardcoded the specific bounds derived from the reprojected files.
    *   Added a scrollable timeline to switch between time steps manually.

## Usage for Next Session

**Context: Lightning Weather App Development**

**Current Status:**
We have a React Native (Expo) web app displaying lightning density data on a MapLibre map. We successfully fixed a major georeferencing and projection issue where the data was shifted north and distorted.

**The Solution Implemented:**
1.  **Data Pre-processing**: We are NO LONGER using client-side `geotiff.js`. Instead, we process source TIFs on the server/backend using:
    *   `gdalwarp -t_srs EPSG:3857` (Reprojects to Web Mercator).
    *   `gdaldem color-relief` (Applies a yellow-to-red color map).
    *   `gdal_translate -of PNG` (Converts to transparent PNG).
2.  **All 22 sample files** in `./lightning-app/public/data_tmp/` have been converted to these corrected PNGs.
3.  **App Logic**: `App.tsx` loads these transparency-preserved PNGs directly as MapLibre `image` sources.

**Technical Constraints & Configuration:**
*   **Active File**: `/lightning-app/App.tsx`
*   **Data Path**: `/lightning-app/public/data_tmp/`
*   **Map Bounds (EPSG:3857 derived)**: 
    *   West: `-81.2778265`
    *   North: `77.3564187`
    *   East: `81.2904694`
    *   South: `-77.3690833`
*   **Color Scale**: Yellow (low intensity) -> Red (high intensity).

**What Works:**
*   The map correctly layers the lightning data over the basemap.
*   Alignment is visually verified as correct (Europe and Africa matching known storm locations).
*   Timeline buttons allows manual switching between images.

**Immediate Next Steps / To-Do:**
1.  **Automation**: The data pipeline is currently manual. We need a way to automate the `gdal` conversion for new incoming files.
2.  **Animation**: Implement an "Auto-Play" feature to loop through the lightning history automatically.
3.  **UI Polish**: Add a legend for the color scale and improve the timeline UI.
