const routeStorageKey = "route-rehearsal:latest-route";
const googleMapsApiKeyStorageKey = "route-rehearsal:google-maps-api-key";

const tilesApiKeyInput = document.querySelector("#tiles-api-key");
const saveTilesKeyButton = document.querySelector("#save-tiles-key");
const tilesKeyStatus = document.querySelector("#tiles-key-status");
const routeStatus = document.querySelector("#three-drive-route-status");
const loadSceneButton = document.querySelector("#three-drive-load-scene");
const playButton = document.querySelector("#three-drive-play");
const pauseButton = document.querySelector("#three-drive-pause");
const resetButton = document.querySelector("#three-drive-reset");
const progressBar = document.querySelector("#three-drive-progress-bar");
const playbackStatus = document.querySelector("#three-drive-playback-status");
const viewElement = document.querySelector("#three-drive-view");

let viewer = null;
let tileset = null;
let routeEntity = null;
let routePayload = null;
let playbackPoints = [];
let playbackProgress = 0;
let playbackTimer = null;
let playbackActive = false;

restoreApiKey();
loadSavedRoute();
updatePlaybackUi();
checkCesiumAvailability();

saveTilesKeyButton.addEventListener("click", () => {
  const apiKey = tilesApiKeyInput.value.trim();

  if (!apiKey) {
    clearApiKey();
    updateKeyStatus();
    return;
  }

  saveApiKey(apiKey);
  updateKeyStatus();
});

loadSceneButton.addEventListener("click", async () => {
  await loadScene();
});

playButton.addEventListener("click", () => {
  startPlayback();
});

pauseButton.addEventListener("click", () => {
  pausePlayback();
});

resetButton.addEventListener("click", () => {
  resetPlayback();
});

function restoreApiKey() {
  const apiKey = loadApiKey();

  if (apiKey) {
    tilesApiKeyInput.value = apiKey;
  }

  updateKeyStatus();
}

function updateKeyStatus() {
  const apiKey = loadApiKey();

  tilesKeyStatus.textContent = apiKey
    ? `Map Tiles key saved in this browser (ends in ${apiKey.slice(-4)}).`
    : "Paste a Google Maps key with Map Tiles API enabled.";
}

function loadSavedRoute() {
  try {
    const savedRoute = window.localStorage.getItem(routeStorageKey);

    if (!savedRoute) {
      routePayload = null;
      routeStatus.textContent =
        "Return to the main app, build a route, then come back here.";
      return;
    }

    routePayload = JSON.parse(savedRoute);
    playbackPoints = routePayload.route?.geometry?.coordinates ?? [];
    routeStatus.textContent = `Loaded route from ${shortPlaceName(routePayload.startPlace.name)} to ${shortPlaceName(routePayload.destinationPlace.name)}.`;
    playbackStatus.textContent =
      "Load the 3D scene, then play the camera ride.";
  } catch (error) {
    routePayload = null;
    routeStatus.textContent =
      "The saved route could not be read yet. Build a new route first.";
  }
}

async function loadScene() {
  if (typeof window.Cesium === "undefined") {
    playbackStatus.textContent =
      "The 3D engine did not load. Refresh the page and try again.";
    return;
  }

  const apiKey = loadApiKey();

  if (!apiKey) {
    playbackStatus.textContent =
      "Add a Google Maps key with Map Tiles API enabled first.";
    return;
  }

  if (!routePayload?.route?.geometry?.coordinates?.length) {
    playbackStatus.textContent =
      "No route is available yet. Build one in the main app first.";
    return;
  }

  try {
    if (!viewer) {
      Cesium.Ion.defaultAccessToken = "";
      Cesium.RequestScheduler.requestsByServer["tile.googleapis.com:443"] = 18;

      viewer = new Cesium.Viewer("three-drive-view", {
        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: false,
        sceneModePicker: false,
        navigationHelpButton: false,
        selectionIndicator: false,
        requestRenderMode: true,
        imageryProvider: false,
      });

      viewer.scene.globe.show = false;
      viewer.scene.requestRender();
    }

    if (!tileset) {
      tileset = viewer.scene.primitives.add(
        new Cesium.Cesium3DTileset({
          url: `https://tile.googleapis.com/v1/3dtiles/root.json?key=${encodeURIComponent(apiKey)}`,
          showCreditsOnScreen: true,
        }),
      );
      await tileset.readyPromise;
    }

    drawRouteLine();
    resetPlayback();
    playbackStatus.textContent =
      "3D scene loaded. Press play to ride the route.";
  } catch (error) {
    playbackStatus.textContent =
      "The 3D scene did not load. Check the Map Tiles API key, Map Tiles API access, and refresh once.";
  }
}

function drawRouteLine() {
  if (!viewer || !routePayload) {
    return;
  }

  if (routeEntity) {
    viewer.entities.remove(routeEntity);
  }

  const positions = routePayload.route.geometry.coordinates.map(([longitude, latitude]) =>
    Cesium.Cartesian3.fromDegrees(longitude, latitude, 30),
  );

  routeEntity = viewer.entities.add({
    polyline: {
      positions,
      width: 6,
      material: Cesium.Color.fromCssColorString("#c96f4a"),
    },
  });

  viewer.zoomTo(routeEntity);
}

