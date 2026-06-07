const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SAMSARA_BASE_URL = "https://api.samsara.com";

const SAMSARA_TOKENS = (process.env.SAMSARA_TOKEN || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

function ensureTokens() {
  if (!SAMSARA_TOKENS.length) {
    throw new Error("Missing SAMSARA_TOKEN in .env / Vercel environment variables");
  }
}

async function fetchJsonWithToken(pathOrUrl, token) {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${SAMSARA_BASE_URL}${pathOrUrl}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const text = await response.text();
  let data = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }

  if (!response.ok) {
    throw new Error(`Samsara error ${response.status}: ${text}`);
  }

  return data;
}

async function callSamsara(path) {
  ensureTokens();

  const mergedData = [];
  const errors = [];
  let sampleMeta = null;

  for (const token of SAMSARA_TOKENS) {
    try {
      const data = await fetchJsonWithToken(path, token);
      if (!sampleMeta) sampleMeta = data;

      if (Array.isArray(data.data)) {
        mergedData.push(...data.data);
      } else if (data.data !== undefined && data.data !== null) {
        mergedData.push(data.data);
      }
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (!mergedData.length && errors.length === SAMSARA_TOKENS.length) {
    throw new Error(errors.join(" | "));
  }

  return {
    ...(sampleMeta || {}),
    data: mergedData,
  };
}

async function callSamsaraPaginated(path) {
  ensureTokens();

  const allData = [];
  const errors = [];

  for (const token of SAMSARA_TOKENS) {
    let nextPath = path;

    while (nextPath) {
      try {
        const data = await fetchJsonWithToken(nextPath, token);
        allData.push(...(data.data || []));

        const hasNextPage = data.pagination?.hasNextPage;
        const endCursor = data.pagination?.endCursor;

        if (!hasNextPage || !endCursor) {
          nextPath = null;
        } else {
          const separator = path.includes("?") ? "&" : "?";
          nextPath = `${path}${separator}after=${encodeURIComponent(endCursor)}`;
        }
      } catch (error) {
        errors.push(error.message);
        nextPath = null;
      }
    }
  }

  if (!allData.length && errors.length) {
    throw new Error(errors.join(" | "));
  }

  return allData;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function latestByTime(items) {
  if (!Array.isArray(items) || items.length === 0) return null;

  return (
    items
      .filter(Boolean)
      .sort((a, b) => {
        const at = new Date(a.time || a.updatedAt || 0).getTime();
        const bt = new Date(b.time || b.updatedAt || 0).getTime();
        return bt - at;
      })[0] || null
  );
}

function latestStat(vehicle, key) {
  const value = vehicle[key];
  if (Array.isArray(value)) return latestByTime(value);
  return value || null;
}

function extractFuelPercent(raw) {
  if (!raw) return null;

  if (Array.isArray(raw)) {
    const latest = latestByTime(raw);
    return extractFuelPercent(latest);
  }

  return (
    numberOrNull(raw.percent) ??
    numberOrNull(raw.value) ??
    numberOrNull(raw.fuelPercent) ??
    numberOrNull(raw.fuelPercentRemaining) ??
    numberOrNull(raw.engineFuelLevelPercent) ??
    null
  );
}

function extractFuelTime(raw) {
  if (!raw) return null;

  if (Array.isArray(raw)) {
    const latest = latestByTime(raw);
    return extractFuelTime(latest);
  }

  return raw.time || raw.updatedAt || null;
}

function isoHoursAgo(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function isoNow() {
  return new Date().toISOString();
}

async function getFuelHistoryMap(hoursBack = 168) {
  const startTime = isoHoursAgo(hoursBack);
  const endTime = isoNow();

  const params = new URLSearchParams({
    types: "fuelPercents",
    startTime,
    endTime,
  });

  const rows = await callSamsaraPaginated(
    `/fleet/vehicles/stats/history?${params.toString()}`
  );

  const fuelMap = new Map();

  for (const vehicle of rows) {
    const rawFuel = vehicle.fuelPercents ?? null;
    const fuelPercent = extractFuelPercent(rawFuel);
    const fuelTime = extractFuelTime(rawFuel);

    if (fuelPercent !== null) {
      fuelMap.set(String(vehicle.id), {
        fuelPercent,
        fuelTime,
        fuelRaw: rawFuel,
      });
    }
  }

  return fuelMap;
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    message: "Local Samsara backend is running",
    tokensLoaded: SAMSARA_TOKENS.length,
  });
});

app.get("/api/samsara/vehicles", async (req, res) => {
  try {
    const snapshotData = await callSamsara(
      "/fleet/vehicles/stats?types=gps,fuelPercents,obdOdometerMeters"
    );

    let fuelHistoryMap = new Map();
    let fuelHistoryError = null;

    try {
      fuelHistoryMap = await getFuelHistoryMap(168);
    } catch (historyError) {
      fuelHistoryError = historyError.message;
    }

    const vehicles = (snapshotData.data || []).map((vehicle) => {
      const gps = latestStat(vehicle, "gps");
      const snapshotFuel = latestStat(vehicle, "fuelPercents");
      const odometer = latestStat(vehicle, "obdOdometerMeters");

      const snapshotFuelPercent = extractFuelPercent(snapshotFuel);
      const snapshotFuelTime = extractFuelTime(snapshotFuel);

      const historyFuel = fuelHistoryMap.get(String(vehicle.id)) || null;

      const finalFuelPercent =
        snapshotFuelPercent !== null
          ? snapshotFuelPercent
          : historyFuel?.fuelPercent ?? null;

      const finalFuelTime = snapshotFuelTime || historyFuel?.fuelTime || null;

      const fuelSource =
        snapshotFuelPercent !== null
          ? "snapshot"
          : historyFuel?.fuelPercent !== undefined
          ? "history"
          : null;

      const odometerMeters =
        numberOrNull(odometer?.meters) ??
        numberOrNull(odometer?.value) ??
        null;

      return {
        id: vehicle.id,
        name: vehicle.name,
        latitude:
          numberOrNull(gps?.latitude) ??
          numberOrNull(gps?.value?.latitude) ??
          null,
        longitude:
          numberOrNull(gps?.longitude) ??
          numberOrNull(gps?.value?.longitude) ??
          null,
        speedMph:
          numberOrNull(gps?.speedMilesPerHour) ??
          numberOrNull(gps?.value?.speedMilesPerHour) ??
          null,
        address:
          gps?.reverseGeo?.formattedLocation ??
          gps?.value?.reverseGeo?.formattedLocation ??
          null,
        fuelPercent: finalFuelPercent,
        fuelTime: finalFuelTime,
        fuelSource,
        odometerMeters,
        odometerMiles:
          odometerMeters !== null ? odometerMeters / 1609.344 : null,
        gpsTime: gps?.time ?? null,
        odometerTime: odometer?.time ?? null,
      };
    });

    res.json({
      success: true,
      count: vehicles.length,
      fuelHistoryFallbackUsed: true,
      fuelHistoryError,
      vehicles,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/samsara/fuel-diagnostics", async (req, res) => {
  try {
    const snapshotData = await callSamsara(
      "/fleet/vehicles/stats?types=fuelPercents,fuelConsumedMilliliters,obdOdometerMeters"
    );

    let historyRows = [];
    let historyError = null;

    try {
      const params = new URLSearchParams({
        types: "fuelPercents",
        startTime: isoHoursAgo(168),
        endTime: isoNow(),
      });

      historyRows = await callSamsaraPaginated(
        `/fleet/vehicles/stats/history?${params.toString()}`
      );
    } catch (err) {
      historyError = err.message;
    }

    const historyMap = new Map();

    for (const vehicle of historyRows) {
      const fuelPercent = extractFuelPercent(vehicle.fuelPercents);
      const fuelTime = extractFuelTime(vehicle.fuelPercents);

      if (fuelPercent !== null) {
        historyMap.set(String(vehicle.id), {
          fuelPercent,
          fuelTime,
          raw: vehicle.fuelPercents,
        });
      }
    }

    const vehicles = (snapshotData.data || []).map((vehicle) => {
      const snapshotFuel = vehicle.fuelPercents ?? null;
      const historyFuel = historyMap.get(String(vehicle.id)) || null;

      return {
        id: vehicle.id,
        name: vehicle.name,
        snapshotFuelRaw: snapshotFuel,
        snapshotFuelPercent: extractFuelPercent(snapshotFuel),
        snapshotFuelTime: extractFuelTime(snapshotFuel),
        historyFuelPercent: historyFuel?.fuelPercent ?? null,
        historyFuelTime: historyFuel?.fuelTime ?? null,
        historyFuelRaw: historyFuel?.raw ?? null,
        fuelConsumedMillilitersRaw:
          vehicle.fuelConsumedMilliliters ?? null,
        odometerRaw: vehicle.obdOdometerMeters ?? null,
      };
    });

    res.json({
      success: true,
      count: vehicles.length,
      note: "Checks snapshot fuel first, then fuelPercents from Vehicle Stats History for last 7 days.",
      historyRowsFound: historyRows.length,
      historyError,
      vehicles,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/api/samsara/fuel-history", async (req, res) => {
  try {
    const hours = Number(req.query.hours || 168);
    const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 168;

    const params = new URLSearchParams({
      types: "fuelPercents",
      startTime: isoHoursAgo(safeHours),
      endTime: isoNow(),
    });

    const rows = await callSamsaraPaginated(
      `/fleet/vehicles/stats/history?${params.toString()}`
    );

    const vehicles = rows.map((vehicle) => ({
      id: vehicle.id,
      name: vehicle.name,
      fuelPercent: extractFuelPercent(vehicle.fuelPercents),
      fuelTime: extractFuelTime(vehicle.fuelPercents),
      fuelPercentsRaw: vehicle.fuelPercents ?? null,
    }));

    res.json({
      success: true,
      count: vehicles.length,
      hoursBack: safeHours,
      vehicles,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running at http://127.0.0.1:${PORT}`);
});