function startPlayback() {
  if (!viewer || !playbackPoints.length) {
    return;
  }

  playbackActive = true;
  playbackStatus.textContent = "Playing smooth 3D route preview...";
  updatePlaybackUi();
  stepPlayback();
}

function pausePlayback() {
  playbackActive = false;

  if (playbackTimer) {
    window.clearTimeout(playbackTimer);
    playbackTimer = null;
  }

  updatePlaybackUi();
}

function resetPlayback() {
  pausePlayback();
  playbackProgress = 0;
  progressBar.style.width = "0%";

  if (playbackPoints.length) {
    flyCameraToProgress(0);
  }

  playbackStatus.textContent = viewer
    ? "3D scene loaded. Press play to ride the route."
    : "The 3D ride is waiting for a loaded scene and route.";
  updatePlaybackUi();
}

function stepPlayback() {
  if (!playbackActive || !playbackPoints.length) {
    return;
  }

  flyCameraToProgress(playbackProgress);
  progressBar.style.width = `${Math.round(playbackProgress * 100)}%`;
  playbackStatus.textContent = `Playing smooth 3D route preview... ${Math.round(
    playbackProgress * 100,
  )}%`;

  if (playbackProgress >= 1) {
    pausePlayback();
    playbackStatus.textContent = "3D ride complete. Reset to watch again.";
    return;
  }

  playbackProgress = Math.min(1, playbackProgress + 0.01);
  playbackTimer = window.setTimeout(stepPlayback, 90);
}

function flyCameraToProgress(progress) {
  if (!viewer || !playbackPoints.length) {
    return;
  }

  const currentCoordinate = interpolateRouteCoordinate(playbackPoints, progress);
  const nextCoordinate = interpolateRouteCoordinate(
    playbackPoints,
    Math.min(1, progress + 0.01),
  );
  const heading = calculateBearing(
    currentCoordinate[1],
    currentCoordinate[0],
    nextCoordinate[1],
    nextCoordinate[0],
  );

  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(
      currentCoordinate[0],
      currentCoordinate[1],
      55,
    ),
    orientation: {
      heading: Cesium.Math.toRadians(heading),
      pitch: Cesium.Math.toRadians(-8),
      roll: 0,
    },
  });
  viewer.scene.requestRender();
}

function interpolateRouteCoordinate(coordinates, progress) {
  if (coordinates.length === 1) {
    return coordinates[0];
  }

  const scaledIndex = (coordinates.length - 1) * progress;
  const lowerIndex = Math.floor(scaledIndex);
  const upperIndex = Math.min(coordinates.length - 1, lowerIndex + 1);
  const mix = scaledIndex - lowerIndex;
  const startCoordinate = coordinates[lowerIndex];
  const endCoordinate = coordinates[upperIndex];

  return [
    interpolateValue(startCoordinate[0], endCoordinate[0], mix),
    interpolateValue(startCoordinate[1], endCoordinate[1], mix),
  ];
}

function interpolateValue(start, end, amount) {
  return start + (end - start) * amount;
}

function calculateBearing(lat1, lon1, lat2, lon2) {
  const startLatitude = toRadians(lat1);
  const startLongitude = toRadians(lon1);
  const endLatitude = toRadians(lat2);
  const endLongitude = toRadians(lon2);
  const longitudeDelta = endLongitude - startLongitude;
  const y = Math.sin(longitudeDelta) * Math.cos(endLatitude);
  const x =
    Math.cos(startLatitude) * Math.sin(endLatitude) -
    Math.sin(startLatitude) *
      Math.cos(endLatitude) *
      Math.cos(longitudeDelta);

  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function toDegrees(value) {
  return (value * 180) / Math.PI;
}

function updatePlaybackUi() {
  const hasScene = Boolean(viewer);
  const hasRoute = Boolean(routePayload?.route?.geometry?.coordinates?.length);

  playButton.disabled = !hasScene || !hasRoute || playbackActive;
  pauseButton.disabled = !playbackActive;
  resetButton.disabled = !hasScene || !hasRoute;
}

function checkCesiumAvailability() {
  if (typeof window.Cesium !== "undefined") {
    return;
  }

  playbackStatus.textContent =
    "The 3D engine did not load yet. Refresh the page before trying the 3D ride.";
  loadSceneButton.disabled = true;
}

function shortPlaceName(placeName) {
  return placeName.split(",")[0];
}

function saveApiKey(apiKey) {
  window.localStorage.setItem(googleMapsApiKeyStorageKey, apiKey);
}

function loadApiKey() {
  return window.localStorage.getItem(googleMapsApiKeyStorageKey) || "";
}

function clearApiKey() {
  window.localStorage.removeItem(googleMapsApiKeyStorageKey);
}
